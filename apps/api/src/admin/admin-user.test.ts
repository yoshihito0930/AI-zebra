import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AdminUserIdSource,
  adminUserIdFromLambdaContext,
  devAdminUserId,
} from "./admin-user.ts";

// 管理者の id の取り出し方の単体テスト。
// 根拠：docs/design-docs/admin-api.md「認証」（本番は API Gateway の JWT オーソライザーが確かめたトークンの sub、
// 手元は環境変数 DEV_ADMIN_USER_ID の管理者。lambda.ts は DEV_ADMIN_USER_ID を読まない）、
// hono/aws-lambda の handle が c.env に渡すリクエストの文脈（event・requestContext・lambdaContext）。
// ルートにつないだときの 401 と履歴の「誰が」は routes.int.test.ts、入口（lambda.ts・server.ts）は entrypoints.test.ts。

afterEach(() => {
  vi.unstubAllEnvs();
});

/** 取り出した id を JSON で返すだけのアプリで、取り出し方を確かめる */
async function idFrom(source: AdminUserIdSource, env?: object): Promise<unknown> {
  const app = new Hono().get("/", (c) => c.json({ id: source(c) ?? null }));
  const res = await app.request("/", {}, env);
  return ((await res.json()) as { id: unknown }).id;
}

/** API Gateway HTTP API の JWT オーソライザーが確かめたクレーム（claims）を持つ、リクエストの文脈 */
function lambdaEnv(authorizer: object) {
  const requestContext = {
    accountId: "000000000000",
    apiId: "kaku-api",
    authentication: null,
    authorizer,
    domainName: "kaku-api.example.com",
    domainPrefix: "kaku-api",
    http: {
      method: "GET",
      path: "/",
      protocol: "HTTP/1.1",
      sourceIp: "192.0.2.1",
      userAgent: "test",
    },
    requestId: "kaku-request",
    routeKey: "$default",
    stage: "$default",
    time: "05/Oct/2026:00:00:00 +0000",
    timeEpoch: 0,
  };
  return { event: { version: "2.0", requestContext }, requestContext, lambdaContext: {} };
}

const jwt = (claims: Record<string, unknown>) => ({ jwt: { claims, scopes: null } });

describe("管理者の id：本番（Lambda）の取り出し方（adminUserIdFromLambdaContext）", () => {
  it("JWT オーソライザーのクレームの sub を返す（ほかのクレームは使わない）", async () => {
    expect(
      await idFrom(
        adminUserIdFromLambdaContext,
        lambdaEnv(jwt({ sub: "cognito-sub-kaku-0001", email: "admin.kaku@example.com" })),
      ),
    ).toBe("cognito-sub-kaku-0001");
  });

  it.each([
    ["リクエストの文脈がない（Lambda の外）", undefined],
    ["オーソライザーがない", lambdaEnv({})],
    ["クレームに sub がない", lambdaEnv(jwt({ email: "admin.kaku@example.com" }))],
    ["sub が空", lambdaEnv(jwt({ sub: "" }))],
    ["sub が文字列でない", lambdaEnv(jwt({ sub: 12_345 }))],
  ])("%s：id なし", async (_, env) => {
    expect(await idFrom(adminUserIdFromLambdaContext, env)).toBeNull();
  });

  it("環境変数に DEV_ADMIN_USER_ID があっても、クレームがなければ id なし（本番で仮の管理者は効かない）", async () => {
    vi.stubEnv("DEV_ADMIN_USER_ID", "dev-admin-kaku-env");

    expect(await idFrom(adminUserIdFromLambdaContext, lambdaEnv({}))).toBeNull();
    expect(await idFrom(adminUserIdFromLambdaContext)).toBeNull();
  });

  it("環境変数に DEV_ADMIN_USER_ID があっても、クレームの sub を使う", async () => {
    vi.stubEnv("DEV_ADMIN_USER_ID", "dev-admin-kaku-env");

    expect(
      await idFrom(adminUserIdFromLambdaContext, lambdaEnv(jwt({ sub: "cognito-sub-kaku-0002" }))),
    ).toBe("cognito-sub-kaku-0002");
  });
});

describe("管理者の id：手元（Node サーバー）の取り出し方（devAdminUserId）", () => {
  it("渡した値（server.ts が DEV_ADMIN_USER_ID から読んだもの）を、どのリクエストでも返す", async () => {
    const source = devAdminUserId("dev-admin-kaku");

    expect(await idFrom(source)).toBe("dev-admin-kaku");
    expect(await idFrom(source, lambdaEnv({}))).toBe("dev-admin-kaku");
  });

  it.each([
    ["値がない", undefined],
    ["値が空", ""],
  ])("%s：id なし", async (_, value) => {
    expect(await idFrom(devAdminUserId(value))).toBeNull();
  });

  it("渡した値だけを使う：値がないときは、環境変数に DEV_ADMIN_USER_ID があっても id なし（環境変数を読むのは server.ts）", async () => {
    vi.stubEnv("DEV_ADMIN_USER_ID", "dev-admin-kaku-env");

    expect(await idFrom(devAdminUserId(undefined))).toBeNull();
  });
});
