// 料金表を受け取って料金を計算する・プランを決める（docs/product-specs/booking.md「料金」）。
// INV-9（金額は整数の円。端数の処理はこのファイルの addConsumptionTax だけ）、INV-7（深夜帯の判定は JST）
import { type PriceTable, Yen } from "@zebra/contracts";
import type { DateTime } from "luxon";
import { SLOT_MINUTES, isLateNight, isOn30MinuteBoundary } from "./jst-time";

/** 料金表の計算に渡す予約 */
export interface PriceTableQuoteInput {
  /** 料金表のプランの id */
  readonly planId: string;
  /** 予約区間の開始（どのゾーンで表した日時でもよい。判定は JST。INV-7） */
  readonly start: DateTime;
  /** 予約区間の終了（半開区間 [start, end) の end） */
  readonly end: DateTime;
  /** 機材保険を付けるか */
  readonly equipmentInsurance: boolean;
  /** 選んだオプション（料金表のオプションの id）。1予約につき1回 */
  readonly optionIds: readonly string[];
}

/** 料金の計算の結果（INV-9） */
export interface PriceTableQuote {
  /** 税抜の合計 */
  readonly subtotalExcludingTax: Yen;
  /** 税込の見積額（税抜の合計 × 1.1 の1円未満切り捨て） */
  readonly estimateIncludingTax: Yen;
}

/** プランを決めるための申込の内容 */
export interface PlanDecisionInput {
  /** ご利用人数 */
  readonly partySize: number;
  /** ホリゾントの床面を全面養生するか（申込フォームの「ホリゾントの養生」が「あり」） */
  readonly cycloramaFloorProtection: boolean;
}

/**
 * 料金表を受け取って、予約の料金（税抜の合計と税込の見積額）を計算する。
 * 予約区間が「時間の単位と利用時間」のルールを満たすかは確かめない（別の関数の役目）。
 * 次の入力は料金を決められないので、RangeError を投げる（仕様に定めがないため、黙って0円などにしない）。
 * - 30分ごとに区切れない区間（JST の :00・:30 ちょうどでない開始・終了、終了が開始以前、不正な日時）
 * - 料金表にないプランの id、料金表にないオプションの id
 * - 同じオプションの id が2回以上（オプションは1予約につき1回なので、呼び出し側の誤りとして扱う）
 */
export function calculatePriceFromTable(
  table: PriceTable,
  input: PriceTableQuoteInput,
): PriceTableQuote {
  const { start, end } = input;
  if (!start.isValid || !end.isValid) {
    throw new RangeError("予約区間の日時が不正");
  }
  if (!isOn30MinuteBoundary(start) || !isOn30MinuteBoundary(end)) {
    throw new RangeError("予約区間が30分単位でない");
  }
  if (end.toMillis() <= start.toMillis()) {
    throw new RangeError("予約区間の終了が開始以前");
  }

  const plan = table.plans.find((candidate) => candidate.id === input.planId);
  if (plan === undefined) {
    throw new RangeError(`料金表にないプラン：${input.planId}`);
  }

  // 予約区間を30分ごとに区切り、各30分の開始時刻が深夜帯（JST）かで単価を決める。
  // 深夜帯の境目（23:00・8:00）は30分の区切りに揃っているので、各30分は通常帯か深夜帯のどちらかに収まる
  let timeCharge = 0;
  for (
    let slotStart = start;
    slotStart.toMillis() < end.toMillis();
    slotStart = slotStart.plus({ minutes: SLOT_MINUTES })
  ) {
    timeCharge += isLateNight(slotStart) ? plan.halfHourRates.lateNight : plan.halfHourRates.normal;
  }

  let extras = input.equipmentInsurance ? table.equipmentInsurance : 0;
  const seenOptionIds = new Set<string>();
  for (const optionId of input.optionIds) {
    if (seenOptionIds.has(optionId)) {
      throw new RangeError(`同じオプションが2回以上：${optionId}`);
    }
    seenOptionIds.add(optionId);
    const option = table.options.find((candidate) => candidate.id === optionId);
    if (option === undefined) {
      throw new RangeError(`料金表にないオプション：${optionId}`);
    }
    extras += option.price;
  }

  const subtotal = timeCharge + extras;
  return {
    subtotalExcludingTax: Yen.parse(subtotal),
    estimateIncludingTax: Yen.parse(addConsumptionTax(subtotal)),
  };
}

/**
 * 料金表を受け取って、人数とホリゾントの床面の全面養生の有無から、プランの id を決める。
 * 規則を上から順に見て、書いてある条件をすべて満たす最初の規則のプランにする（contracts の PriceTable）。
 * 最後の規則は条件なし（PriceTable.parse が確かめる）なので、parse を通した料金表なら必ずどれかに決まる
 */
export function decidePlanId(table: PriceTable, input: PlanDecisionInput): string {
  const rule = table.planRules.find(
    (candidate) =>
      (candidate.maxPartySize === undefined || input.partySize <= candidate.maxPartySize) &&
      (candidate.cycloramaFloorProtection === undefined || input.cycloramaFloorProtection),
  );
  if (rule === undefined) {
    // PriceTable.parse を通していない料金表で、最後の規則に条件があるときだけ起きる
    throw new RangeError("料金表の規則のどれにも当てはまらない");
  }
  return rule.plan;
}

// 消費税率 10% を、浮動小数を使わずに整数の比（11/10）で表す（INV-9）
const TAX_INCLUDED_NUMERATOR = 11;
const TAX_INCLUDED_DENOMINATOR = 10;

/**
 * 税抜の合計（整数の円）に消費税10%をかけ、1円未満を切り捨てる。
 * 端数の処理はここだけで行う（INV-9）。整数のまま掛けてから、余りを引いて割り切れる形にする
 */
function addConsumptionTax(subtotalExcludingTax: number): number {
  const scaled = subtotalExcludingTax * TAX_INCLUDED_NUMERATOR;
  // eslint-disable-next-line no-restricted-syntax -- INV-9：消費税の1円未満の切り捨ては、ここだけで行う（割り切れる形にしてから割る）
  return (scaled - (scaled % TAX_INCLUDED_DENOMINATOR)) / TAX_INCLUDED_DENOMINATOR;
}
