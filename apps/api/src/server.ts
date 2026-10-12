// ローカルで API を動かす入口。使い方：pnpm --filter @zebra/api dev
import { serve } from "@hono/node-server";
import { app } from "./app.ts";

const port = Number(process.env["PORT"] ?? 8787);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`API: http://localhost:${info.port}`);
});
