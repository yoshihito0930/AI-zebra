// 料金の計算（booking.md「料金」）。INV-9（金額は整数の円）、INV-7（深夜帯の判定は JST）
import type { Yen } from "@zebra/contracts";
import type { DateTime } from "luxon";

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
 */
export function calculatePrice(input: PriceInput): PriceQuote {
  void input;
  throw new Error("未実装");
}
