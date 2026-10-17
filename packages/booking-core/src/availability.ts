// 空き判定（docs/product-specs/booking.md「空き判定」「バッファを30分に縮める」。INV-1）
// 区間はすべて半開区間 [start, end)。占有区間は [start, end + バッファ)。
// 第二キープの申込だけ仮予約1件との重なりを許す例外（「第二キープ」の節）は、ここでは扱わない。
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

/** 区間 [start, end) とバッファから、占有区間 [start, end + バッファ) を求める */
export function occupiedRange(range: TimeRange, bufferMinutes: BufferMinutes): TimeRange {
  void range;
  void bufferMinutes;
  throw new Error("未実装");
}

/** 申込の占有区間が、枠を確保している既存の予約とブロック枠のどの占有区間とも重ならなければ予約可 */
export function checkAvailability(input: AvailabilityInput): AvailabilityResult {
  void input;
  throw new Error("未実装");
}

/** 管理者が予約のバッファを切り替えられるか。切り替えたあとの占有区間が、自分以外と重ならなければ成功 */
export function checkBufferChange(input: BufferChangeInput): BufferChangeResult {
  void input;
  throw new Error("未実装");
}
