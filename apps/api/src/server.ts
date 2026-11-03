// ローカルで API を動かす入口。使い方：pnpm --filter @zebra/api dev
// 管理 API は、環境変数 DEV_ADMIN_USER_ID に書いた管理者として動く（Cognito なしで管理画面を作るため。admin-api.md「認証」）。
// DEV_ADMIN_USER_ID を読むのはこのファイルだけ（本番の lambda.ts は読まない）。ない・空なら、管理 API はどれも 401
import { serve } from "@hono/node-server";
import { devAdminUserId } from "./admin/admin-user.ts";
import { createApp, storeFromEnvironment } from "./app.ts";

const app = createApp(
  storeFromEnvironment(process.env),
  devAdminUserId(process.env["DEV_ADMIN_USER_ID"]),
);

const port = Number(process.env["PORT"] ?? 8787);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`API: http://localhost:${info.port}`);
});
