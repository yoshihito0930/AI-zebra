import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// 管理 API が、本番（Lambda。lambda.ts）と手元（Node サーバー。server.ts）の入口に載っていて、
// 管理者の id の取り出し方がそれぞれ正しいことの確認。
// 根拠：docs/design-docs/admin-api.md「認証」（本番は API Gateway の JWT オーソライザーが確かめたトークンの sub、
// 手元は環境変数 DEV_ADMIN_USER_ID の管理者。DEV_ADMIN_USER_ID を読むのは server.ts だけで、lambda.ts は読まない。
// 管理者の id が取れないときは、どのルートも 401）。
// DB を読まずに答えが決まる要求で確かめる：期間の片方だけを渡した一覧は、管理者の id があれば 400（invalid-input）、
// なければ 401（unauthorized）。
// - lambda.ts は、hono/aws-lambda の handle で作った関数を handler として export する前提（Lambda の設定は lambda.handler）。
//   型には頼らず、読み込んだモジュールの handler を呼ぶ
// - server.ts は、apps/api/src/server.test.ts と同じく Node でそのまま起動する（PORT で待ち受ける）

const invalidListPath = "/admin/reservations";
const invalidListQuery = "from=2026-10-20";

/** 本文を JSON として読む。JSON でなければ文字列のまま返す（失敗したときに中身が見えるように） */
function parseBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

// ---- Lambda（lambda.ts） ----

interface LambdaResult {
  statusCode: number;
  body: string;
  isBase64Encoded?: boolean;
}

/** API Gateway HTTP API（ペイロード 2.0）のイベント。claims を渡すと、JWT オーソライザーが確かめたものとして入れる */
function httpApiEvent(claims?: Record<string, string>) {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: invalidListPath,
    rawQueryString: invalidListQuery,
    headers: { host: "kaku-api.example.com", "content-type": "application/json" },
    queryStringParameters: { from: "2026-10-20" },
    body: null,
    isBase64Encoded: false,
    requestContext: {
      accountId: "000000000000",
      apiId: "kaku-api",
      authentication: null,
      authorizer: claims === undefined ? {} : { jwt: { claims, scopes: null } },
      domainName: "kaku-api.example.com",
      domainPrefix: "kaku-api",
      http: {
        method: "GET",
        path: invalidListPath,
        protocol: "HTTP/1.1",
        sourceIp: "192.0.2.1",
        userAgent: "test",
      },
      requestId: "kaku-request",
      routeKey: "$default",
      stage: "$default",
      time: "05/Oct/2026:00:00:00 +0000",
      timeEpoch: 0,
    },
  };
}

const lambdaContext = {
  callbackWaitsForEmptyEventLoop: false,
  functionName: "kaku-api",
  functionVersion: "$LATEST",
  invokedFunctionArn: "arn:aws:lambda:ap-northeast-1:000000000000:function:kaku-api",
  memoryLimitInMB: "128",
  awsRequestId: "kaku-request",
  logGroupName: "/aws/lambda/kaku-api",
  logStreamName: "kaku-stream",
  getRemainingTimeInMillis: () => 30_000,
};

/** 環境変数を決めてから lambda.ts を読み込み直し、handler を呼ぶ */
async function invokeLambda(
  env: Record<string, string | undefined>,
  claims?: Record<string, string>,
): Promise<{ status: number; json: unknown }> {
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  vi.resetModules();
  const mod = (await import("../lambda.ts")) as unknown as { handler?: unknown };
  expect(typeof mod.handler).toBe("function");
  const handler = mod.handler as (event: unknown, context: unknown) => Promise<LambdaResult>;
  const result = await handler(httpApiEvent(claims), lambdaContext);
  const body =
    result.isBase64Encoded === true
      ? Buffer.from(result.body, "base64").toString("utf8")
      : result.body;
  return { status: result.statusCode, json: parseBody(body) };
}

describe("管理 API の入口：本番（Lambda。lambda.ts）", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("JWT オーソライザーが確かめたトークンの sub があれば、管理者として処理する（期間の片方だけの一覧は 400 と { error: invalid-input }）", async () => {
    expect(
      await invokeLambda({ DEV_ADMIN_USER_ID: undefined }, { sub: "cognito-sub-kaku-0001" }),
    ).toEqual({ status: 400, json: { error: "invalid-input" } });
  });

  it("クレームがない：401 と { error: unauthorized }", async () => {
    expect(await invokeLambda({ DEV_ADMIN_USER_ID: undefined })).toEqual({
      status: 401,
      json: { error: "unauthorized" },
    });
  });

  it("環境変数 DEV_ADMIN_USER_ID があっても、クレームがなければ 401 と { error: unauthorized }（lambda.ts は DEV_ADMIN_USER_ID を読まない。本番で仮の管理者は効かない）", async () => {
    expect(await invokeLambda({ DEV_ADMIN_USER_ID: "dev-admin-kaku-env" })).toEqual({
      status: 401,
      json: { error: "unauthorized" },
    });
  });
});

// ---- Node サーバー（server.ts） ----

const serverPath = path.resolve(import.meta.dirname, "..", "server.ts");
let child: ChildProcess | undefined;

function startServer(port: number, devAdminUserId: string | undefined): Promise<void> {
  const env: Record<string, string | undefined> = { ...process.env, PORT: String(port) };
  delete env["DEV_ADMIN_USER_ID"];
  if (devAdminUserId !== undefined) env["DEV_ADMIN_USER_ID"] = devAdminUserId;
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, [serverPath], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes(`localhost:${port}`)) resolve();
    });
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("exit", (code) =>
      reject(new Error(`API が起動せずに終わった（code ${code}）\n${stderr}`)),
    );
  });
}

async function requestServer(devAdminUserId: string | undefined) {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  await startServer(port, devAdminUserId);
  const res = await fetch(`http://localhost:${port}${invalidListPath}?${invalidListQuery}`);
  return { status: res.status, json: parseBody(await res.text()) };
}

describe("管理 API の入口：手元（Node サーバー。server.ts）", () => {
  afterEach(() => {
    child?.kill();
    child = undefined;
  });

  it("環境変数 DEV_ADMIN_USER_ID があれば、その管理者として処理する（期間の片方だけの一覧は 400 と { error: invalid-input }）", async () => {
    expect(await requestServer("dev-admin-kaku")).toEqual({
      status: 400,
      json: { error: "invalid-input" },
    });
  }, 20_000);

  it("環境変数 DEV_ADMIN_USER_ID がない：401 と { error: unauthorized }", async () => {
    expect(await requestServer(undefined)).toEqual({
      status: 401,
      json: { error: "unauthorized" },
    });
  }, 20_000);

  it("環境変数 DEV_ADMIN_USER_ID が空：401 と { error: unauthorized }", async () => {
    expect(await requestServer("")).toEqual({ status: 401, json: { error: "unauthorized" } });
  }, 20_000);
});
