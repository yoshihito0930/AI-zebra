// 料金表を受け取って料金を計算する・プランを決める（docs/product-specs/booking.md「料金」）。
// 中身は実装担当が書く（docs/TESTING.md の手順4）。
import type { PriceTable, Yen } from "@zebra/contracts";
import type { DateTime } from "luxon";

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

/** 料金表を受け取って、予約の料金（税抜の合計と税込の見積額）を計算する */
export function calculatePriceFromTable(
  table: PriceTable,
  input: PriceTableQuoteInput,
): PriceTableQuote {
  void table;
  void input;
  throw new Error("未実装");
}

/** 料金表を受け取って、人数とホリゾントの床面の全面養生の有無から、プランの id を決める */
export function decidePlanId(table: PriceTable, input: PlanDecisionInput): string {
  void table;
  void input;
  throw new Error("未実装");
}
