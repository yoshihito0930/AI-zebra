import { DateTime } from "luxon";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createAdminApi } from "./api.ts";
import { App } from "./App.tsx";
import { createCopier } from "./clipboard.ts";

const root = document.getElementById("root");
if (!root) throw new Error("#root が見つからない");

// 管理 API は同じオリジンの /admin（手元では Vite の dev サーバーが API へ中継する。vite.config.ts）
const api = createAdminApi((input, init) => fetch(input, init));

/**
 * クリップボード（下書きのコピー）。ClipboardItem や navigator.clipboard がない環境（http の別のホスト、古いブラウザ）では
 * undefined になり、テキストだけのコピーか、本文を選んでコピーする案内になる（clipboard.ts）
 */
const copier = createCopier({
  clipboard: typeof navigator.clipboard === "undefined" ? undefined : navigator.clipboard,
  ClipboardItem: typeof ClipboardItem === "undefined" ? undefined : ClipboardItem,
});

/**
 * 現在時刻（INV-7）。本来は時計の部品（packages/clock）から取るが、まだ中身がないので、
 * 管理画面で現在時刻を取る所をこの1か所に決める（apps/api の app.ts と同じ）。部品には関数として渡し、テストでは固定する
 */
const now = (): DateTime => DateTime.now();

createRoot(root).render(
  <StrictMode>
    <App api={api} now={now} copier={copier} />
  </StrictMode>,
);
