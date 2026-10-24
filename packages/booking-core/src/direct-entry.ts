// 管理者による予約の直接入力（docs/product-specs/booking.md「管理者による予約の直接入力とブロック枠」の「直接入れる予約のルール」）。
// 現在時刻は使わない。管理者が入れる日時は、呼ぶ側が時計の部品から取って引数で渡す（INV-7）
import type { DateTime } from "luxon";
import type {
  ExistingBlock,
  ExistingReservation,
  ReservationBufferMinutes,
} from "./availability.ts";

/** 直接入れる予約の種類。承認待ちを経ず、この状態（ReservationStatus と同じ呼び名）で入る */
export type DirectEntryKind = "provisional" | "firm" | "second-hold";

export interface DirectEntryInput {
  kind: DirectEntryKind;
  start: DateTime;
  end: DateTime;
  bufferMinutes: ReservationBufferMinutes;
  /** 管理者が入れる日時。締め切りの判定に使う */
  enteredAt: DateTime;
  reservations: readonly ExistingReservation[];
  blocks: readonly ExistingBlock[];
}

/**
 * 警告。反していても、管理者が確認すれば入れられる
 * - past-24-hours-before-start：本予約の締め切り（開始の24時間前）を過ぎた
 * - past-provisional-deadline：仮予約・第二キープの締め切り（仮予約の期限）を過ぎた
 * - shorter-than-2-hours：2時間未満
 * - late-night-shorter-than-4-hours：深夜帯にかかり、4時間未満
 */
export type DirectEntryWarning =
  | "past-24-hours-before-start"
  | "past-provisional-deadline"
  | "shorter-than-2-hours"
  | "late-night-shorter-than-4-hours";

/**
 * 不可の理由。例外を認めない
 * - not-on-30-minute-boundary：開始か終了が30分単位（JST）でない
 * - longer-than-24-hours：24時間を超える
 * - overlaps-existing：空き判定で不可（INV-1。第二キープは、承認済みの仮予約以外と重なる）
 * - no-provisional-to-hold：第二キープで、どの承認済みの仮予約とも重ならない（付く仮予約がない）
 */
export type DirectEntryRejection =
  | "not-on-30-minute-boundary"
  | "longer-than-24-hours"
  | "overlaps-existing"
  | "no-provisional-to-hold";

/**
 * - 入れられる：{ ok: true, warnings, provisionalIds }。warnings は当てはまる警告（なければ空）。管理画面は警告を見せ、管理者が確認したら入れる。
 *   provisionalIds は、第二キープなら占有区間が重なる承認済みの仮予約すべての id（引数の reservations の並び順）。仮予約・本予約なら空
 * - 不可：{ ok: false, reason }
 */
export type DirectEntryResult =
  | {
      ok: true;
      warnings: readonly DirectEntryWarning[];
      provisionalIds: readonly string[];
    }
  | { ok: false; reason: DirectEntryRejection };

/** 管理者が直接入れる予約を、入れられるか判定する */
export function checkDirectEntry(input: DirectEntryInput): DirectEntryResult {
  void input;
  throw new Error("未実装");
}
