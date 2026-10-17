import type { DateTime } from "luxon";

// 申込の種類（docs/product-specs/booking.md の「申込の締め切り」）。firm＝本予約申込、provisional＝仮予約申込。
// 第二キープ申込の締め切りは仕様の未決事項なので、ここには入れない。
export type ApplicationKind = "firm" | "provisional";

// 申込を受け付けられない理由。
// - past-24-hours-before-start：本予約申込が、開始の24時間前を過ぎた（ちょうど24時間前を含む）
// - past-provisional-deadline：仮予約申込が、仮予約の期限を過ぎた（ちょうど期限の時刻を含む）
export type ApplicationDeadlineViolation =
  "past-24-hours-before-start" | "past-provisional-deadline";

export type ApplicationDeadlineResult =
  { ok: true } | { ok: false; reason: ApplicationDeadlineViolation };

export interface ApplicationDeadlineInput {
  /** 申込の種類 */
  kind: ApplicationKind;
  /** 申込の予約区間の開始日時 */
  start: DateTime;
  /** 申込日時（現在時刻は呼び出し側が時計の部品から取って渡す。INV-7） */
  appliedAt: DateTime;
}

// 申込日時が、申込の種類ごとの締め切りの前かを判定する。判定は JST で行う（INV-7）。
export function checkApplicationDeadline(
  input: ApplicationDeadlineInput,
): ApplicationDeadlineResult {
  void input;
  throw new Error("未実装");
}
