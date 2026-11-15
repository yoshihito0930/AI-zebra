// 本番（Lambda + API Gateway HTTP API）で API を動かす入口
// 管理 API の管理者の id は、API Gateway の JWT オーソライザーが確かめたトークンの sub（admin-api.md「認証」）。
// 環境変数 DEV_ADMIN_USER_ID は読まない（本番で仮の管理者が効かないように）
// 下書きの担当者名と署名は、Lambda の環境変数 MAIL_STAFF_NAME・MAIL_SIGNATURE（admin-api.md「担当者名と署名の設定」）
import { handle } from "hono/aws-lambda";
import { adminUserIdFromLambdaContext } from "./admin/admin-user.ts";
import { createApp, storeFromEnvironment } from "./app.ts";
import { mailSettingsFromEnv } from "./mail/settings-env.ts";

export const handler = handle(
  createApp(
    storeFromEnvironment(process.env),
    adminUserIdFromLambdaContext,
    mailSettingsFromEnv(process.env),
  ),
);
