import type { DateTime } from "luxon";
import { provisionalDeadline } from "./provisional-deadline";

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

// 本予約申込は、開始の24時間前まで
const FIRM_HOURS_BEFORE_START = 24;

// 申込日時が、申込の種類ごとの締め切りの前かを判定する。判定は JST で行う（INV-7）。
//
// 締め切りは時点で比べるので、渡された DateTime のゾーンによらない（JST の日付が要る仮予約の期限は
// provisionalDeadline の中で JST に直して求める）。
// ちょうど締め切りの時刻は「過ぎた」側に入れる（半開区間。appliedAt < 締め切り のときだけ受付）。
// 申込日時が開始より後の場合も、締め切りを過ぎているので同じ理由で不可になる。
export function checkApplicationDeadline(
  input: ApplicationDeadlineInput,
): ApplicationDeadlineResult {
  const { kind, start, appliedAt } = input;

  switch (kind) {
    case "firm": {
      const deadline = start.minus({ hours: FIRM_HOURS_BEFORE_START });
      return isBefore(appliedAt, deadline)
        ? { ok: true }
        : { ok: false, reason: "past-24-hours-before-start" };
    }
    case "provisional": {
      const deadline = provisionalDeadline(start);
      return isBefore(appliedAt, deadline)
        ? { ok: true }
        : { ok: false, reason: "past-provisional-deadline" };
    }
  }
}

// a が b より前の時点か（ゾーンによらず、時点で比べる）
function isBefore(a: DateTime, b: DateTime): boolean {
  return a.toMillis() < b.toMillis();
}
