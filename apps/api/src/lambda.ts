// 本番（Lambda + API Gateway HTTP API）で API を動かす入口
// 管理 API の管理者の id は、API Gateway の JWT オーソライザーが確かめたトークンの sub（admin-api.md「認証」）。
// 環境変数 DEV_ADMIN_USER_ID は読まない（本番で仮の管理者が効かないように）
// 下書きの担当者名と署名は、Lambda の環境変数 MAIL_STAFF_NAME・MAIL_SIGNATURE（admin-api.md「担当者名と署名の設定」）
// 受付通知と管理者への通知は SES で送る（notifications.md「部品」）。管理者への通知のあて先と管理画面の URL は、
// Lambda の環境変数 MAIL_ADMIN_TO・ADMIN_APP_URL（notifications.md「設定」）
import { handle } from "hono/aws-lambda";
import { adminUserIdFromLambdaContext } from "./admin/admin-user.ts";
import { createApp, storeFromEnvironment } from "./app.ts";
import { createSesMailSender } from "./mail/ses-sender.ts";
import { mailSettingsFromEnv } from "./mail/settings-env.ts";

export const handler = handle(
  createApp(
    storeFromEnvironment(process.env),
    adminUserIdFromLambdaContext,
    mailSettingsFromEnv(process.env),
    createSesMailSender(),
  ),
);
