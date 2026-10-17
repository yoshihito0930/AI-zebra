// 料金の計算（booking.md「料金」）。INV-9（金額は整数の円）、INV-7（深夜帯の判定は JST）
import { Yen } from "@zebra/contracts";
import type { DateTime } from "luxon";
import { SLOT_MINUTES, isLateNight, isOn30MinuteBoundary } from "./jst-time";

/** プラン。A は10人以下、B は11人以上。人数からプランを決めるのは別の関数（「申込フォーム」） */
export type Plan = "A" | "B";

/**
 * オプション（1予約につき1回。日付をまたいでも1回）。
 * - workshop：6人以上のワークショップでの利用
 * - glitter：ラメやグリッターを多用した衣装・小道具の持ち込み
 */
export interface PricingOptions {
  readonly workshop: boolean;
  readonly glitter: boolean;
}

export interface PriceInput {
  readonly plan: Plan;
  /** 予約区間の開始（どのゾーンの DateTime でもよい。深夜帯の判定は JST） */
  readonly start: DateTime;
  /** 予約区間の終了（半開区間 [start, end) の end） */
  readonly end: DateTime;
  /** 機材保険（1予約につき1回） */
  readonly equipmentInsurance: boolean;
  readonly options: PricingOptions;
}

export interface PriceQuote {
  /** 時間料金・機材保険・オプションの税抜の合計 */
  readonly subtotalExcludingTax: Yen;
  /** 税抜の合計に消費税10%をかけ、1円未満を切り捨てた見積額（税込） */
  readonly estimateIncludingTax: Yen;
}

/**
 * 予約区間とプラン・機材保険・オプションから、税抜の合計と税込の見積額を計算する。
 * 予約区間が「時間の単位と利用時間」のルールを満たすかは確かめない（別の関数の役目）。
 * ただし、30分ごとに区切れない区間（JST の :00・:30 ちょうどでない開始・終了、終了が開始以前、不正な日時）は
 * 料金を決められないので、RangeError を投げる。
 */
export function calculatePrice(input: PriceInput): PriceQuote {
  const { plan, start, end } = input;
  if (!start.isValid || !end.isValid) {
    throw new RangeError("予約区間の日時が不正");
  }
  if (!isOn30MinuteBoundary(start) || !isOn30MinuteBoundary(end)) {
    throw new RangeError("予約区間が30分単位でない");
  }
  if (end.toMillis() <= start.toMillis()) {
    throw new RangeError("予約区間の終了が開始以前");
  }

  // 予約区間を30分ごとに区切り、各30分の開始時刻が深夜帯（JST）かで単価を決める。
  // 深夜帯の境目（23:00・8:00）は30分の区切りに揃っているので、各30分は通常帯か深夜帯のどちらかに収まる
  const rate = HALF_HOUR_RATE[plan];
  let timeCharge = 0;
  for (
    let slotStart = start;
    slotStart.toMillis() < end.toMillis();
    slotStart = slotStart.plus({ minutes: SLOT_MINUTES })
  ) {
    timeCharge += isLateNight(slotStart) ? rate.lateNight : rate.normal;
  }

  const extras =
    (input.equipmentInsurance ? EQUIPMENT_INSURANCE : 0) +
    (input.options.workshop ? OPTION_CHARGE : 0) +
    (input.options.glitter ? OPTION_CHARGE : 0);

  const subtotal = timeCharge + extras;
  return {
    subtotalExcludingTax: Yen.parse(subtotal),
    estimateIncludingTax: Yen.parse(addConsumptionTax(subtotal)),
  };
}

// 30分あたりの単価（税抜、円）。booking.md「単価（税抜）」
const HALF_HOUR_RATE: Record<Plan, { readonly normal: number; readonly lateNight: number }> = {
  A: { normal: 2_500, lateNight: 3_750 },
  B: { normal: 2_750, lateNight: 4_125 },
};

// 機材保険（税抜、1予約につき1回）
const EQUIPMENT_INSURANCE = 1_000;
// オプション1つあたり（税抜、1予約につき1回）
const OPTION_CHARGE = 2_000;

// 消費税率 10% を、浮動小数を使わずに整数の比（11/10）で表す（INV-9）
const TAX_INCLUDED_NUMERATOR = 11;
const TAX_INCLUDED_DENOMINATOR = 10;

/**
 * 税抜の合計（整数の円）に消費税10%をかけ、1円未満を切り捨てる。
 * 端数の処理はここだけで行う（INV-9）。整数のまま掛けてから、余りを引いて割り切れる形にする
 */
function addConsumptionTax(subtotalExcludingTax: number): number {
  const scaled = subtotalExcludingTax * TAX_INCLUDED_NUMERATOR;
  return (scaled - (scaled % TAX_INCLUDED_DENOMINATOR)) / TAX_INCLUDED_DENOMINATOR;
}
