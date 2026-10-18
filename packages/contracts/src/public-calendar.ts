// 公開API（認証なし）が返す予約状況（INV-3。docs/product-specs/booking.md「空き判定」）。
// 日ごとに、すでに入っている予約の表示名と時間（予約区間。バッファを含まない）だけを返す。
// 予約の id、承認待ちかどうか、お客様の情報、金額、ブロック枠の理由は返さない。余計なキーがあれば通さない（strictObject）
import { z } from "zod";

/**
 * 表示名。ウィジェットでは次のように出す
 * - provisional：仮予約（仮予約と承認待ち〔仮〕）
 * - firm：本予約（本予約と承認待ち〔本〕）
 * - second-hold：第二キープ（第二キープと承認待ち〔第二キープ〕）
 * - unavailable：予約不可（ブロック枠）
 */
export const PublicBookingLabel = z.enum(["provisional", "firm", "second-hold", "unavailable"]);
export type PublicBookingLabel = z.infer<typeof PublicBookingLabel>;

const PublicBooking = z.strictObject({
  label: PublicBookingLabel,
  /** 予約区間の開始と終わり（ISO 8601、オフセット付き）。日をまたぐ予約は、かかる日それぞれに同じ時間で入る */
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
});

const PublicCalendarDay = z.strictObject({
  /** JST の日付（YYYY-MM-DD） */
  date: z.iso.date(),
  bookings: z.array(PublicBooking),
});

export const PublicCalendar = z.strictObject({
  days: z.array(PublicCalendarDay),
});
export type PublicCalendar = z.infer<typeof PublicCalendar>;
