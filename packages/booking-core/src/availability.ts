// 空き判定（docs/product-specs/booking.md「空き判定」「バッファを30分に縮める」。INV-1）
// 区間はすべて半開区間 [start, end)。占有区間は [start, end + バッファ)。
// 第二キープの申込だけ承認済みの仮予約との重なり（2件以上にまたがってもよい）を許す例外（「第二キープ」の節）は、ここでは扱わない（second-hold.ts）。
// 占有区間・重なり・枠を確保する状態の判定は second-hold.ts・blocks.ts と共有する（同じ計算を2か所に持たない）。
// 共有の部品は booking-core の中だけで使い、index.ts からは出さない。
import type { ReservationStatus } from "@zebra/contracts";
import type { DateTime } from "luxon";

/** バッファの長さ（分）。ブロック枠は「なし／30分／1時間」から選べる */
export type BufferMinutes = 0 | 30 | 60;

/** 予約のバッファ（分）。原則1時間、管理者が予約ごとに30分に縮められる */
export type ReservationBufferMinutes = 30 | 60;

/** 半開区間 [start, end) */
export interface TimeRange {
  readonly start: DateTime;
  readonly end: DateTime;
}

/** すでにある予約。占有区間の枠を確保するかは status で決まる（「予約の状態」の節） */
export interface ExistingReservation {
  readonly id: string;
  readonly status: ReservationStatus;
  /** 予約区間の開始 */
  readonly start: DateTime;
  /** 予約区間の終了 */
  readonly end: DateTime;
  readonly bufferMinutes: ReservationBufferMinutes;
}

/** すでにあるブロック枠 */
export interface ExistingBlock {
  readonly start: DateTime;
  readonly end: DateTime;
  readonly bufferMinutes: BufferMinutes;
}

export interface AvailabilityInput {
  /** 申込の予約区間の開始 */
  readonly start: DateTime;
  /** 申込の予約区間の終了 */
  readonly end: DateTime;
  /** 申込のバッファ */
  readonly bufferMinutes: ReservationBufferMinutes;
  readonly reservations: readonly ExistingReservation[];
  readonly blocks: readonly ExistingBlock[];
}

export type AvailabilityResult = { ok: true } | { ok: false; reason: "overlaps-existing" };

export interface BufferChangeInput {
  /** バッファを切り替える予約 */
  readonly target: ExistingReservation;
  /** 切り替えたあとのバッファ */
  readonly bufferMinutes: ReservationBufferMinutes;
  /** すでにある予約。target 自身（同じ id）が入っていてもよく、判定では除く */
  readonly reservations: readonly ExistingReservation[];
  readonly blocks: readonly ExistingBlock[];
}

export type BufferChangeResult =
  { ok: true; occupied: TimeRange } | { ok: false; reason: "overlaps-existing" };

/**
 * 予約区間・ブロック枠の区間として扱えるかを確かめる。
 * 不正な日時や、終了が開始以前の区間は、重なりを正しく判定できない（比べた結果が「重ならない」になり、
 * 枠を確保しているものを見落とすおそれがある。INV-1）ので、RangeError を投げる（黙って予約可にしない）。
 * 30分単位かは確かめない（申込の区間は checkTimeUnitAndDuration の役目。取り込んだブロック枠は30分単位とは限らない）。
 * 管理者の操作の時間の判定（admin-time-rules.ts）でも、判定の前に使う
 */
export function assertValidRange(range: TimeRange, what: string): void {
  if (!range.start.isValid || !range.end.isValid) {
    throw new RangeError(`${what}の日時が不正`);
  }
  if (range.end.toMillis() <= range.start.toMillis()) {
    throw new RangeError(`${what}の終了が開始以前`);
  }
}

/**
 * 半開区間 [a.start, a.end) と [b.start, b.end) が重なるか。接するだけなら重ならない。
 * 時点（ミリ秒）で比べるので、渡された DateTime のゾーンによらない
 */
export function overlaps(a: TimeRange, b: TimeRange): boolean {
  return a.start.toMillis() < b.end.toMillis() && b.start.toMillis() < a.end.toMillis();
}

/** 「予約の状態」の節の表で、占有区間の枠を確保する状態か。取消・終了は確保しない */
export function holdsSlots(status: ReservationStatus): boolean {
  switch (status) {
    case "pending-provisional":
    case "pending-firm":
    case "pending-second-hold":
    case "provisional":
    case "firm":
    case "second-hold":
      return true;
    case "cancelled":
    case "ended":
      return false;
  }
}

/**
 * 占有区間 occupied が、枠を確保している予約とブロック枠のどれかの占有区間と重なるか。
 * 不正な区間の予約・ブロック枠があれば RangeError を投げる（状態が取消・終了の予約は枠を確保しないので確かめない）
 */
export function overlapsAnyHolding(
  occupied: TimeRange,
  reservations: readonly ExistingReservation[],
  blocks: readonly ExistingBlock[],
): boolean {
  const holding = reservations.filter((reservation) => holdsSlots(reservation.status));
  const occupiedRanges = [
    ...holding.map((reservation) =>
      occupiedRangeOf(reservation, reservation.bufferMinutes, "既存の予約の予約区間"),
    ),
    ...blocks.map((block) => occupiedRangeOf(block, block.bufferMinutes, "既存のブロック枠")),
  ];
  return occupiedRanges.some((other) => overlaps(occupied, other));
}

/**
 * 区間 [start, end) とバッファから、占有区間 [start, end + バッファ) を求める。
 * 不正な日時か、終了が開始以前の区間なら RangeError を投げる
 */
export function occupiedRange(range: TimeRange, bufferMinutes: BufferMinutes): TimeRange {
  return occupiedRangeOf(range, bufferMinutes, "区間");
}

/** occupiedRange と同じ。RangeError のメッセージに、どの区間かを書く */
export function occupiedRangeOf(
  range: TimeRange,
  bufferMinutes: BufferMinutes,
  what: string,
): TimeRange {
  assertValidRange(range, what);
  return { start: range.start, end: range.end.plus({ minutes: bufferMinutes }) };
}

/**
 * 申込の占有区間が、枠を確保している既存の予約とブロック枠のどの占有区間とも重ならなければ予約可。
 * 第二キープ以外の申込（仮予約申込・本予約申込、管理者が直接入れる仮予約・本予約）の判定。
 * 第二キープの申込は承認済みの仮予約との重なり（2件以上にまたがってもよい）を許す（「第二キープ」の節）が、その例外はこの関数では扱わない。
 * 申込・既存の予約・ブロック枠の区間が、不正な日時か終了が開始以前なら RangeError を投げる
 */
export function checkAvailability(input: AvailabilityInput): AvailabilityResult {
  const occupied = occupiedRangeOf(input, input.bufferMinutes, "申込の予約区間");
  if (overlapsAnyHolding(occupied, input.reservations, input.blocks)) {
    return { ok: false, reason: "overlaps-existing" };
  }
  return { ok: true };
}

/**
 * 管理者が予約のバッファを切り替えられるか。切り替えたあとの占有区間が、自分以外と重ならなければ成功。
 * target 自身（同じ id）は reservations から除いて判定する。
 * 第二キープと仮予約の重なりの例外（「第二キープ」の節）はこの関数では扱わない。
 * target・既存の予約・ブロック枠の区間が、不正な日時か終了が開始以前なら RangeError を投げる
 */
export function checkBufferChange(input: BufferChangeInput): BufferChangeResult {
  const occupied = occupiedRangeOf(input.target, input.bufferMinutes, "切り替える予約の予約区間");
  const others = input.reservations.filter((reservation) => reservation.id !== input.target.id);
  if (overlapsAnyHolding(occupied, others, input.blocks)) {
    return { ok: false, reason: "overlaps-existing" };
  }
  return { ok: true, occupied };
}
