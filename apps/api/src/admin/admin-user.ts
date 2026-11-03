// 管理者の id の取り出し方（docs/design-docs/admin-api.md「認証」）。
// - 本番（Lambda）：API Gateway の JWT オーソライザーが確かめたトークンの sub。API 自身はトークンを確かめない
// - 手元（Node サーバー）：環境変数 DEV_ADMIN_USER_ID に書いた管理者。環境変数を読むのは server.ts だけで、
//   server.ts が読んだ値を devAdminUserId に渡す（lambda.ts は読まない）
// 管理 API のルート（routes.ts の createAdminRoute）に、どちらかを渡す。取れないときは undefined を返し、ルートは 401 にする
import type { Context } from "hono";

/** リクエストから管理者の id を取り出す。取れないとき（空の文字列を含む）は undefined */
export type AdminUserIdSource = (c: Context) => string | undefined;

/**
 * 本番（Lambda）：hono/aws-lambda の handle が c.env に渡すリクエストの文脈
 * （requestContext.authorizer.jwt.claims。API Gateway HTTP API の JWT オーソライザーが確かめたもの）から、sub を取り出す。
 * 環境変数（DEV_ADMIN_USER_ID を含む）は読まない
 */
export function adminUserIdFromLambdaContext(c: Context): string | undefined {
  void c;
  throw new Error("未実装");
}

/** 手元（Node サーバー）：server.ts が環境変数 DEV_ADMIN_USER_ID から読んだ値の管理者として動く。値がない・空なら、どのリクエストも id なし */
export function devAdminUserId(userId: string | undefined): AdminUserIdSource {
  void userId;
  throw new Error("未実装");
}
