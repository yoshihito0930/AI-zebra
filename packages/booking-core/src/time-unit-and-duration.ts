// 時間の単位と利用時間（docs/product-specs/booking.md「時間の単位と利用時間」）
import type { DateTime } from "luxon";
import { DAYTIME_END_HOUR, DAYTIME_START_HOUR, JST, isOn30MinuteBoundary } from "./jst-time";

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

const MINUTES_PER_HOUR = 60;
const MIN_MINUTES = 2 * MINUTES_PER_HOUR;
const LATE_NIGHT_MIN_MINUTES = 4 * MINUTES_PER_HOUR;
const MAX_MINUTES = 24 * MINUTES_PER_HOUR;

/**
 * 申込の予約区間 [start, end) が、時間の単位と利用時間のルールを満たすかを判定する。
 * 判定は JST で行う（INV-7）。渡された DateTime のゾーンが何であっても、JST に直してから判定する。
 *
 * 理由が複数当てはまるときは、次の順で最初に当てはまったものを返す。
 * この順は仮のもの（booking.md の未決事項「予約不可の理由が複数当てはまるとき」が決まるまで）。
 *   1. 30分単位でない
 *   2. 24時間を超える
 *   3. 深夜帯にかかり、4時間未満
 *   4. 2時間未満
 */
export function checkTimeUnitAndDuration(start: DateTime, end: DateTime): TimeUnitCheckResult {
  const startJst = start.setZone(JST);
  const endJst = end.setZone(JST);

  if (!isOn30MinuteBoundary(startJst) || !isOn30MinuteBoundary(endJst)) {
    return { ok: false, reason: "not-on-30-minute-boundary" };
  }

  const minutes = endJst.diff(startJst, "minutes").minutes;

  if (minutes > MAX_MINUTES) {
    return { ok: false, reason: "longer-than-24-hours" };
  }
  if (overlapsLateNight(startJst, endJst) && minutes < LATE_NIGHT_MIN_MINUTES) {
    return { ok: false, reason: "late-night-shorter-than-4-hours" };
  }
  if (minutes < MIN_MINUTES) {
    return { ok: false, reason: "shorter-than-2-hours" };
  }
  return { ok: true };
}

/**
 * 予約区間 [start, end)（どちらも JST）が、深夜帯に少しでもかかるか。
 * かからないのは、区間が開始日の通常帯 [8:00, 23:00) にすっぽり収まるときだけ。
 */
function overlapsLateNight(startJst: DateTime, endJst: DateTime): boolean {
  const daytimeStart = startJst.startOf("day").set({ hour: DAYTIME_START_HOUR });
  const daytimeEnd = startJst.startOf("day").set({ hour: DAYTIME_END_HOUR });
  const withinDaytime =
    startJst.toMillis() >= daytimeStart.toMillis() && endJst.toMillis() <= daytimeEnd.toMillis();
  return !withinDaytime;
}
