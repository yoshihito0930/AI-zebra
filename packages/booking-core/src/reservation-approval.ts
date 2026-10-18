// 予約の承認と却下（docs/product-specs/booking.md「予約の状態」、docs/design-docs/reservation-model.md「状態と操作」）。
// 入出力を持たない純粋な関数。現在時刻は使わない（INV-5、INV-7）。
// 枠と予約の書き込み（INV-2）と、下書きの保存・送信（INV-6）は呼び出す側が行う。
import type { ReservationStatus, Yen } from "@zebra/contracts";
import type { TimeRange } from "./availability";
import {
  type Reservation,
  type ReservationDraft,
  bringForwardNotices,
  holdingRanges,
  isSecondHoldStatus,
  subtractRanges,
} from "./reservation-transitions";

/** 承認の下書き。管理者が決めた確定金額（税込）を差し込む（booking.md「確認メール」） */
export interface ApprovalDraft {
  readonly kind: "approval";
  readonly reservationId: string;
  readonly confirmedAmount: Yen;
}

/** 却下の下書き */
export interface RejectionDraft {
  readonly kind: "rejection";
  readonly reservationId: string;
}

/**
 * 承認・却下が不可の理由
 * - not-pending：承認待ち（pending-provisional・pending-firm・pending-second-hold）でない。承認・却下できるのは承認待ちだけ
 * - not-found：reservations に reservationId の予約がない
 */
export type ApprovalFailureReason = "not-pending" | "not-found";

/**
 * 承認の結果。成功なら、操作のあとの予約すべて（並び順は引数の reservations のまま）と、下書き。
 * 承認は枠を変えない（解放・確保する枠はない）
 */
export type ApprovalResult =
  | {
      readonly ok: true;
      readonly reservations: readonly Reservation[];
      readonly drafts: readonly ApprovalDraft[];
    }
  | { readonly ok: false; readonly reason: ApprovalFailureReason };

/**
 * 却下の結果。成功なら、操作のあとの予約すべて（並び順は引数の reservations のまま）、解放する枠、下書き。
 * 解放する枠は、枠を確保している予約の占有区間の、操作の前後の差（開始の早い順。重なる区間・接する区間はつなぐ）。
 * 承認待ちの第二キープを却下して枠を解放したときの前倒しの案内（booking.md「第二キープ」）を作るかは例にないので、
 * 下書きには前倒しの案内も入れられる形にしておく
 */
export type RejectionResult =
  | {
      readonly ok: true;
      readonly reservations: readonly Reservation[];
      readonly released: readonly TimeRange[];
      readonly drafts: readonly (
        RejectionDraft | Extract<ReservationDraft, { kind: "bring-forward-notice" }>
      )[];
    }
  | { readonly ok: false; readonly reason: ApprovalFailureReason };

/**
 * 承認待ちの予約を承認する。承認は申込どおりに行い、決めるのは確定金額だけ。
 * 承認待ち（仮）→ 仮予約、承認待ち（本）→ 本予約、承認待ち（第二キープ）→ 第二キープ（付いている仮予約の id はそのまま）。
 * 承認の下書き（確定金額を差し込む）を作る
 */
export function approveReservation(input: {
  readonly reservations: readonly Reservation[];
  readonly reservationId: string;
  /** 管理者が決めた確定金額（税込） */
  readonly confirmedAmount: Yen;
}): ApprovalResult {
  const { reservations, reservationId, confirmedAmount } = input;
  const target = reservations.find((reservation) => reservation.id === reservationId);
  if (target === undefined) {
    return { ok: false, reason: "not-found" };
  }
  const approvedStatus = approvedStatusOf(target.status);
  if (approvedStatus === undefined) {
    return { ok: false, reason: "not-pending" };
  }
  const after = reservations.map((reservation): Reservation =>
    reservation === target
      ? { ...reservation, status: approvedStatus, confirmedAmount }
      : reservation,
  );
  return {
    ok: true,
    reservations: after,
    drafts: [{ kind: "approval", reservationId: target.id, confirmedAmount }],
  };
}

/**
 * 承認待ちの予約を却下する。状態は取消（cancelled）になり、確保していた枠を解放する。却下の下書きを作る。
 * 却下か取消かは履歴でわかる（履歴はこの関数の外で書く）
 */
export function rejectReservation(input: {
  readonly reservations: readonly Reservation[];
  readonly reservationId: string;
}): RejectionResult {
  const { reservations, reservationId } = input;
  const target = reservations.find((reservation) => reservation.id === reservationId);
  if (target === undefined) {
    return { ok: false, reason: "not-found" };
  }
  if (approvedStatusOf(target.status) === undefined) {
    return { ok: false, reason: "not-pending" };
  }
  // 取消と同じく、状態が取消になった第二キープは、付いている仮予約の id を空にする（Reservation の provisionalIds の説明）
  const after = reservations.map((reservation): Reservation =>
    reservation === target
      ? { ...reservation, status: "cancelled", provisionalIds: [] }
      : reservation,
  );
  const drafts: (RejectionDraft | Extract<ReservationDraft, { kind: "bring-forward-notice" }>)[] = [
    { kind: "rejection", reservationId: target.id },
  ];
  if (isSecondHoldStatus(target.status)) {
    // 却下は状態としては取消と同じ（booking.md「予約の状態」）。第二キープが取消・終了して枠を解放したときと同じく、
    // 前倒しの案内の下書きを作る（booking.md「第二キープ」。昇格に続く承認待ちの第二キープの終了と同じ扱い）
    for (const draft of bringForwardNotices(target, after)) {
      if (draft.kind === "bring-forward-notice") {
        drafts.push(draft);
      }
    }
  }
  return {
    ok: true,
    reservations: after,
    released: subtractRanges(holdingRanges(reservations), holdingRanges(after)),
    drafts,
  };
}

/** 承認待ちを承認したあとの状態（booking.md「予約の状態」の図）。承認待ちでなければ undefined */
function approvedStatusOf(status: ReservationStatus): ReservationStatus | undefined {
  switch (status) {
    case "pending-provisional":
      return "provisional";
    case "pending-firm":
      return "firm";
    case "pending-second-hold":
      return "second-hold";
    case "provisional":
    case "firm":
    case "second-hold":
    case "cancelled":
    case "ended":
      return undefined;
  }
}
