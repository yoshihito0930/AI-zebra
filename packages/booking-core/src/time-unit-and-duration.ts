// 時間の単位と利用時間（docs/product-specs/booking.md「時間の単位と利用時間」）
import type { DateTime } from "luxon";

/**
 * 予約不可の理由。
 * - "not-on-30-minute-boundary"：30分単位でない（開始・終了が JST の毎時 :00 か :30 でない）
 * - "shorter-than-2-hours"：2時間未満
 * - "late-night-shorter-than-4-hours"：深夜帯（23:00〜翌8:00）にかかり、4時間未満
 * - "longer-than-24-hours"：24時間を超える
 */
export type TimeUnitRejectionReason =
  | "not-on-30-minute-boundary"
  | "shorter-than-2-hours"
  | "late-night-shorter-than-4-hours"
  | "longer-than-24-hours";

/** 予約可か、予約不可とその理由 */
export type TimeUnitCheckResult = { ok: true } | { ok: false; reason: TimeUnitRejectionReason };

/**
 * 申込の予約区間 [start, end) が、時間の単位と利用時間のルールを満たすかを判定する。
 * 判定は JST で行う（INV-7）。
 */
export function checkTimeUnitAndDuration(start: DateTime, end: DateTime): TimeUnitCheckResult {
  void start;
  void end;
  throw new Error("未実装");
}
