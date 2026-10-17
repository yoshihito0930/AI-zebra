import type { DateTime } from "luxon";

// 仮予約の期限（docs/product-specs/booking.md の「用語」「申込の締め切り」）。
// 利用日（予約区間の開始日時の、JSTでの日付）の7日前の 18:00（JST）。判定は JST で行う（INV-7）。
// 申込の締め切りのほか、「仮予約から本予約へ」の警告、申込フォーム、管理者による直接入力の警告でも使う。
// 返す DateTime は時点として扱う（ゾーンは決めない。表示するときに Asia/Tokyo へ変換する）。
export function provisionalDeadline(start: DateTime): DateTime {
  void start;
  throw new Error("未実装");
}
