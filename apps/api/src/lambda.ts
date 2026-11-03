// 本番（Lambda + API Gateway HTTP API）で API を動かす入口
// 管理 API の管理者の id は、API Gateway の JWT オーソライザーが確かめたトークンの sub（admin-api.md「認証」）。
// 環境変数 DEV_ADMIN_USER_ID は読まない（本番で仮の管理者が効かないように）
import { handle } from "hono/aws-lambda";
import { adminUserIdFromLambdaContext } from "./admin/admin-user.ts";
import { createApp, storeFromEnvironment } from "./app.ts";

export const handler = handle(
  createApp(storeFromEnvironment(process.env), adminUserIdFromLambdaContext),
);
