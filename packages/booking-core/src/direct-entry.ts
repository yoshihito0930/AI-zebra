// 管理者による予約の直接入力（docs/product-specs/booking.md「管理者による予約の直接入力とブロック枠」の「直接入れる予約のルール」）。
// 現在時刻は使わない。管理者が入れる日時は、呼ぶ側が時計の部品から取って引数で渡す（INV-7）
import type { DateTime } from "luxon";
import { adminDeadlineWarnings, checkAdminDuration } from "./admin-time-rules.ts";
import type { ApplicationDeadlineViolation } from "./application-deadline.ts";
import {
  type ExistingBlock,
  type ExistingReservation,
  type ReservationBufferMinutes,
  checkAvailability,
} from "./availability.ts";
import { checkSecondHoldApplication } from "./second-hold.ts";

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
 * - late-night-shorter-than-4-hours：深夜帯にかかり、4時間未満（2時間以上）
 */
export type DirectEntryWarning =
  "past-24-hours-before-start" | "past-provisional-deadline" | "late-night-shorter-than-4-hours";

/**
 * 不可の理由。例外を認めない
 * - not-on-30-minute-boundary：開始か終了が30分単位（JST）でない
 * - shorter-than-2-hours：2時間未満（深夜帯にかかっても）
 * - longer-than-24-hours：24時間を超える
 * - overlaps-existing：空き判定で不可（INV-1。第二キープは、承認済みの仮予約以外と重なる）
 * - no-provisional-to-hold：第二キープで、どの承認済みの仮予約とも重ならない（付く仮予約がない）
 */
export type DirectEntryRejection =
  | "not-on-30-minute-boundary"
  | "shorter-than-2-hours"
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

/**
 * 管理者が直接入れる予約を、入れられるか判定する。
 * 判定は申込と同じ関数を使い、ここで同じ判定を書き直さない。時間と締め切りの決まりは、予約の変更と共有する（admin-time-rules.ts）。
 * - 時間の単位と利用時間（checkAdminDuration）：30分単位でない・2時間未満（深夜帯にかかっても）・24時間を超えるは不可。
 *   深夜帯にかかり4時間未満（2時間以上）は警告
 * - 空き判定：仮予約・本予約は checkAvailability、第二キープは checkSecondHoldApplication（承認済みの仮予約とだけ重なれ、重なるものすべてに付く）
 * - 締め切り（警告。adminDeadlineWarnings）：本予約は開始の24時間前、仮予約と第二キープは仮予約の期限
 *
 * 不可の理由が2つ以上当てはまるときは、時間の単位と利用時間（30分単位・24時間・2時間未満の順）、空き判定の順で最初のものを返す。
 * 第二キープで overlaps-existing と no-provisional-to-hold が両方当てはまるときは overlaps-existing（checkSecondHoldApplication と同じ）。
 * 警告は、締め切り、深夜帯の最短4時間の順に並べる（2つ以上当てはまるときの順は仕様で決めていない）。
 * 予約区間・既存の予約・ブロック枠の区間が、不正な日時か終了が開始以前なら RangeError を投げる（checkAvailability と同じ扱い）
 */
export function checkDirectEntry(input: DirectEntryInput): DirectEntryResult {
  const duration = checkAdminDuration(input.start, input.end);
  if (!duration.ok) {
    return duration;
  }

  const slots = checkSlots(input);
  if (!slots.ok) {
    return slots;
  }

  const deadlineWarnings: readonly ApplicationDeadlineViolation[] = adminDeadlineWarnings(
    input.kind,
    input.start,
    input.enteredAt,
  );

  return {
    ok: true,
    warnings: [...deadlineWarnings, ...duration.warnings],
    provisionalIds: slots.provisionalIds,
  };
}

/** 空き判定（INV-1）。第二キープなら、付く承認済みの仮予約の id も返す */
function checkSlots(
  input: DirectEntryInput,
):
  | { ok: true; provisionalIds: readonly string[] }
  | { ok: false; reason: "overlaps-existing" | "no-provisional-to-hold" } {
  const { start, end, bufferMinutes, reservations, blocks } = input;
  if (input.kind === "second-hold") {
    return checkSecondHoldApplication({ start, end, bufferMinutes, reservations, blocks });
  }
  const availability = checkAvailability({ start, end, bufferMinutes, reservations, blocks });
  return availability.ok ? { ok: true, provisionalIds: [] } : availability;
}
