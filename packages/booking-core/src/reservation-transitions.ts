// 予約の状態の移り変わり（docs/design-docs/reservation-model.md「状態と操作」、
// docs/product-specs/booking.md「予約の状態」「仮予約から本予約へ」「第二キープ」「取消とキャンセル料」「確認メール」）。
// 入出力を持たない（INV-5）。現在時刻は引数で受け取る（INV-7）。
// 枠と予約の書き込み（INV-2）と、下書きの保存・送信（INV-6）は呼び出す側が行う。
import type { ReservationStatus, Yen } from "@zebra/contracts";
import type { DateTime } from "luxon";
import type { ExistingReservation, TimeRange } from "./availability";
import type { CancellationFeeRatePercent } from "./cancellation-fee";

/**
 * 予約。空き判定の ExistingReservation（id・status・start・end・bufferMinutes）に、次を足したもの
 * - provisionalIds：第二キープ（承認待ちの第二キープを含む）が付いている仮予約の id（1件以上）。
 *   ほかの状態の予約では空。繰り上げで第二キープが仮予約になったら、空になる
 * - confirmedAmount：確定金額（税込）。承認待ちのあいだは null（reservation-model.md「金額」）
 */
export interface Reservation extends ExistingReservation {
  readonly provisionalIds: readonly string[];
  readonly confirmedAmount: Yen | null;
}

/**
 * 管理者の操作
 * - promote：昇格（仮予約 → 本予約）。この仮予約に付いている第二キープ（承認待ちを含む）は、続けて終了になる
 * - cancel：取消。cancelledAt は管理者が取消を操作した日時（キャンセル料の日数に使う。JST で数える）
 * - move-up：繰り上げ（第二キープ → 仮予約。仮予約の id をすべて外す）
 */
export type ReservationOperation =
  | { readonly kind: "promote"; readonly reservationId: string }
  | { readonly kind: "cancel"; readonly reservationId: string; readonly cancelledAt: DateTime }
  | { readonly kind: "move-up"; readonly reservationId: string };

/**
 * 操作で作る、お客様あての下書き（管理者が確認してから送る。INV-6）。reservationId は、あて先のお客様の予約
 * - promotion：昇格の下書き
 * - cancellation：取消の下書き。キャンセル料を差し込む
 * - second-hold-ended：第二キープの終了の下書き
 * - move-up-notice：仮予約の取消で、付いている第二キープ（承認済み）に送る案内の下書き。
 *   remainingProvisionalIds は、ほかに付いていて、まだ仮予約のまま第二キープと重なっている仮予約の id
 *   （空でなければ、まだ繰り上げられないことも伝える）
 * - bring-forward-notice：前倒しの案内の下書き（第二キープの占有区間の終わりに接して始まる予約のお客様あて）
 */
export type ReservationDraft =
  | { readonly kind: "promotion"; readonly reservationId: string }
  | {
      readonly kind: "cancellation";
      readonly reservationId: string;
      readonly cancellationFee: {
        readonly ratePercent: CancellationFeeRatePercent;
        readonly fee: Yen;
      };
    }
  | { readonly kind: "second-hold-ended"; readonly reservationId: string }
  | {
      readonly kind: "move-up-notice";
      readonly reservationId: string;
      readonly remainingProvisionalIds: readonly string[];
    }
  | { readonly kind: "bring-forward-notice"; readonly reservationId: string };

/**
 * 操作できない理由
 * - not-found：reservationId の予約がない
 * - invalid-status：その状態の予約には、その操作をできない
 * - still-held：繰り上げようとした第二キープに、まだ仮予約のまま重なっている仮予約が付いている
 */
export type ReservationOperationRejection = "not-found" | "invalid-status" | "still-held";

/**
 * 操作の結果
 * - reservations：操作のあとのすべての予約。引数の reservations と同じ並び順・同じ件数
 * - released：操作で解放される占有区間。操作の前に枠を確保している予約（承認待ち・仮予約・本予約・第二キープ）の
 *   どれかの占有区間に入っていて、操作のあとにはどれにも入らない時間。開始の早い順に並べ、
 *   重なる区間・接する区間はつないで1つにする。DateTime のゾーンは決めない
 * - drafts：作る下書き。並び順は決めない
 */
export type ReservationOperationResult =
  | {
      readonly ok: true;
      readonly reservations: readonly Reservation[];
      readonly released: readonly TimeRange[];
      readonly drafts: readonly ReservationDraft[];
    }
  | { readonly ok: false; readonly reason: ReservationOperationRejection };

/** 予約に管理者の操作をしたあとの、予約の状態・解放される枠・作る下書きを返す */
export function applyReservationOperation(input: {
  readonly reservations: readonly Reservation[];
  readonly operation: ReservationOperation;
}): ReservationOperationResult {
  void input;
  throw new Error("未実装");
}

/**
 * 管理画面で「仮予約の期限を過ぎた」警告を出すか。
 * 仮予約と、承認待ちの仮予約申込（pending-provisional）のうち、now が仮予約の期限（start から求める）以降のものに出す。
 * 状態は変えない（booking.md「仮予約から本予約へ」）
 */
export function needsProvisionalDeadlineWarning(input: {
  readonly status: ReservationStatus;
  readonly start: DateTime;
  readonly now: DateTime;
}): boolean {
  void input;
  throw new Error("未実装");
}
