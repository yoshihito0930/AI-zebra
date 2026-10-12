// 予約API の本体。ローカルでは server.ts（Node サーバー）、本番では lambda.ts（Lambda）から同じ app を動かす
import { Hono } from "hono";

export const app = new Hono();

// 動作確認用。予約の内容や個人情報は返さない（INV-3）
app.get("/health", (c) => c.json({ status: "ok" }));
