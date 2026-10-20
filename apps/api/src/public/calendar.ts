// 公開API（認証なし）の予約状況（INV-3。docs/product-specs/booking.md「空き判定」、
// docs/design-docs/dynamodb-keys.md「読み出し」）。
// 期間の日ごとのアイテムを読み、入っている予約・ブロック枠を「表示名と時間（予約区間。バッファを含まない）」に直して返す。
// 読むのは日ごとのアイテムだけ。予約の META や個人情報は読まない。
// 返す値は、最後に契約（PublicCalendar、strictObject）を通す。id・状態・個人情報・金額・ブロック枠の理由は、
// 組み立てる値にもともと入れないが、余計なキーが紛れたときにも返さないため（INV-3）。
// ログは出さない。
import { type PublicBookingLabel, PublicCalendar, type ReservationStatus } from "@zebra/contracts";
import { Hono } from "hono";
import { DateTime } from "luxon";
import { z } from "zod";
import {
  JST,
  type OccupiedInterval,
  type ReservationStore,
  malformed,
  readOccupiedIntervals,
} from "../db/reservations.ts";

/**
 * 予約状況を返す期間。JST の日付（YYYY-MM-DD）で、from と to の両端を含む。
 * 呼ぶ側（ルート）で形を確かめてから渡す（from が to より後のものは渡さない。INV-4）
 */
export interface PublicCalendarPeriod {
  readonly from: string;
  readonly to: string;
}

/**
 * 期間の予約状況を、DB の日ごとのアイテムから組み立てる。
 * - `days` は期間のすべての日を、日付の順に1件ずつ持つ（予約のない日は `bookings` が空）
 * - 各日の `bookings` は、その日（JST）に予約区間がかかる予約・ブロック枠。日をまたぐものは、かかる日それぞれに同じ時間で入る
 */
export async function readPublicCalendar(
  store: ReservationStore,
  period: PublicCalendarPeriod,
): Promise<PublicCalendar> {
  const dates = datesOf(period);
  // 期間の日ごとのアイテムに入っている占有区間（日をまたぐものも1件）。予約区間は占有区間に含まれるので、
  // 予約区間が期間のどこかの日にかかるものは、必ずここに入っている
  const intervals = await readOccupiedIntervals(store, period);
  const bookings = intervals.map(toPublicBooking).sort(byTime);

  const days = dates.map((date) => {
    const dayStart = DateTime.fromISO(date, { zone: JST });
    const dayEnd = dayStart.plus({ days: 1 });
    return {
      date,
      // 予約区間 [start, end) が、その日 [0:00, 翌0:00) と重なるもの（半開区間。バッファだけがかかる日には出さない）
      bookings: bookings
        .filter(
          (booking) =>
            booking.start.toMillis() < dayEnd.toMillis() &&
            dayStart.toMillis() < booking.end.toMillis(),
        )
        .map((booking) => ({
          label: booking.label,
          start: jstIso(booking.start),
          end: jstIso(booking.end),
        })),
    };
  });

  return PublicCalendar.parse({ days });
}

/** 返す前の、予約区間と表示名 */
interface ReservedRange {
  readonly label: PublicBookingLabel;
  readonly start: DateTime;
  readonly end: DateTime;
}

/**
 * 状態から表示名へ（booking.md「空き判定」）。承認待ちかどうかは表示名に出さない。
 * 取消・終了は枠を確保しないので、日ごとのアイテムには入らないはず。入っていたら undefined
 */
function labelOf(status: ReservationStatus): PublicBookingLabel | undefined {
  switch (status) {
    case "pending-provisional":
    case "provisional":
      return "provisional";
    case "pending-firm":
    case "firm":
      return "firm";
    case "pending-second-hold":
    case "second-hold":
      return "second-hold";
    case "cancelled":
    case "ended":
      return undefined;
  }
}

/**
 * 占有区間を、表示名と予約区間（占有区間の終わり − bufferMinutes）に直す。
 * bufferMinutes がない区間（bufferMinutes を書く前の古い区間）は、予約区間がわからないので、推測せずにエラーにする。
 * 取消・終了の状態が日ごとのアイテムに入っているのも、形が不正としてエラーにする（枠を確保しない状態は入らないはず）
 */
function toPublicBooking(interval: OccupiedInterval): ReservedRange {
  const where = `DAY の intervals（${interval.kind}#${interval.id}）`;
  if (interval.bufferMinutes === undefined) throw malformed(where, "bufferMinutes");
  const end = interval.end.minus({ minutes: interval.bufferMinutes });
  if (end.toMillis() <= interval.start.toMillis()) throw malformed(where, "bufferMinutes");

  const label =
    interval.kind === "block"
      ? "unavailable"
      : interval.status === undefined
        ? undefined
        : labelOf(interval.status);
  if (label === undefined) throw malformed(where, "status");
  return { label, start: interval.start, end };
}

/** 開始の早い順。開始が同じなら終わりの早い順（booking.md「空き判定」）。それも同じなら表示名の順（並びを決まった形にするため） */
function byTime(a: ReservedRange, b: ReservedRange): number {
  return (
    a.start.toMillis() - b.start.toMillis() ||
    a.end.toMillis() - b.end.toMillis() ||
    a.label.localeCompare(b.label)
  );
}

/** 表示用の ISO 8601（JST のオフセット付き。INV-7） */
function jstIso(dateTime: DateTime): string {
  const iso = dateTime.setZone(JST).toISO({ suppressMilliseconds: true });
  if (iso === null) throw new RangeError("日時が不正");
  return iso;
}

/** 期間の JST の日付の一覧（両端を含む）。日付の形が不正か、from が to より後なら RangeError */
function datesOf(period: PublicCalendarPeriod): string[] {
  const first = parseDate(period.from);
  const last = parseDate(period.to);
  if (last.toMillis() < first.toMillis()) throw new RangeError("期間の from が to より後");
  const dates: string[] = [];
  for (let day = first; day.toMillis() <= last.toMillis(); day = day.plus({ days: 1 })) {
    const date = day.toISODate();
    if (date === null) throw new RangeError("日付が不正");
    dates.push(date);
  }
  return dates;
}

function parseDate(value: string): DateTime {
  const parsed = IsoDate.safeParse(value);
  const day = parsed.success ? DateTime.fromISO(parsed.data, { zone: JST }) : null;
  if (day === null || !day.isValid) throw new RangeError("日付は YYYY-MM-DD");
  return day;
}

/** JST の日付（YYYY-MM-DD。存在しない日付は通さない） */
const IsoDate = z.iso.date();

/** クエリの期間（INV-4。境界でパースする）。from・to はどちらも必須で、from は to 以前 */
const PeriodQuery = z
  .object({ from: IsoDate, to: IsoDate })
  // YYYY-MM-DD の文字列どうしは、文字列の順が日付の順と同じ
  .refine((query) => query.from <= query.to, { message: "from が to より後" });

/**
 * 予約状況を返す Hono のルート。`GET /calendar?from=YYYY-MM-DD&to=YYYY-MM-DD`
 * - 成功：200 と `PublicCalendar` の JSON
 * - 期間の指定がおかしい（from・to がない、日付の形が不正、from が to より後）：400
 */
export function createPublicCalendarRoute(store: ReservationStore): Hono {
  const route = new Hono();
  route.get("/calendar", async (c) => {
    const query = PeriodQuery.safeParse({ from: c.req.query("from"), to: c.req.query("to") });
    if (!query.success) {
      // 入力の値はそのまま返さない
      return c.json({ error: "invalid-period" }, 400);
    }
    const calendar = await readPublicCalendar(store, query.data);
    return c.json(PublicCalendar.parse(calendar));
  });
  return route;
}
