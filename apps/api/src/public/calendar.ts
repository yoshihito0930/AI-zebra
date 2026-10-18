// 公開API（認証なし）の予約状況（INV-3。docs/product-specs/booking.md「空き判定」、
// docs/design-docs/dynamodb-keys.md「読み出し」）。
// 期間の日ごとのアイテムを読み、入っている予約・ブロック枠を「表示名と時間（予約区間。バッファを含まない）」に直して返す。
// テストの PR（docs/TESTING.md の手順2）で形だけを決めたスタブ。中身は実装の PR で書く。
// app.ts へのつなぎ込み（例：app.route("/public", createPublicCalendarRoute(store))）も実装の PR で行う。
import type { PublicCalendar } from "@zebra/contracts";
import type { Hono } from "hono";
import type { ReservationStore } from "../db/reservations.ts";

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
  void store;
  void period;
  throw new Error("未実装");
}

/**
 * 予約状況を返す Hono のルート。`GET /calendar?from=YYYY-MM-DD&to=YYYY-MM-DD`
 * - 成功：200 と `PublicCalendar` の JSON
 * - 期間の指定がおかしい（from・to がない、日付の形が不正、from が to より後）：400
 */
export function createPublicCalendarRoute(store: ReservationStore): Hono {
  void store;
  throw new Error("未実装");
}
