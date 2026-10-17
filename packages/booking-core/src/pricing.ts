// 料金の計算（booking.md「料金」）。INV-9（金額は整数の円）、INV-7（深夜帯の判定は JST）
// 料金表を受け取る calculatePriceFromTable（price-table-pricing.ts）に置き換える予定。
// この関数とテスト（pricing.test.ts）は、あとで別の PR で消す。それまでは、計算を2か所に持たないよう、
// 今の料金表（currentPriceTable）で calculatePriceFromTable を呼ぶだけにする
import type { Yen } from "@zebra/contracts";
import type { DateTime } from "luxon";
import { currentPriceTable } from "./current-price-table";
import { calculatePriceFromTable } from "./price-table-pricing";

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
 * 料金を決められないので、RangeError を投げる（calculatePriceFromTable が投げる）。
 * 料金表を受け取る calculatePriceFromTable に置き換える予定
 */
export function calculatePrice(input: PriceInput): PriceQuote {
  const optionIds: string[] = [];
  if (input.options.workshop) {
    optionIds.push("workshop");
  }
  if (input.options.glitter) {
    optionIds.push("glitter");
  }
  return calculatePriceFromTable(currentPriceTable(), {
    planId: input.plan,
    start: input.start,
    end: input.end,
    equipmentInsurance: input.equipmentInsurance,
    optionIds,
  });
}
