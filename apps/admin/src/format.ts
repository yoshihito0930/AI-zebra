// 画面に出す日時と金額の形（INV-7、INV-9）。API の日時は ISO 8601 のオフセット付きで来るので、JST に直して表示する
import { DateTime } from "luxon";

/** 表示と期間の判定に使うタイムゾーン（INV-7） */
export const JST = "Asia/Tokyo";

/** ISO 8601 の日時を、JST の DateTime にする。入力のオフセットが何であっても JST に直す */
export function toJst(iso: string): DateTime {
  const dateTime = DateTime.fromISO(iso, { zone: JST, locale: "ja" });
  if (!dateTime.isValid) throw new Error(`日時の形ではない：${iso}`);
  return dateTime;
}

/** 例：2026/11/20(金) 13:00 */
export function formatDateTime(iso: string): string {
  return toJst(iso).toFormat("yyyy/MM/dd(ccc) HH:mm");
}

/**
 * 予約区間・ブロック枠の区間。終わりが同じ日（JST）なら時刻だけを書く。
 * 例：2026/11/20(金) 13:00〜15:00、2026/11/20(金) 22:00〜11/21(土) 02:00
 */
export function formatTimeRange(startIso: string, endIso: string): string {
  const start = toJst(startIso);
  const end = toJst(endIso);
  const endText = start.hasSame(end, "day")
    ? end.toFormat("HH:mm")
    : end.toFormat("MM/dd(ccc) HH:mm");
  return `${start.toFormat("yyyy/MM/dd(ccc) HH:mm")}〜${endText}`;
}

const yenFormat = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 0 });

/** 整数の円（INV-9）。例：12,100円 */
export function formatYen(yen: number): string {
  if (!Number.isSafeInteger(yen)) throw new Error(`金額が整数の円ではない：${yen}`);
  return `${yenFormat.format(yen)}円`;
}

/** その時点の JST の月の初日と末日（YYYY-MM-DD）。一覧の期間の初期値 */
export function monthOf(now: DateTime): { from: string; to: string } {
  const inJst = now.setZone(JST);
  return {
    from: inJst.startOf("month").toISODate() ?? "",
    to: inJst.endOf("month").toISODate() ?? "",
  };
}

/** 開始の早い順（同じなら終わりの早い順、それも同じなら id の順）。API の並べ方と同じ */
export function compareByTime(
  a: { start: string; end: string; id: string },
  b: { start: string; end: string; id: string },
): number {
  return (
    toJst(a.start).toMillis() - toJst(b.start).toMillis() ||
    toJst(a.end).toMillis() - toJst(b.end).toMillis() ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}
