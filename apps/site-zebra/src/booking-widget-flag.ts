// 予約ページ（/reservation/）に予約ウィジェットを出すかの切り替え（機能フラグ）。
// docs/product-specs/index.md の「リリースの進め方」：新HPの公開（手順2）では今の仕組み（Googleカレンダーの埋め込みと
// form.run の予約フォーム）を載せ、期間をあけて（手順4）ウィジェットを有効にする。
// 組み立て（astro build・astro dev）のときの環境変数 PUBLIC_BOOKING_WIDGET_ENABLED で決める。本番の値は、AWS の準備のときに組み立ての設定に入れる

/** 切り替えの環境変数の名前 */
export const BOOKING_WIDGET_FLAG = "PUBLIC_BOOKING_WIDGET_ENABLED";

/**
 * 環境変数の値から、ウィジェットを出すかを決める。
 * - `true`：ウィジェットを出す
 * - ない・空・`false`：今の仕組みを出す
 * - それ以外（`TRUE`、`1`、`yes`、打ち間違いなど）：組み立てを止める。思っていたのと逆のページを公開しないため
 */
export function isBookingWidgetEnabled(value: string | undefined): boolean {
  if (value === "true") return true;
  if (value === undefined || value === "" || value === "false") return false;
  throw new Error(
    `${BOOKING_WIDGET_FLAG} は true か false（ない・空は false）で指定する。今の値：${JSON.stringify(value)}`,
  );
}
