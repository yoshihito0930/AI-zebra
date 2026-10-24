// ブロック枠（docs/product-specs/booking.md「管理者による予約の直接入力とブロック枠」の「ブロック枠のバッファ」）。
// 管理者が入れるブロック枠の判定と、Googleカレンダーの予定からブロック枠を作る変換。
// どの予定を取り込むか（docs/product-specs/index.md「Googleカレンダーの取り込み」）は、ここでは扱わない
import type { DateTime } from "luxon";
import {
  type BufferMinutes,
  type ExistingBlock,
  type ExistingReservation,
  type TimeRange,
  occupiedRangeOf,
  overlapsAnyHolding,
} from "./availability.ts";
import { isOn30MinuteBoundary } from "./jst-time.ts";

export interface AdminBlockInput {
  start: DateTime;
  end: DateTime;
  /** 「なし／30分／1時間」。管理画面の初期値は「なし」（0） */
  bufferMinutes: BufferMinutes;
  reservations: readonly ExistingReservation[];
  blocks: readonly ExistingBlock[];
}

/**
 * - not-on-30-minute-boundary：開始か終了が30分単位（JST）でない
 * - overlaps-existing：空き判定で不可（INV-1。枠を確保している予約か、ほかのブロック枠の占有区間と重なる）
 */
export type AdminBlockRejection = "not-on-30-minute-boundary" | "overlaps-existing";

/** 入れられるなら、ブロック枠の占有区間 [start, end + バッファ) を返す */
export type AdminBlockResult =
  { ok: true; occupied: TimeRange } | { ok: false; reason: AdminBlockRejection };

/**
 * 管理者が入れるブロック枠を、入れられるか判定する。最短・最長はない。
 * 開始・終了は30分単位（JST。予約と同じ isOn30MinuteBoundary）。
 * 空き判定は、申込と同じ overlapsAnyHolding で、占有区間 [start, end + バッファ) が、枠を確保している予約
 * （承認済みの仮予約と第二キープを含む。ブロック枠には第二キープのような例外はない）とほかのブロック枠の
 * どの占有区間とも重ならなければ入る（INV-1）。
 * 理由が2つとも当てはまるときは not-on-30-minute-boundary を返す（checkDirectEntry と同じ順）。
 * 入れるブロック枠・既存の予約・既存のブロック枠の区間が、不正な日時か終了が開始以前なら RangeError を投げる（checkAvailability と同じ扱い）
 */
export function checkAdminBlock(input: AdminBlockInput): AdminBlockResult {
  const occupied = occupiedRangeOf(input, input.bufferMinutes, "ブロック枠");
  if (!isOn30MinuteBoundary(input.start) || !isOn30MinuteBoundary(input.end)) {
    return { ok: false, reason: "not-on-30-minute-boundary" };
  }
  if (overlapsAnyHolding(occupied, input.reservations, input.blocks)) {
    return { ok: false, reason: "overlaps-existing" };
  }
  return { ok: true, occupied };
}

/** Googleカレンダーから取り込んだブロック枠のバッファ（「ブロック枠のバッファ」） */
const CALENDAR_BLOCK_BUFFER_MINUTES = 60;

/** Googleカレンダーの予定の時間 */
export interface CalendarEvent {
  start: DateTime;
  end: DateTime;
}

/** Googleカレンダーの予定から、取り込むブロック枠を作る。時刻はそのまま使い（30分単位でなくてよい）、後ろに1時間のバッファを付ける */
export function blockFromCalendarEvent(event: CalendarEvent): ExistingBlock {
  return { start: event.start, end: event.end, bufferMinutes: CALENDAR_BLOCK_BUFFER_MINUTES };
}
