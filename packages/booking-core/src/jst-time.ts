// JST での時刻の定義（INV-7）。深夜帯（booking.md「用語」）と30分単位（「時間の単位と利用時間」）を、
// 「時間の単位と利用時間」と「料金」で同じ定義を使うためにここにまとめる
import type { DateTime } from "luxon";

/** 判定に使うタイムゾーン（INV-7） */
export const JST = "Asia/Tokyo";

/** 予約の時間の単位（分） */
export const SLOT_MINUTES = 30;

// 通常帯は 8:00〜23:00。それ以外（23:00〜翌8:00）が深夜帯（booking.md「用語」）
export const DAYTIME_START_HOUR = 8;
export const DAYTIME_END_HOUR = 23;

/**
 * その時刻が深夜帯（JST の 23:00〜翌8:00）に入るか。
 * 渡された DateTime のゾーンが何であっても、JST に直してから判定する。
 * 23:00 ちょうどは深夜帯、8:00 ちょうどは通常帯。
 */
export function isLateNight(dateTime: DateTime): boolean {
  const hour = dateTime.setZone(JST).hour;
  return hour < DAYTIME_START_HOUR || hour >= DAYTIME_END_HOUR;
}

/** JST の毎時 :00 か :30 ちょうど（秒・ミリ秒も 0）か */
export function isOn30MinuteBoundary(dateTime: DateTime): boolean {
  const inJst = dateTime.setZone(JST);
  return inJst.minute % SLOT_MINUTES === 0 && inJst.second === 0 && inJst.millisecond === 0;
}
