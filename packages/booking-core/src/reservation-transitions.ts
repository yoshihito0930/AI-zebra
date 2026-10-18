// 予約の状態の移り変わり（docs/design-docs/reservation-model.md「状態と操作」、
// docs/product-specs/booking.md「予約の状態」「仮予約から本予約へ」「第二キープ」「取消とキャンセル料」「確認メール」）。
// 入出力を持たない（INV-5）。現在時刻は引数で受け取る（INV-7）。
// 枠と予約の書き込み（INV-2）と、下書きの保存・送信（INV-6）は呼び出す側が行う。
import type { ReservationStatus, Yen } from "@zebra/contracts";
import type { DateTime } from "luxon";
import {
  type ExistingReservation,
  type TimeRange,
  holdsSlots,
  occupiedRangeOf,
  overlaps,
} from "./availability";
import { type CancellationFeeRatePercent, calculateCancellationFee } from "./cancellation-fee";
import { provisionalDeadline } from "./provisional-deadline";

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

type ReservationOperationSuccess = Extract<ReservationOperationResult, { ok: true }>;

/**
 * 予約に管理者の操作をしたあとの、予約の状態・解放される枠・作る下書きを返す
 *
 * 操作できる状態（reservation-model.md「状態と操作」）
 * - promote：仮予約だけ。ほかの状態は invalid-status
 * - cancel：仮予約・本予約・第二キープだけ。承認待ちは「却下」（この関数の操作にない）で取消にするので invalid-status。
 *   取消・終了も invalid-status
 * - move-up：第二キープだけ。承認待ちの第二キープは、管理者が承認してから繰り上げる（booking.md「第二キープ」）ので invalid-status
 *
 * 状態が取消・終了になった第二キープは、付いている仮予約の id を空にする（Reservation の provisionalIds の説明）。
 * 取消す予約に確定金額がない（承認済みなのに null）か、キャンセル料を計算できない
 * （本予約を開始以降に取消す。booking.md の未決事項）ときは、calculateCancellationFee と同じく RangeError を投げる
 */
export function applyReservationOperation(input: {
  readonly reservations: readonly Reservation[];
  readonly operation: ReservationOperation;
}): ReservationOperationResult {
  const { reservations, operation } = input;
  const target = reservations.find((reservation) => reservation.id === operation.reservationId);
  if (target === undefined) {
    return { ok: false, reason: "not-found" };
  }
  switch (operation.kind) {
    case "promote":
      return promote(reservations, target);
    case "cancel":
      return cancel(reservations, target, operation.cancelledAt);
    case "move-up":
      return moveUp(reservations, target);
  }
}

/**
 * 昇格：仮予約 → 本予約。この仮予約に付いている第二キープ（承認待ちを含む。ほかの仮予約にも付いているものを含む）は終了。
 * 下書きは、昇格・終了・（条件を満たせば）前倒しの案内
 */
function promote(
  reservations: readonly Reservation[],
  target: Reservation,
): ReservationOperationResult {
  if (target.status !== "provisional") {
    return { ok: false, reason: "invalid-status" };
  }
  const endedSecondHolds = new Set(
    reservations.filter(
      (reservation) =>
        isSecondHoldStatus(reservation.status) && reservation.provisionalIds.includes(target.id),
    ),
  );
  const after = reservations.map((reservation): Reservation => {
    if (reservation === target) {
      return { ...reservation, status: "firm" };
    }
    if (endedSecondHolds.has(reservation)) {
      return { ...reservation, status: "ended", provisionalIds: [] };
    }
    return reservation;
  });
  const drafts: ReservationDraft[] = [
    { kind: "promotion", reservationId: target.id },
    ...[...endedSecondHolds].flatMap((secondHold): ReservationDraft[] => [
      { kind: "second-hold-ended", reservationId: secondHold.id },
      ...bringForwardNotices(secondHold, after),
    ]),
  ];
  return succeeded(reservations, after, drafts);
}

/**
 * 取消：仮予約・本予約・第二キープ → 取消。キャンセル料は calculateCancellationFee（確定金額で計算する）。
 * 仮予約の取消なら、付いている承認済みの第二キープに案内の下書き（承認待ちの第二キープは、状態も下書きも変えない）。
 * 第二キープの取消なら、条件を満たせば前倒しの案内の下書き
 */
function cancel(
  reservations: readonly Reservation[],
  target: Reservation,
  cancelledAt: DateTime,
): ReservationOperationResult {
  const status = target.status;
  if (status !== "provisional" && status !== "firm" && status !== "second-hold") {
    return { ok: false, reason: "invalid-status" };
  }
  if (target.confirmedAmount === null) {
    // 承認済みの予約は確定金額を持つ（reservation-model.md「金額」）。ないなら、キャンセル料を決められない
    throw new RangeError("取消す予約に確定金額がない");
  }
  const cancellationFee = calculateCancellationFee({
    status,
    amount: target.confirmedAmount,
    start: target.start,
    cancelledAt,
  });
  const after = reservations.map((reservation): Reservation =>
    reservation === target
      ? { ...reservation, status: "cancelled", provisionalIds: [] }
      : reservation,
  );

  const drafts: ReservationDraft[] = [
    {
      kind: "cancellation",
      reservationId: target.id,
      cancellationFee: { ratePercent: cancellationFee.ratePercent, fee: cancellationFee.fee },
    },
  ];
  if (status === "provisional") {
    for (const secondHold of after) {
      if (secondHold.status === "second-hold" && secondHold.provisionalIds.includes(target.id)) {
        drafts.push({
          kind: "move-up-notice",
          reservationId: secondHold.id,
          remainingProvisionalIds: provisionalsStillHolding(secondHold, after),
        });
      }
    }
  }
  if (status === "second-hold") {
    drafts.push(...bringForwardNotices(target, after));
  }
  return succeeded(reservations, after, drafts);
}

/**
 * 繰り上げ：第二キープ → 仮予約。付いている仮予約の id をすべて外す。
 * 付いている仮予約に、まだ仮予約のまま第二キープと重なっているものが残っていれば still-held。
 * 占有区間は変わらないので、解放する枠はない。下書きは作らない（reservation-model.md「状態と操作」の表で、繰り上げの下書きはない）
 */
function moveUp(
  reservations: readonly Reservation[],
  target: Reservation,
): ReservationOperationResult {
  if (target.status !== "second-hold") {
    return { ok: false, reason: "invalid-status" };
  }
  if (provisionalsStillHolding(target, reservations).length > 0) {
    return { ok: false, reason: "still-held" };
  }
  const after = reservations.map((reservation): Reservation =>
    reservation === target
      ? { ...reservation, status: "provisional", provisionalIds: [] }
      : reservation,
  );
  return succeeded(reservations, after, []);
}

function isSecondHoldStatus(status: ReservationStatus): boolean {
  return status === "second-hold" || status === "pending-second-hold";
}

function occupiedOf(reservation: Reservation): TimeRange {
  return occupiedRangeOf(reservation, reservation.bufferMinutes, "予約の予約区間");
}

/**
 * 第二キープに付いている仮予約のうち、まだ仮予約のまま第二キープの占有区間と重なっているものの id（provisionalIds の並び順）。
 * reservations にない id は、重なっているものに数えない
 */
function provisionalsStillHolding(
  secondHold: Reservation,
  reservations: readonly Reservation[],
): string[] {
  const occupied = occupiedOf(secondHold);
  return secondHold.provisionalIds.filter((id) => {
    const provisional = reservations.find((reservation) => reservation.id === id);
    return (
      provisional !== undefined &&
      provisional.status === "provisional" &&
      overlaps(occupiedOf(provisional), occupied)
    );
  });
}

/**
 * 第二キープが取消・終了して枠を解放したときの、前倒しの案内の下書き（booking.md「第二キープ」）。
 * 操作のあとに枠を確保している予約のうち、第二キープの占有区間の終わりに接して始まるもののお客様あて
 */
function bringForwardNotices(
  secondHold: Reservation,
  after: readonly Reservation[],
): ReservationDraft[] {
  const endMillis = occupiedOf(secondHold).end.toMillis();
  return after
    .filter(
      (reservation) =>
        reservation.id !== secondHold.id &&
        holdsSlots(reservation.status) &&
        reservation.start.toMillis() === endMillis,
    )
    .map((reservation) => ({ kind: "bring-forward-notice", reservationId: reservation.id }));
}

function succeeded(
  before: readonly Reservation[],
  after: readonly Reservation[],
  drafts: readonly ReservationDraft[],
): ReservationOperationSuccess {
  return {
    ok: true,
    reservations: after,
    released: subtractRanges(holdingRanges(before), holdingRanges(after)),
    drafts,
  };
}

/** 枠を確保している予約の占有区間 */
function holdingRanges(reservations: readonly Reservation[]): TimeRange[] {
  return reservations
    .filter((reservation) => holdsSlots(reservation.status))
    .map((reservation) => occupiedOf(reservation));
}

/** 区間を開始の早い順に並べ、重なる区間・接する区間をつないで1つにする。空の区間は除く */
function mergeRanges(ranges: readonly TimeRange[]): TimeRange[] {
  const sorted = ranges
    .filter((range) => range.start.toMillis() < range.end.toMillis())
    .sort((a, b) => a.start.toMillis() - b.start.toMillis());
  const merged: TimeRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && range.start.toMillis() <= last.end.toMillis()) {
      if (range.end.toMillis() > last.end.toMillis()) {
        merged[merged.length - 1] = { start: last.start, end: range.end };
      }
    } else {
      merged.push(range);
    }
  }
  return merged;
}

/** from のどれかに入っていて、removed のどれにも入らない時間（開始の早い順。重なる・接する区間はつなぐ） */
function subtractRanges(from: readonly TimeRange[], removed: readonly TimeRange[]): TimeRange[] {
  let rest = mergeRanges(from);
  for (const cut of mergeRanges(removed)) {
    rest = rest.flatMap((range): TimeRange[] => {
      if (!overlaps(range, cut)) {
        return [range];
      }
      const pieces: TimeRange[] = [];
      if (range.start.toMillis() < cut.start.toMillis()) {
        pieces.push({ start: range.start, end: cut.start });
      }
      if (cut.end.toMillis() < range.end.toMillis()) {
        pieces.push({ start: cut.end, end: range.end });
      }
      return pieces;
    });
  }
  return mergeRanges(rest);
}

/**
 * 管理画面で「仮予約の期限を過ぎた」警告を出すか。
 * 仮予約と、承認待ちの仮予約申込（pending-provisional）のうち、now が仮予約の期限（start から求める）以降のものに出す。
 * 状態は変えない（booking.md「仮予約から本予約へ」）。
 * ちょうど期限の時刻は「過ぎた」側（警告を出す）。判定は時点で比べるので、渡された DateTime のゾーンによらない（INV-7）。
 * 不正な日時なら RangeError を投げる（黙って警告を出さないことにしない）
 */
export function needsProvisionalDeadlineWarning(input: {
  readonly status: ReservationStatus;
  readonly start: DateTime;
  readonly now: DateTime;
}): boolean {
  const { status, start, now } = input;
  if (status !== "provisional" && status !== "pending-provisional") {
    return false;
  }
  if (!start.isValid || !now.isValid) {
    throw new RangeError("開始日時か現在時刻が不正");
  }
  return now.toMillis() >= provisionalDeadline(start).toMillis();
}
