// 画面に出す日時と金額の形、月のカレンダーの並び（INV-7、INV-9）。
// API の日時は ISO 8601 のオフセット付きで来るので、JST に直して表示する。入力も JST で受け取る
import type { PublicBookingLabel, PublicCalendar } from "@zebra/contracts";
import { DateTime } from "luxon";

/** 表示と入力に使うタイムゾーン（INV-7） */
export const JST = "Asia/Tokyo";

/** 予約状況の1件（契約 PublicCalendar の各日の bookings の要素） */
export type PublicBooking = PublicCalendar["days"][number]["bookings"][number];

/** 表示名（booking.md「空き判定」。契約の値から画面の言葉へ） */
export const LABEL_TEXT: Record<PublicBookingLabel, string> = {
  provisional: "仮予約",
  firm: "本予約",
  "second-hold": "第二キープ",
  unavailable: "予約不可",
};

/** ISO 8601 の日時を、JST の DateTime にする。入力のオフセットが何であっても JST に直す */
export function toJst(iso: string): DateTime {
  const dateTime = DateTime.fromISO(iso, { zone: JST, locale: "ja" });
  if (!dateTime.isValid) throw new Error(`日時の形ではない：${iso}`);
  return dateTime;
}

/** JST の日付（YYYY-MM-DD）の0時 */
export function dayStart(date: string): DateTime {
  const day = DateTime.fromISO(date, { zone: JST, locale: "ja" });
  if (!day.isValid) throw new Error(`日付の形ではない：${date}`);
  return day.startOf("day");
}

/** その時点の JST の日付（YYYY-MM-DD） */
export function jstDate(dateTime: DateTime): string {
  return dateTime.setZone(JST).toISODate() ?? "";
}

/** その時点を含む JST の月の初日（0時） */
export function monthStartOf(dateTime: DateTime): DateTime {
  return dateTime.setZone(JST).setLocale("ja").startOf("month");
}

/** 月の初日と末日（YYYY-MM-DD）。予約状況を読む期間 */
export function monthRange(month: DateTime): { from: string; to: string } {
  return { from: month.toISODate() ?? "", to: month.endOf("month").toISODate() ?? "" };
}

/** 例：2026年11月 */
export function formatMonth(month: DateTime): string {
  return month.toFormat("yyyy年M月");
}

/** 例：11月20日(金) */
export function formatDay(date: string): string {
  return dayStart(date).toFormat("M月d日(ccc)");
}

/**
 * 月のカレンダーの並び。週は日曜はじまり。月の外のマスは null
 */
export function calendarWeeks(month: DateTime): (string | null)[][] {
  const first = month.startOf("month");
  const daysInMonth = first.daysInMonth ?? 0;
  // Luxon の weekday は月曜=1〜日曜=7。日曜はじまりの列の番号（0〜6）に直す
  const leading = first.weekday % 7;
  const cells: (string | null)[] = Array.from({ length: leading }, () => null);
  for (let day = 0; day < daysInMonth; day++) {
    cells.push(first.plus({ days: day }).toISODate());
  }
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let index = 0; index < cells.length; index += 7) {
    weeks.push(cells.slice(index, index + 7));
  }
  return weeks;
}

/** 開始の早い順（同じなら終わりの早い順）。公開 API の並べ方と同じ（booking.md「空き判定」） */
export function compareBookings(a: PublicBooking, b: PublicBooking): number {
  return (
    toJst(a.start).toMillis() - toJst(b.start).toMillis() ||
    toJst(a.end).toMillis() - toJst(b.end).toMillis()
  );
}

/**
 * マスの日付から見た時刻。同じ日なら「9:00」、ちょうど翌日の0時なら「24:00」、ほかの日なら「10/21 2:00」
 */
function timeOnDay(dateTime: DateTime, date: string): string {
  const day = dayStart(date);
  if (dateTime.hasSame(day, "day")) return dateTime.toFormat("H:mm");
  if (dateTime.toMillis() === day.plus({ days: 1 }).toMillis()) return "24:00";
  return dateTime.toFormat("M/d H:mm");
}

/**
 * マスに出す予約の時間。例：「9:00-12:00」。日をまたぐ予約は、マスの日付でない側に日付を付ける
 * （10/20 のマスでは「22:00-10/21 2:00」、10/21 のマスでは「10/20 22:00-2:00」）
 */
export function formatBookingTime(booking: PublicBooking, date: string): string {
  return `${timeOnDay(toJst(booking.start), date)}-${timeOnDay(toJst(booking.end), date)}`;
}

/** 例：「仮予約 9:00-12:00」 */
export function formatBooking(booking: PublicBooking, date: string): string {
  return `${LABEL_TEXT[booking.label]} ${formatBookingTime(booking, date)}`;
}

/** 申込の利用日時。例：11/20(金) 13:00〜15:00、11/20(金) 22:00〜11/21(土) 2:00 */
export function formatRange(start: DateTime, end: DateTime): string {
  const startJst = start.setZone(JST).setLocale("ja");
  const endJst = end.setZone(JST).setLocale("ja");
  const endText = endJst.hasSame(startJst, "day")
    ? endJst.toFormat("H:mm")
    : endJst.toFormat("M/d(ccc) H:mm");
  return `${startJst.toFormat("M/d(ccc) H:mm")}〜${endText}`;
}

/** 例：2時間、2時間30分 */
export function formatDuration(start: DateTime, end: DateTime): string {
  const minutes = end.diff(start, "minutes").minutes;
  const hours = Math.trunc(minutes / 60);
  const rest = minutes - hours * 60;
  return rest === 0 ? `${hours}時間` : `${hours}時間${rest}分`;
}

/** 例：10/13(火) 18:00 */
export function formatDeadline(dateTime: DateTime): string {
  return dateTime.setZone(JST).setLocale("ja").toFormat("M/d(ccc) H:mm");
}

const yenFormat = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 0 });

/** 整数の円（INV-9）。例：11,000円 */
export function formatYen(yen: number): string {
  if (!Number.isSafeInteger(yen)) throw new Error(`金額が整数の円ではない：${yen}`);
  return `${yenFormat.format(yen)}円`;
}
