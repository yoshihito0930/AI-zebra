// ローカルで API を動かす入口。使い方：pnpm --filter @zebra/api dev
// 管理 API は、環境変数 DEV_ADMIN_USER_ID に書いた管理者として動く（Cognito なしで管理画面を作るため。admin-api.md「認証」）。
// DEV_ADMIN_USER_ID を読むのはこのファイルだけ（本番の lambda.ts は読まない）。ない・空なら、管理 API はどれも 401
// 下書きの担当者名と署名は、環境変数 MAIL_STAFF_NAME・MAIL_SIGNATURE（admin-api.md「担当者名と署名の設定」。lambda.ts と同じ）
// 受付通知と管理者への通知は送らずに、種類とあて先の有無だけを標準出力に出す（notifications.md「部品」）。
// 管理者への通知のあて先と管理画面の URL は、環境変数 MAIL_ADMIN_TO・ADMIN_APP_URL（notifications.md「設定」。lambda.ts と同じ）
import { serve } from "@hono/node-server";
import { devAdminUserId } from "./admin/admin-user.ts";
import { createApp, storeFromEnvironment } from "./app.ts";
import { createLocalMailSender } from "./mail/local-sender.ts";
import { mailSettingsFromEnv } from "./mail/settings-env.ts";

const app = createApp(
  storeFromEnvironment(process.env),
  devAdminUserId(process.env["DEV_ADMIN_USER_ID"]),
  mailSettingsFromEnv(process.env),
  createLocalMailSender(),
);

const port = Number(process.env["PORT"] ?? 8787);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`API: http://localhost:${info.port}`);
});
