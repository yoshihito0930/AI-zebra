// メールの文面の共通の部品（入出力を持たない関数）。下書き（draft-mail.ts）と、受付通知・管理者への通知
// （notification-mail.ts）が使う。同じ書き方を2か所に書かないため、ここにまとめる。
// - 日時の書き方：docs/product-specs/mail.md「日時の書き方」。日時はすべて JST で書く（INV-7。日時ライブラリは Luxon）
// - 件名の終わり：「（スタジオゼブラ）」
// - 差し込む値（{氏名} など）の置き換えと、設定（担当者名・署名・URL）の「ない」の扱い
import type { DateTime } from "luxon";

const JST = "Asia/Tokyo";

/** 曜日（Luxon の weekday は 1 が月曜、7 が日曜） */
const WEEKDAYS = ["月", "火", "水", "木", "金", "土", "日"] as const;

/** 件名はどれも「…（スタジオゼブラ）」で終わる（mail.md「日時の書き方」「管理者への新しい申込の通知」） */
export const SUBJECT_SUFFIX = "（スタジオゼブラ）";

/** JST に直す（INV-7）。どのゾーンで渡しても同じ時点の JST */
export function inJst(dateTime: DateTime): DateTime {
  const jst = dateTime.setZone(JST);
  if (!jst.isValid) throw new RangeError("日時が不正");
  return jst;
}

export function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** 曜日の1文字（「火」） */
export function weekdayOf(dateTime: DateTime): string {
  const weekday = WEEKDAYS[dateTime.weekday - 1];
  if (weekday === undefined) throw new RangeError("曜日が不正");
  return weekday;
}

/** 時は0を付けず、分は2桁（「9時00分」） */
function clockText(dateTime: DateTime): string {
  return `${dateTime.hour}時${pad2(dateTime.minute)}分`;
}

/**
 * {予約日時}：「2026年10月20日(火) 15時00分〜17時00分」。
 * 終わりが開始の次の日（JST）なら、終わりの前に「翌」を付ける（0時ちょうどに終わるときも「翌0時00分」）
 */
export function reservationTimeText(start: DateTime, end: DateTime): string {
  const s = inJst(start);
  const e = inJst(end);
  const nextDay = e.startOf("day").toMillis() > s.startOf("day").toMillis();
  return (
    `${s.year}年${s.month}月${s.day}日(${weekdayOf(s)}) ${clockText(s)}` +
    `〜${nextDay ? "翌" : ""}${clockText(e)}`
  );
}

/** {利用時間}：「2時間」「2時間30分」 */
export function durationText(start: DateTime, end: DateTime): string {
  const minutes = Math.round((end.toMillis() - start.toMillis()) / 60_000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}分`;
  return rest === 0 ? `${hours}時間` : `${hours}時間${rest}分`;
}

/** 設定の値（担当者名・署名・URL）。ない・空なら undefined（設定がないときと同じに扱う。mail.md「差し込む値」） */
export function settingOf(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

/** 差し込む値の名前（{氏名} なら「氏名」）と、その値 */
export type PlaceholderValues = ReadonlyMap<string, string>;

/** 差し込む値の印 */
const PLACEHOLDER_PATTERN = /\{([^{}]+)\}/gu;

/**
 * テンプレートの文字の中の {…} を、値に置き換える。置き換えるのはテンプレートの文字だけで、
 * 値の中の「{氏名}」のような文字は、そのまま文字として出る
 */
export function fillPlaceholders(template: string, values: PlaceholderValues): string {
  return template.replace(PLACEHOLDER_PATTERN, (_, name: string) => {
    const value = values.get(name);
    // テンプレートにある印は、どれも値を持つ（ない印はテンプレートの誤り）。印の名前だけを書き、値は書かない
    if (value === undefined) throw new Error(`テンプレートの差し込む値がない（${name}）`);
    return value;
  });
}
