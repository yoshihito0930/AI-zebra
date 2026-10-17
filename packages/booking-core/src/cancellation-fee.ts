// 取消のキャンセル料（docs/product-specs/booking.md「取消とキャンセル料」）。
// スタブ：形（名前・引数・戻り値の型）だけを決めている。中身は実装のPRで書く（docs/TESTING.md）。
import type { ReservationStatus, Yen } from "@zebra/contracts";
import type { DateTime } from "luxon";

/** 取消せる予約の状態。取消・終了の予約は、さらに取消さない */
export type CancellableStatus = Exclude<ReservationStatus, "cancelled" | "ended">;

/** キャンセル料の率。整数のパーセント（INV-9。浮動小数にしない）。0 は「なし」 */
export type CancellationFeeRatePercent = 0 | 50 | 80 | 100;

export interface CancellationFeeInput {
  /** 取消す時点の予約の状態。キャンセル料がかかるのは本予約（firm）だけ */
  readonly status: CancellableStatus;
  /** 予約の金額（税込の合計。管理者が調整した場合は調整後） */
  readonly amount: Yen;
  /** 予約区間の開始日時。利用日は、この日時の JST での日付（INV-7） */
  readonly start: DateTime;
  /** 管理者が取消を操作した日時。率は、この日時の JST での日付が利用日の何日前かで決まる（INV-7） */
  readonly cancelledAt: DateTime;
}

export interface CancellationFee {
  /** キャンセル料の率（整数のパーセント） */
  readonly ratePercent: CancellationFeeRatePercent;
  /** キャンセル料 ＝ 金額 × 率。1円未満は切り捨て（INV-9） */
  readonly fee: Yen;
}

export function calculateCancellationFee(input: CancellationFeeInput): CancellationFee {
  void input;
  throw new Error("未実装");
}
