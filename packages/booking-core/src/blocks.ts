// ブロック枠（docs/product-specs/booking.md「管理者による予約の直接入力とブロック枠」の「ブロック枠のバッファ」）。
// 管理者が入れるブロック枠の判定と、Googleカレンダーの予定からブロック枠を作る変換。
// どの予定を取り込むか（docs/product-specs/index.md「Googleカレンダーの取り込み」）は、ここでは扱わない
import type { DateTime } from "luxon";
import type {
  BufferMinutes,
  ExistingBlock,
  ExistingReservation,
  TimeRange,
} from "./availability.ts";

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

/** 管理者が入れるブロック枠を、入れられるか判定する。最短・最長はない */
export function checkAdminBlock(input: AdminBlockInput): AdminBlockResult {
  void input;
  throw new Error("未実装");
}

/** Googleカレンダーの予定の時間 */
export interface CalendarEvent {
  start: DateTime;
  end: DateTime;
}

/** Googleカレンダーの予定から、取り込むブロック枠を作る。時刻はそのまま使い（30分単位でなくてよい）、後ろに1時間のバッファを付ける */
export function blockFromCalendarEvent(event: CalendarEvent): ExistingBlock {
  void event;
  throw new Error("未実装");
}
