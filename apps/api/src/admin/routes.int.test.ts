import {
  type AttributeValue,
  CreateTableCommand,
  DeleteTableCommand,
  GetItemCommand,
  QueryCommand,
  ScanCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  AdminOperationAccepted,
  AdminReceiptLookup,
  AdminRejected,
  AdminReservationDetail,
  AdminReservationList,
  PriceTable,
  Yen,
} from "@zebra/contracts";
import { DateTime } from "luxon";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveAdminBlock } from "../db/blocks.ts";
import { createLocalDynamoClient } from "../db/client.ts";
import { type DirectEntry, saveDirectEntry } from "../db/direct-entry.ts";
import { type ReservationOperationInput, saveReservationOperation } from "../db/operations.ts";
import {
  type ApplicationKind,
  type ReservationApplication,
  type ReservationStore,
  getReservation,
  saveApplication,
} from "../db/reservations.ts";
import { submitApplication } from "../public/applications.ts";
import {
  type AdminUserIdSource,
  adminUserIdFromLambdaContext,
  devAdminUserId,
} from "./admin-user.ts";
import { type AdminDeps, createAdminRoute } from "./routes.ts";

// 管理 API（1回目）のルートの統合テスト（DynamoDB Local）。
// 根拠：docs/design-docs/admin-api.md（認証、一覧・詳細、受付番号から探す、操作、返すときの決まり）、
// docs/product-specs/booking.md「予約の状態」（例の表のすべての行）「取消とキャンセル料」「料金」、
// reservation-model.md（状態と操作、金額、履歴）、dynamodb-keys.md（読み出し、下書きのアイテム）、
// core-beliefs.md（INV-4、INV-6、INV-7、INV-9、INV-10）、packages/contracts の admin.ts（返す本文は契約でパースできること）。
// 状態・枠・下書き・キャンセル料の細かい決まりは booking-core と保存の層のテストで確かめているので、
// ここでは代表的な場合と、それが API の返事（ステータス・本文）と DB に正しく現れることを確かめる。
// - 管理者の id の取り出し方は、ルートを作る関数（createAdminRoute）に渡す（本番は adminUserIdFromLambdaContext、
//   手元は devAdminUserId）。Lambda・Node の入口（lambda.ts・server.ts）の確認は entrypoints.test.ts
// - 操作が成功したときのステータスは資料にないので、2xx であることだけを確かめる
// - 却下・昇格・取消・繰り上げの本文は、契約（AdminEmptyRequest）どおり {} を送る。本文を付けない要求をどう扱うかは資料にないので扱わない
// - 終了した第二キープの詳細は扱わない（履歴の「誰が」がシステムになるが、契約の履歴の actor にシステムがない。PR に書いて質問する）
// - 2回目・3回目の操作（変更・直接入力・バッファの切り替え・ブロック枠・下書きの送信）は扱わない

const client = createLocalDynamoClient();
let store: ReservationStore;

// テーブルはキー設計どおり（pk・sk、GSI の gsi1pk・gsi1sk）にテストごとに作り、終わったら消す
async function createTable(): Promise<ReservationStore> {
  const tableName = `int-test-admin-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
        { AttributeName: "gsi1pk", AttributeType: "S" },
        { AttributeName: "gsi1sk", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: "gsi1",
          KeySchema: [
            { AttributeName: "gsi1pk", KeyType: "HASH" },
            { AttributeName: "gsi1sk", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
      ],
      BillingMode: "PAY_PER_REQUEST",
    }),
  );
  return { client, tableName };
}

beforeEach(async () => {
  store = await createTable();
});

afterEach(async () => {
  await client.send(new DeleteTableCommand({ TableName: store.tableName }));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// ---- 日時（INV-7）。テストの日時は JST で書く。現在時刻は固定する ----

function jst(iso: string): DateTime {
  const dateTime = DateTime.fromISO(iso, { zone: "Asia/Tokyo" });
  if (!dateTime.isValid) {
    throw new Error(`テストの日時が不正：${iso}`);
  }
  return dateTime;
}

/** 申込の時刻（固定） */
const appliedAt = jst("2026-10-01T12:00");
/** テストの準備でする承認・直接入力の時刻（固定） */
const preparedAt = jst("2026-10-02T12:00");
/** API の現在時刻（固定）。操作の日時になる */
const operatedAt = jst("2026-10-05T09:00");

/** API を呼ぶ管理者（架空のユーザー id） */
const adminUserId = "admin-user-kaku-api";
/** 準備の承認をした管理者（架空のユーザー id。API を呼ぶ管理者と見分けるため別にする） */
const preparingAdminUserId = "admin-user-kaku-prep";

/**
 * 返した日時の文字列が ISO 8601 で JST のオフセット（+09:00）付きであることを確かめ（admin-api.md「返すときの決まり」）、
 * 比べやすい JST の "yyyy-MM-ddTHH:mm" にする
 */
function local(value: unknown): string {
  expect(typeof value).toBe("string");
  const text = value as string;
  expect(text, text).toMatch(/\+09:00$/);
  const parsed = DateTime.fromISO(text, { setZone: true });
  expect(parsed.isValid, text).toBe(true);
  return parsed.toFormat("yyyy-MM-dd'T'HH:mm");
}

// ---- 料金表（booking.md「料金」の単価・追加・プランの決め方から作る） ----

const priceTableInput = {
  plans: [
    { id: "A", name: "プランA", halfHourRates: { normal: 2_500, lateNight: 3_750 } },
    { id: "B", name: "プランB", halfHourRates: { normal: 2_750, lateNight: 4_125 } },
  ],
  planRules: [
    { plan: "A", maxPartySize: 10 },
    { plan: "A", cycloramaFloorProtection: true },
    { plan: "B" },
  ],
  equipmentInsurance: 1_000,
  options: [
    { id: "workshop", name: "6人以上のワークショップでの利用", price: 2_000 },
    { id: "glitter", name: "ラメやグリッターを多用した衣装・小道具の持ち込み", price: 2_000 },
  ],
};
const specPriceTable = PriceTable.parse(priceTableInput);

// ---- 架空のお客様の情報（INV-10 の確認に使うので、ほかの値と紛れない文字列にする） ----

const customer = {
  name: "架空 管理花子",
  companyName: "架空管理株式会社",
  email: "kanri.kaku@example.com",
  phone: "090-0000-8642",
  address: "架空県架空市管理町8-6-4",
  photographerName: "仮名 管理撮影",
} as const;

const shooting = {
  types: ["still", "movie"],
  details: "架空の撮影詳細：管理画面の確認用の撮影",
  notes: "架空の補足事項：管理画面の確認用の補足",
} as const;

const personalValues: readonly string[] = [
  customer.name,
  customer.companyName,
  customer.email,
  customer.phone,
  customer.address,
  customer.photographerName,
  shooting.details,
  shooting.notes,
];

const nonNamePersonalValues = personalValues.filter((v) => v !== customer.name);

/** 申込（見積は 10,000円・税込 11,000円。今の料金表で計算し直したものと違えたいときは estimate で渡す） */
function application(
  kind: ApplicationKind,
  start: string,
  end: string,
  overrides: Partial<ReservationApplication> = {},
): ReservationApplication {
  return {
    kind,
    start: jst(start),
    end: jst(end),
    partySize: 4,
    cycloramaFloorProtection: false,
    planId: "A",
    equipmentInsurance: false,
    optionIds: [],
    estimate: {
      subtotalExcludingTax: Yen.parse(10_000),
      estimateIncludingTax: Yen.parse(11_000),
    },
    customer,
    shooting,
    ...overrides,
  };
}

// ---- 準備の道具（保存の層の関数で作る） ----

async function apply(
  kind: ApplicationKind,
  start: string,
  end: string,
  overrides: Partial<ReservationApplication> = {},
): Promise<string> {
  const result = await saveApplication(store, application(kind, start, end, overrides), {
    now: appliedAt,
  });
  if (!result.ok) {
    throw new Error(`準備の申込が不可になった（${kind} ${start}–${end}、${result.reason}）`);
  }
  return result.id;
}

async function prepareOperation(
  operation: ReservationOperationInput,
  now: DateTime = preparedAt,
): Promise<void> {
  const result = await saveReservationOperation(store, operation, {
    now,
    adminUserId: preparingAdminUserId,
  });
  if (!result.ok) {
    throw new Error(`準備の操作が不可になった（${operation.kind}、${result.reason}）`);
  }
}

/** 申込して承認する（準備）。確定金額は、指定がなければ 22,000円 */
async function applyApproved(
  kind: ApplicationKind,
  start: string,
  end: string,
  confirmedPrice = 22_000,
): Promise<string> {
  const id = await apply(kind, start, end);
  await prepareOperation({
    kind: "approve",
    reservationId: id,
    confirmedPrice: Yen.parse(confirmedPrice),
  });
  return id;
}

/**
 * お客様がフォームから申込む（公開API の申込。受付番号のアイテム RCPT#<受付番号> ができるのはこの経路だけ）。
 * 人数4人・養生なし（プランA）、機材保険なし、オプションなし。見積は料金表（specPriceTable）で計算される
 */
async function applyViaForm(
  kind: "firm" | "provisional" | "second-hold",
  start: string,
  end: string,
): Promise<{ id: string; receiptNumber: string }> {
  const before = await reservationIds();
  const result = await submitApplication(
    { store, now: () => appliedAt, priceTable: specPriceTable },
    {
      kind,
      start: jst(start).toISO(),
      end: jst(end).toISO(),
      partySize: 4,
      cycloramaFloorProtection: false,
      equipmentInsurance: false,
      optionIds: [],
      customer: { ...customer },
      shooting: { ...shooting, types: [...shooting.types] },
      agreedToCycloramaRules: true,
      agreedToTerms: true,
    },
  );
  if (!result.ok) {
    throw new Error(
      `準備のフォームの申込が不可になった（${kind} ${start}–${end}、${result.reason}）`,
    );
  }
  const added = (await reservationIds()).filter((id) => !before.includes(id));
  expect(added).toHaveLength(1);
  return { id: added[0] ?? "", receiptNumber: result.accepted.receiptNumber };
}

/** 管理者が直接入れる本予約（電話で受けたので、お客様の情報は氏名と電話番号だけ）。見積 27,500円、確定金額 26,000円 */
async function enterFirm(start: string, end: string): Promise<string> {
  const entry: DirectEntry = {
    kind: "firm",
    start: jst(start),
    end: jst(end),
    partySize: 3,
    cycloramaFloorProtection: true,
    planId: "A",
    equipmentInsurance: true,
    optionIds: [],
    estimate: {
      subtotalExcludingTax: Yen.parse(25_000),
      estimateIncludingTax: Yen.parse(27_500),
    },
    confirmedPrice: Yen.parse(26_000),
    customer: { name: "架空 電話三郎", phone: "090-0000-1357" },
    shooting: {},
  };
  const result = await saveDirectEntry(store, entry, {
    now: preparedAt,
    adminUserId: preparingAdminUserId,
  });
  if (!result.ok) {
    throw new Error(`準備の直接入力が不可になった（${result.reason}）`);
  }
  return result.id;
}

// ---- API を呼ぶ道具 ----

function deps(overrides: Partial<AdminDeps> = {}): AdminDeps {
  return {
    store,
    now: () => operatedAt,
    priceTable: specPriceTable,
    adminUserId: () => adminUserId,
    ...overrides,
  };
}

async function get(path: string, overrides: Partial<AdminDeps> = {}): Promise<Response> {
  return createAdminRoute(deps(overrides)).request(path);
}

/** POST する。body が文字列ならそのまま本文にし、それ以外は JSON にする。既定は {}（AdminEmptyRequest） */
async function post(
  path: string,
  body: unknown = {},
  overrides: Partial<AdminDeps> = {},
): Promise<Response> {
  return createAdminRoute(deps(overrides)).request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** 成功（2xx）の JSON を返す */
async function okJson(res: Response): Promise<unknown> {
  const text = await res.text();
  expect(res.status, text).toBeGreaterThanOrEqual(200);
  expect(res.status, text).toBeLessThan(300);
  expect(res.headers.get("content-type") ?? "").toContain("application/json");
  return JSON.parse(text) as unknown;
}

/** エラーの応答が、ステータスと { error: <理由> }（AdminRejected）であることを確かめる */
async function expectError(res: Response, status: number, error: string): Promise<void> {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type") ?? "").toContain("application/json");
  const json: unknown = await res.json();
  expect(AdminRejected.safeParse(json).success).toBe(true);
  expect(json).toEqual({ error });
}

/** 操作が成功したときの返事が AdminOperationAccepted を通ることを確かめ、下書きを返す */
async function acceptedDrafts(res: Response): Promise<AdminOperationAccepted["drafts"]> {
  const json = await okJson(res);
  const parsed = AdminOperationAccepted.safeParse(json);
  expect(parsed.success, JSON.stringify(json)).toBe(true);
  return parsed.success ? parsed.data.drafts : [];
}

/** 下書きの並び順は決めていないので、件数と中身で比べる */
function expectDrafts(actual: readonly unknown[], expected: readonly unknown[]): void {
  expect(actual).toHaveLength(expected.length);
  expect(actual).toEqual(expect.arrayContaining([...expected]));
}

async function detailJson(id: string, overrides: Partial<AdminDeps> = {}) {
  const json = await okJson(await get(`/admin/reservations/${id}`, overrides));
  const parsed = AdminReservationDetail.safeParse(json);
  expect(parsed.success, JSON.stringify(json)).toBe(true);
  if (!parsed.success) throw new Error("AdminReservationDetail を通らない");
  return parsed.data;
}

async function listJson(query: string, overrides: Partial<AdminDeps> = {}) {
  const json = await okJson(await get(`/admin/reservations?${query}`, overrides));
  const parsed = AdminReservationList.safeParse(json);
  expect(parsed.success, JSON.stringify(json)).toBe(true);
  if (!parsed.success) throw new Error("AdminReservationList を通らない");
  return parsed.data;
}

// ---- テーブルを直接読む道具 ----

function plain(value: AttributeValue): unknown {
  if (value.S !== undefined) return value.S;
  if (value.N !== undefined) return Number(value.N);
  if (value.BOOL !== undefined) return value.BOOL;
  if (value.NULL !== undefined) return null;
  if (value.L !== undefined) return value.L.map(plain);
  if (value.M !== undefined) return plainItem(value.M);
  if (value.SS !== undefined) return [...value.SS];
  if (value.NS !== undefined) return value.NS.map(Number);
  throw new Error(`テストで扱わない属性の形：${JSON.stringify(value)}`);
}

type PlainItem = Record<string, unknown>;

function plainItem(item: Record<string, AttributeValue>): PlainItem {
  return Object.fromEntries(Object.entries(item).map(([key, value]) => [key, plain(value)]));
}

function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(stringsIn);
  return [];
}

async function scanAll(): Promise<PlainItem[]> {
  const items: PlainItem[] = [];
  let startKey: Record<string, AttributeValue> | undefined;
  do {
    const res = await client.send(
      new ScanCommand({
        TableName: store.tableName,
        ConsistentRead: true,
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...(res.Items ?? []).map(plainItem));
    startKey = res.LastEvaluatedKey;
  } while (startKey !== undefined);
  return items;
}

function itemKey(item: PlainItem): string {
  return `${String(item["pk"])} ${String(item["sk"])}`;
}

/** できない操作で、テーブルの中身が何も変わっていないことを確かめる */
async function expectNothingWritten(before: readonly PlainItem[]): Promise<void> {
  const sorted = (items: readonly PlainItem[]) =>
    [...items].sort((x, y) => itemKey(x).localeCompare(itemKey(y)));
  expect(sorted(await scanAll())).toEqual(sorted(before));
}

/** 日ごとのアイテムにある占有区間の id（枠を確保している予約・ブロック枠） */
async function idsHolding(day: string): Promise<string[]> {
  const res = await client.send(
    new GetItemCommand({
      TableName: store.tableName,
      Key: { pk: { S: `DAY#${day}` }, sk: { S: "META" } },
      ConsistentRead: true,
    }),
  );
  if (res.Item === undefined) return [];
  const intervals = plainItem(res.Item)["intervals"] as PlainItem[];
  return intervals.map((i) => String(i["id"]));
}

async function unsentDraftCount(): Promise<number> {
  const res = await client.send(
    new QueryCommand({
      TableName: store.tableName,
      IndexName: "gsi1",
      KeyConditionExpression: "gsi1pk = :pk",
      ExpressionAttributeValues: { ":pk": { S: "DRAFT#UNSENT" } },
    }),
  );
  return (res.Items ?? []).length;
}

/** 保存された予約の id（RES#<id> / META のアイテムから） */
async function reservationIds(): Promise<string[]> {
  return (await scanAll())
    .filter((item) => String(item["pk"]).startsWith("RES#") && item["sk"] === "META")
    .map((item) => String(item["pk"]).slice("RES#".length));
}

/** フォームの申込の受付番号（その予約を指す RCPT#<受付番号> のアイテムから） */
async function receiptOf(id: string): Promise<string> {
  const receipts = (await scanAll()).filter(
    (item) => String(item["pk"]).startsWith("RCPT#") && stringsIn(item).includes(id),
  );
  expect(receipts).toHaveLength(1);
  return String(receipts[0]?.["pk"]).slice("RCPT#".length);
}

/** ほかの書き込みがあったことにする：日ごとのアイテムの版番号を1増やす */
async function bumpDay(day: string): Promise<void> {
  await client.send(
    new UpdateItemCommand({
      TableName: store.tableName,
      Key: { pk: { S: `DAY#${day}` }, sk: { S: "META" } },
      UpdateExpression:
        "SET version = if_not_exists(version, :zero) + :one, intervals = if_not_exists(intervals, :empty)",
      ExpressionAttributeValues: {
        ":zero": { N: "0" },
        ":one": { N: "1" },
        ":empty": { L: [] },
      },
    }),
  );
}

// ---- Lambda のリクエストの文脈（hono/aws-lambda の handle が c.env に渡すもの） ----

/** API Gateway HTTP API の JWT オーソライザーが確かめたクレーム（claims）を持つ、リクエストの文脈 */
function lambdaEnv(claims?: Record<string, string>) {
  const requestContext = {
    accountId: "000000000000",
    apiId: "kaku-api",
    authentication: null,
    authorizer: claims === undefined ? {} : { jwt: { claims, scopes: null } },
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

async function requestWithEnv(
  source: AdminUserIdSource,
  path: string,
  init: RequestInit,
  env: object,
): Promise<Response> {
  return createAdminRoute(deps({ adminUserId: source })).request(path, init, env);
}

const approveInit = (confirmedPrice: number): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ confirmedPrice }),
});

// ---- テスト ----

describe("管理 API：予約の一覧（GET /admin/reservations）", () => {
  it("?from=2026-10-20&to=2026-10-21：200 と JSON。AdminReservationList を通り、期間の日にかかる予約とブロック枠を開始の早い順に返す。日時は JST のオフセット付き。個人情報は氏名だけ。受付番号はフォームの申込だけ", async () => {
    const { id: a, receiptNumber } = await applyViaForm(
      "firm",
      "2026-10-20T10:00",
      "2026-10-20T12:00",
    );
    const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    const k = await applyApproved("second-hold", "2026-10-20T14:00", "2026-10-20T17:00");
    const d = await enterFirm("2026-10-21T10:00", "2026-10-21T12:00");
    const blockResult = await saveAdminBlock(store, {
      start: jst("2026-10-21T15:00"),
      end: jst("2026-10-21T16:00"),
      bufferMinutes: 30,
      memo: "架空のメモ：清掃",
    });
    if (!blockResult.ok) throw new Error("準備のブロック枠が不可になった");
    await applyApproved("firm", "2026-10-22T10:00", "2026-10-22T12:00");

    const res = await get("/admin/reservations?from=2026-10-20&to=2026-10-21");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    const text = await res.text();
    const parsed = AdminReservationList.safeParse(JSON.parse(text));
    expect(parsed.success, text).toBe(true);
    if (!parsed.success) return;
    const list = parsed.data;
    expect(
      list.reservations.map((r) => ({ ...r, start: local(r.start), end: local(r.end) })),
    ).toEqual([
      {
        id: a,
        receiptNumber,
        status: "pending-firm",
        start: "2026-10-20T10:00",
        end: "2026-10-20T12:00",
        bufferMinutes: 60,
        route: "form",
        partySize: 4,
        estimateIncludingTax: 11_000,
        customerName: customer.name,
      },
      {
        id: p,
        status: "provisional",
        start: "2026-10-20T13:00",
        end: "2026-10-20T15:00",
        bufferMinutes: 60,
        route: "form",
        partySize: 4,
        estimateIncludingTax: 11_000,
        confirmedPrice: 22_000,
        customerName: customer.name,
      },
      {
        id: k,
        status: "second-hold",
        start: "2026-10-20T14:00",
        end: "2026-10-20T17:00",
        bufferMinutes: 60,
        route: "form",
        partySize: 4,
        estimateIncludingTax: 11_000,
        confirmedPrice: 22_000,
        provisionalIds: [p],
        customerName: customer.name,
      },
      {
        id: d,
        status: "firm",
        start: "2026-10-21T10:00",
        end: "2026-10-21T12:00",
        bufferMinutes: 60,
        route: "admin",
        partySize: 3,
        estimateIncludingTax: 27_500,
        confirmedPrice: 26_000,
        customerName: "架空 電話三郎",
      },
    ]);
    expect(list.blocks.map((b) => ({ ...b, start: local(b.start), end: local(b.end) }))).toEqual([
      {
        id: blockResult.id,
        start: "2026-10-21T15:00",
        end: "2026-10-21T16:00",
        bufferMinutes: 30,
        route: "admin",
        memo: "架空のメモ：清掃",
      },
    ]);
    for (const personal of nonNamePersonalValues) {
      expect(text).not.toContain(personal);
    }
  });

  it("?status=pending-firm：期間によらず、承認待ち（本）の予約を開始の早い順に返す。ブロック枠は空", async () => {
    const x1 = await apply("firm", "2027-03-01T10:00", "2027-03-01T12:00");
    const x2 = await apply("firm", "2026-10-20T10:00", "2026-10-20T12:00");
    const x3 = await apply("firm", "2026-12-25T10:00", "2026-12-25T12:00");
    await apply("provisional", "2026-11-01T10:00", "2026-11-01T12:00");
    await applyApproved("firm", "2026-10-21T10:00", "2026-10-21T12:00");
    await saveAdminBlock(store, {
      start: jst("2026-10-22T10:00"),
      end: jst("2026-10-22T12:00"),
      bufferMinutes: 0,
    });

    const list = await listJson("status=pending-firm");

    expect(list.reservations.map((r) => [r.id, r.status, local(r.start)])).toEqual([
      [x2, "pending-firm", "2026-10-20T10:00"],
      [x3, "pending-firm", "2026-12-25T10:00"],
      [x1, "pending-firm", "2027-03-01T10:00"],
    ]);
    expect(list.blocks).toEqual([]);
  });

  it("?from=2026-10-20&to=2026-10-21&status=provisional：期間の中の仮予約だけを返す。ブロック枠は空", async () => {
    const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    await applyApproved("firm", "2026-10-20T18:00", "2026-10-20T20:00");
    await apply("provisional", "2026-10-21T10:00", "2026-10-21T12:00");
    await applyApproved("provisional", "2026-10-25T13:00", "2026-10-25T15:00");
    await saveAdminBlock(store, {
      start: jst("2026-10-20T08:00"),
      end: jst("2026-10-20T09:00"),
      bufferMinutes: 0,
    });

    const list = await listJson("from=2026-10-20&to=2026-10-21&status=provisional");

    expect(list.reservations.map((r) => r.id)).toEqual([p]);
    expect(list.blocks).toEqual([]);
  });

  it("却下・取消した予約は一覧に出ない（期間でも状態でも）", async () => {
    const a = await apply("firm", "2026-10-20T10:00", "2026-10-20T12:00");
    const f = await applyApproved("firm", "2026-10-20T15:00", "2026-10-20T17:00");
    await prepareOperation({ kind: "reject", reservationId: a }, operatedAt);
    await prepareOperation({ kind: "cancel", reservationId: f }, operatedAt);

    expect(await listJson("from=2026-10-20&to=2026-10-20")).toEqual({
      reservations: [],
      blocks: [],
    });
    expect((await listJson("status=pending-firm")).reservations).toEqual([]);
    expect((await listJson("status=firm")).reservations).toEqual([]);
  });

  it.each([
    ["期間がちょうど62日（10/01〜12/01）", "from=2026-10-01&to=2026-12-01"],
    ["from と to が同じ日", "from=2026-10-20&to=2026-10-20"],
    ["年をまたぐ62日（2026-12-01〜2027-01-31）", "from=2026-12-01&to=2027-01-31"],
  ])("%s：200", async (_, query) => {
    await applyApproved("firm", "2026-10-20T10:00", "2026-10-20T12:00");

    const res = await get(`/admin/reservations?${query}`);

    expect(res.status).toBe(200);
    expect(AdminReservationList.safeParse(await res.json()).success).toBe(true);
  });

  it.each([
    ["期間が62日を超える（10/01〜12/02 の63日）", "from=2026-10-01&to=2026-12-02"],
    ["期間が62日を超え、状態もある", "from=2026-10-01&to=2026-12-02&status=firm"],
    ["from が to より後（10/21〜10/20）", "from=2026-10-21&to=2026-10-20"],
    ["何も渡さない（期間か状態のどちらかは要る）", ""],
    ["from だけ", "from=2026-10-20"],
    ["to だけ", "to=2026-10-20"],
    ["状態が取消（一覧に出ない状態）", "status=cancelled"],
    ["状態が終了（一覧に出ない状態）", "status=ended"],
    ["状態が状態の値でない", "status=approved"],
    ["from の形が不正（2026/10/20）", "from=2026%2F10%2F20&to=2026-10-21"],
    ["to が存在しない日付（2026-10-32）", "from=2026-10-20&to=2026-10-32"],
    ["余計なキー", "from=2026-10-20&to=2026-10-21&limit=10"],
  ])("%s：400 と { error: invalid-input }", async (_, query) => {
    await expectError(await get(`/admin/reservations?${query}`), 400, "invalid-input");
  });
});

describe("管理 API：予約の詳細（GET /admin/reservations/{id}）", () => {
  it("フォームの申込の承認待ち（本）10/20 21:00–翌1:00：200 と JSON。AdminReservationDetail を通り、予約の META（受付番号を含む）・お客様の情報・撮影の内容・履歴（お客様の申込）と、今の料金表で計算し直した見積（通常 2,500 × 4 + 深夜 3,750 × 4 = 25,000、税込 27,500）を返す。今取消したときのキャンセル料はない", async () => {
    const { id: a, receiptNumber } = await applyViaForm(
      "firm",
      "2026-10-20T21:00",
      "2026-10-21T01:00",
    );

    const detail = await detailJson(a);

    expect({
      ...detail,
      start: local(detail.start),
      end: local(detail.end),
      createdAt: local(detail.createdAt),
      updatedAt: local(detail.updatedAt),
      history: [],
    }).toEqual({
      id: a,
      receiptNumber,
      status: "pending-firm",
      start: "2026-10-20T21:00",
      end: "2026-10-21T01:00",
      bufferMinutes: 60,
      route: "form",
      partySize: 4,
      cycloramaFloorProtection: false,
      planId: "A",
      equipmentInsurance: false,
      optionIds: [],
      estimate: { subtotalExcludingTax: 25_000, estimateIncludingTax: 27_500 },
      createdAt: "2026-10-01T12:00",
      updatedAt: "2026-10-01T12:00",
      customer: { ...customer },
      shooting: { ...shooting, types: [...shooting.types] },
      history: [],
      currentEstimate: { subtotalExcludingTax: 25_000, estimateIncludingTax: 27_500 },
    });
    expect(detail.history).toHaveLength(1);
    const entry = detail.history[0];
    expect(local(entry?.at)).toBe("2026-10-01T12:00");
    expect(entry?.actor).toEqual({ kind: "customer" });
    expect(entry?.operation).toBe("apply");
    expect(entry?.after?.status).toBe("pending-firm");
    expect(local(entry?.after?.start)).toBe("2026-10-20T21:00");
    expect(local(entry?.after?.end)).toBe("2026-10-21T01:00");
  });

  it("申込のときの見積（9,000円・税込 9,900円）が今の料金表と違う承認待ち（本）10/20 21:00–翌1:00：見積は申込のときのまま返し、今の料金表で計算し直した見積（深夜帯は JST で決まる。25,000円・税込 27,500円）を横に返す", async () => {
    const a = await apply("firm", "2026-10-20T21:00", "2026-10-21T01:00", {
      estimate: {
        subtotalExcludingTax: Yen.parse(9_000),
        estimateIncludingTax: Yen.parse(9_900),
      },
    });

    const detail = await detailJson(a);

    expect(detail.estimate).toEqual({ subtotalExcludingTax: 9_000, estimateIncludingTax: 9_900 });
    expect(detail.currentEstimate).toEqual({
      subtotalExcludingTax: 25_000,
      estimateIncludingTax: 27_500,
    });
  });

  it("承認待ちの見積は、渡した今の料金表で計算し直す：プランA の通常帯を 3,000円/30分 にした料金表なら、10/20 10:00–12:00 は 12,000円・税込 13,200円", async () => {
    const a = await apply("firm", "2026-10-20T10:00", "2026-10-20T12:00");
    const raised = PriceTable.parse({
      ...priceTableInput,
      plans: [
        { id: "A", name: "プランA", halfHourRates: { normal: 3_000, lateNight: 4_500 } },
        priceTableInput.plans[1],
      ],
    });

    const detail = await detailJson(a, { priceTable: raised });

    expect(detail.estimate).toEqual({ subtotalExcludingTax: 10_000, estimateIncludingTax: 11_000 });
    expect(detail.currentEstimate).toEqual({
      subtotalExcludingTax: 12_000,
      estimateIncludingTax: 13_200,
    });
  });

  it("承認待ち（第二キープ）：付く仮予約の id と、今の料金表で計算し直した見積を返す。キャンセル料はない", async () => {
    const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    const k = await apply("second-hold", "2026-10-20T14:00", "2026-10-20T17:00");

    const detail = await detailJson(k);

    expect(detail.status).toBe("pending-second-hold");
    expect(detail.provisionalIds).toEqual([p]);
    // プランA 通常 2,500 × 6 = 15,000 → 税込 16,500
    expect(detail.currentEstimate).toEqual({
      subtotalExcludingTax: 15_000,
      estimateIncludingTax: 16_500,
    });
    expect(detail.cancellationFeeIfCancelledNow).toBeUndefined();
  });

  describe("本予約（確定金額 27,500円、利用日 10/20）の、今取消したときのキャンセル料", () => {
    const cases: [string, string, number, number][] = [
      ["10/13 23:59 に開く：13,750円（50%。7日前）", "2026-10-13T23:59", 50, 13_750],
      ["10/17 00:00 に開く：22,000円（80%）", "2026-10-17T00:00", 80, 22_000],
      ["10/20 00:00 に開く：27,500円（100%）", "2026-10-20T00:00", 100, 27_500],
    ];

    it.each(cases)(
      "%s。確定金額・承認の履歴（準備をした管理者）を返し、見積の計算し直しはない",
      async (_, now, ratePercent, fee) => {
        const f = await applyApproved("firm", "2026-10-20T10:00", "2026-10-20T12:00", 27_500);

        const detail = await detailJson(f, { now: () => jst(now) });

        expect(detail.status).toBe("firm");
        expect(detail.confirmedPrice).toBe(27_500);
        expect(detail.cancellationFeeIfCancelledNow).toEqual({ ratePercent, fee });
        expect(detail.currentEstimate).toBeUndefined();
        const entry = detail.history.at(-1);
        expect(entry?.operation).toBe("approve");
        expect(entry?.actor).toEqual({ kind: "admin", userId: preparingAdminUserId });
        expect(local(entry?.at)).toBe("2026-10-02T12:00");
        expect(local(detail.updatedAt)).toBe("2026-10-02T12:00");
      },
    );

    it.each(cases)(
      "現在時刻を UTC で表して、%s（INV-7。JST で数える）",
      async (_, now, ratePercent, fee) => {
        const f = await applyApproved("firm", "2026-10-20T10:00", "2026-10-20T12:00", 27_500);

        const detail = await detailJson(f, { now: () => jst(now).toUTC() });

        expect(detail.cancellationFeeIfCancelledNow).toEqual({ ratePercent, fee });
        expect(local(detail.start)).toBe("2026-10-20T10:00");
      },
    );

    it("利用日は JST で数える（INV-7）：10/20 08:00 開始（UTC では 10/19 23:00）の本予約を 10/16 23:30（UTC では 10/16 14:30）に開く：4日前なので 50%・13,750円", async () => {
      const f = await applyApproved("firm", "2026-10-20T08:00", "2026-10-20T10:00", 27_500);

      for (const now of [jst("2026-10-16T23:30"), jst("2026-10-16T23:30").toUTC()]) {
        const detail = await detailJson(f, { now: () => now });
        expect(detail.cancellationFeeIfCancelledNow).toEqual({ ratePercent: 50, fee: 13_750 });
      }
    });
  });

  it("仮予約と第二キープ：今取消したときのキャンセル料は 0%・0円（無料）。見積の計算し直しはない。第二キープは付く仮予約の id を持つ", async () => {
    const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    const k = await applyApproved("second-hold", "2026-10-20T14:00", "2026-10-20T17:00");

    const pDetail = await detailJson(p, { now: () => jst("2026-10-20T00:00") });
    const kDetail = await detailJson(k, { now: () => jst("2026-10-20T00:00") });

    expect(pDetail.status).toBe("provisional");
    expect(pDetail.cancellationFeeIfCancelledNow).toEqual({ ratePercent: 0, fee: 0 });
    expect(pDetail.currentEstimate).toBeUndefined();
    expect(kDetail.status).toBe("second-hold");
    expect(kDetail.provisionalIds).toEqual([p]);
    expect(kDetail.cancellationFeeIfCancelledNow).toEqual({ ratePercent: 0, fee: 0 });
    expect(kDetail.currentEstimate).toBeUndefined();
  });

  it("却下した予約（取消）も開ける：200。状態は取消、履歴の最後は管理者の却下。見積の計算し直しとキャンセル料はない", async () => {
    const a = await apply("firm", "2026-10-20T10:00", "2026-10-20T12:00");
    await prepareOperation({ kind: "reject", reservationId: a });

    const detail = await detailJson(a);

    expect(detail.status).toBe("cancelled");
    expect(detail.history.map((h) => h.operation)).toEqual(["apply", "reject"]);
    expect(detail.history.at(-1)?.actor).toEqual({ kind: "admin", userId: preparingAdminUserId });
    expect(detail.currentEstimate).toBeUndefined();
    expect(detail.cancellationFeeIfCancelledNow).toBeUndefined();
  });

  it("管理者が直接入れた本予約（お客様の情報は氏名と電話番号だけ）：経路は admin、受付番号はない。AdminReservationDetail を通る", async () => {
    const d = await enterFirm("2026-10-21T10:00", "2026-10-21T12:00");

    const detail = await detailJson(d);

    expect(detail.route).toBe("admin");
    expect(detail.receiptNumber).toBeUndefined();
    expect(detail.customer).toEqual({ name: "架空 電話三郎", phone: "090-0000-1357" });
    expect(detail.confirmedPrice).toBe(26_000);
    expect(detail.estimate).toEqual({ subtotalExcludingTax: 25_000, estimateIncludingTax: 27_500 });
    expect(detail.history.map((h) => h.operation)).toEqual(["direct-entry"]);
    expect(detail.history[0]?.actor).toEqual({ kind: "admin", userId: preparingAdminUserId });
  });

  it("ない予約の id：404 と { error: not-found }", async () => {
    await expectError(await get("/admin/reservations/no-such-reservation"), 404, "not-found");
  });
});

describe("管理 API：受付番号から探す（GET /admin/receipts/{受付番号}）", () => {
  it("フォームの申込の受付番号：200 と { reservationId }（AdminReceiptLookup）", async () => {
    const { id: a, receiptNumber } = await applyViaForm(
      "firm",
      "2026-10-20T10:00",
      "2026-10-20T12:00",
    );
    await applyViaForm("firm", "2026-10-21T10:00", "2026-10-21T12:00");
    expect(await receiptOf(a)).toBe(receiptNumber);

    const json = await okJson(await get(`/admin/receipts/${receiptNumber}`));

    expect(AdminReceiptLookup.safeParse(json).success).toBe(true);
    expect(json).toEqual({ reservationId: a });
  });

  it("却下した予約の受付番号でも探せる（取消した予約は受付番号か予約の id で開く）", async () => {
    const { id: a, receiptNumber } = await applyViaForm(
      "firm",
      "2026-10-20T10:00",
      "2026-10-20T12:00",
    );
    await prepareOperation({ kind: "reject", reservationId: a });

    expect(await okJson(await get(`/admin/receipts/${receiptNumber}`))).toEqual({
      reservationId: a,
    });
  });

  it("ない受付番号（形は正しい）：404 と { error: not-found }", async () => {
    await applyViaForm("firm", "2026-10-20T10:00", "2026-10-20T12:00");

    await expectError(await get("/admin/receipts/ZZZZ9999"), 404, "not-found");
  });
});

describe("予約の状態", () => {
  // 承認待ち（本）A 10/20 10:00–12:00（占有区間 10:00–13:00、申込のときの見積 11,000円）の場合
  const applyA = () => apply("firm", "2026-10-20T10:00", "2026-10-20T12:00");

  it("管理者が確定金額 11,000円で承認：本予約。確定金額は 11,000円。承認の下書き（11,000円）ができる", async () => {
    const a = await applyA();

    const drafts = await acceptedDrafts(
      await post(`/admin/reservations/${a}/approve`, { confirmedPrice: 11_000 }),
    );

    const stored = await getReservation(store, a);
    expect(stored?.status).toBe("firm");
    expect(stored?.confirmedPrice).toBe(11_000);
    expectDrafts(drafts, [{ kind: "approval", reservationId: a, confirmedPrice: 11_000 }]);
    expect(await idsHolding("2026-10-20")).toEqual([a]);
  });

  it("管理者が確定金額を 10,000円に調整して承認：本予約。確定金額は 10,000円。承認の下書き（10,000円）ができる", async () => {
    const a = await applyA();

    const drafts = await acceptedDrafts(
      await post(`/admin/reservations/${a}/approve`, { confirmedPrice: 10_000 }),
    );

    const stored = await getReservation(store, a);
    expect(stored?.status).toBe("firm");
    expect(stored?.confirmedPrice).toBe(10_000);
    expectDrafts(drafts, [{ kind: "approval", reservationId: a, confirmedPrice: 10_000 }]);
  });

  it("管理者が却下：取消。10:00–13:00 の枠を解放する。却下の下書きができる", async () => {
    const a = await applyA();

    const drafts = await acceptedDrafts(await post(`/admin/reservations/${a}/reject`));

    expect((await getReservation(store, a))?.status).toBe("cancelled");
    expect(await idsHolding("2026-10-20")).toEqual([]);
    expectDrafts(drafts, [{ kind: "rejection", reservationId: a }]);
  });

  it("承認待ち（仮）を承認：仮予約", async () => {
    const q = await apply("provisional", "2026-10-20T10:00", "2026-10-20T12:00");

    const drafts = await acceptedDrafts(
      await post(`/admin/reservations/${q}/approve`, { confirmedPrice: 11_000 }),
    );

    expect((await getReservation(store, q))?.status).toBe("provisional");
    expectDrafts(drafts, [{ kind: "approval", reservationId: q, confirmedPrice: 11_000 }]);
  });

  it("仮予約 P に付く承認待ち（第二キープ）を承認：第二キープ。P に付いたまま", async () => {
    const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    const k = await apply("second-hold", "2026-10-20T14:00", "2026-10-20T17:00");

    const drafts = await acceptedDrafts(
      await post(`/admin/reservations/${k}/approve`, { confirmedPrice: 11_000 }),
    );

    const stored = await getReservation(store, k);
    expect(stored?.status).toBe("second-hold");
    expect(stored?.provisionalIds).toEqual([p]);
    expectDrafts(drafts, [{ kind: "approval", reservationId: k, confirmedPrice: 11_000 }]);
  });

  it("本予約を却下しようとする：不可（却下できるのは承認待ちだけ）", async () => {
    const f = await applyApproved("firm", "2026-10-20T10:00", "2026-10-20T12:00");
    const before = await scanAll();

    await expectError(await post(`/admin/reservations/${f}/reject`), 409, "not-pending");
    await expectNothingWritten(before);
  });

  it("本予約を承認しようとする：不可（承認できるのは承認待ちだけ）", async () => {
    const f = await applyApproved("firm", "2026-10-20T10:00", "2026-10-20T12:00");
    const before = await scanAll();

    await expectError(
      await post(`/admin/reservations/${f}/approve`, { confirmedPrice: 11_000 }),
      409,
      "not-pending",
    );
    await expectNothingWritten(before);
  });
});

describe("管理 API：承認・却下・昇格・取消・繰り上げ（POST /admin/reservations/{id}/…）", () => {
  it("承認：履歴の「誰が」は API を呼んだ管理者、日時は API の現在時刻。下書きは未送信のまま残る（送らない。INV-6）", async () => {
    const a = await apply("firm", "2026-10-20T10:00", "2026-10-20T12:00");

    const drafts = await acceptedDrafts(
      await post(`/admin/reservations/${a}/approve`, { confirmedPrice: 11_000 }),
    );

    const entry = (await getReservation(store, a))?.history.at(-1);
    expect(entry?.operation).toBe("approve");
    expect(entry?.actor).toEqual({ kind: "admin", userId: adminUserId });
    expect(entry?.at.toMillis()).toBe(operatedAt.toMillis());
    expect(drafts).toHaveLength(1);
    expect(await unsentDraftCount()).toBe(1);

    // 詳細でも、履歴の日時は JST のオフセット付き
    const detail = await detailJson(a);
    expect(local(detail.history.at(-1)?.at)).toBe("2026-10-05T09:00");
  });

  it("昇格：仮予約 P 13:00–15:00 に第二キープ K1 14:00–17:00 と承認待ちの第二キープ K2 11:00–13:00 が付いている：P は本予約。下書きは P の昇格と、K1・K2 の第二キープの終了", async () => {
    const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    const k1 = await applyApproved("second-hold", "2026-10-20T14:00", "2026-10-20T17:00");
    const k2 = await apply("second-hold", "2026-10-20T11:00", "2026-10-20T13:00");

    const drafts = await acceptedDrafts(await post(`/admin/reservations/${p}/promote`));

    const stored = await getReservation(store, p);
    expect(stored?.status).toBe("firm");
    expect(stored?.history.at(-1)?.actor).toEqual({ kind: "admin", userId: adminUserId });
    expect((await getReservation(store, k1))?.status).toBe("ended");
    expect((await getReservation(store, k2))?.status).toBe("ended");
    expectDrafts(drafts, [
      { kind: "promotion", reservationId: p },
      { kind: "second-hold-ended", reservationId: k1 },
      { kind: "second-hold-ended", reservationId: k2 },
    ]);
  });

  it("本予約を昇格しようとする：409 と { error: invalid-status }。何も書かない", async () => {
    const f = await applyApproved("firm", "2026-10-20T10:00", "2026-10-20T12:00");
    const before = await scanAll();

    await expectError(await post(`/admin/reservations/${f}/promote`), 409, "invalid-status");
    await expectNothingWritten(before);
  });

  it("取消：本予約（確定金額 27,500円、利用日 10/20）を 10/17 00:00 に取消：取消。枠を解放し、取消の下書きにキャンセル料 22,000円（80%）", async () => {
    const f = await applyApproved("firm", "2026-10-20T10:00", "2026-10-20T12:00", 27_500);

    const drafts = await acceptedDrafts(
      await post(`/admin/reservations/${f}/cancel`, {}, { now: () => jst("2026-10-17T00:00") }),
    );

    const stored = await getReservation(store, f);
    expect(stored?.status).toBe("cancelled");
    expect(stored?.history.at(-1)?.actor).toEqual({ kind: "admin", userId: adminUserId });
    expect(stored?.history.at(-1)?.at.toMillis()).toBe(jst("2026-10-17T00:00").toMillis());
    expect(await idsHolding("2026-10-20")).toEqual([]);
    expectDrafts(drafts, [
      { kind: "cancellation", reservationId: f, cancellationFee: { ratePercent: 80, fee: 22_000 } },
    ]);
  });

  it("取消：同じ取消を、現在時刻を UTC で表して（10/16 15:00Z）行う（INV-7）：キャンセル料は 22,000円（80%）のまま", async () => {
    const f = await applyApproved("firm", "2026-10-20T10:00", "2026-10-20T12:00", 27_500);

    const drafts = await acceptedDrafts(
      await post(
        `/admin/reservations/${f}/cancel`,
        {},
        { now: () => jst("2026-10-17T00:00").toUTC() },
      ),
    );

    expectDrafts(drafts, [
      { kind: "cancellation", reservationId: f, cancellationFee: { ratePercent: 80, fee: 22_000 } },
    ]);
  });

  it("取消：第二キープ K 14:00–17:00 が付いている仮予約 P 13:00–15:00 を取消：P の取消（キャンセル料なし）と、K への繰り上げ案内（残っている仮予約なし）の下書き", async () => {
    const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    const k = await applyApproved("second-hold", "2026-10-20T14:00", "2026-10-20T17:00");

    const drafts = await acceptedDrafts(await post(`/admin/reservations/${p}/cancel`));

    expect((await getReservation(store, p))?.status).toBe("cancelled");
    expect((await getReservation(store, k))?.status).toBe("second-hold");
    expectDrafts(drafts, [
      { kind: "cancellation", reservationId: p, cancellationFee: { ratePercent: 0, fee: 0 } },
      { kind: "move-up-notice", reservationId: k, remainingProvisionalIds: [] },
    ]);
  });

  it("取消済みの予約を取消しようとする：409 と { error: invalid-status }。何も書かない", async () => {
    const f = await applyApproved("firm", "2026-10-20T10:00", "2026-10-20T12:00");
    await prepareOperation({ kind: "cancel", reservationId: f });
    const before = await scanAll();

    await expectError(await post(`/admin/reservations/${f}/cancel`), 409, "invalid-status");
    await expectNothingWritten(before);
  });

  it("繰り上げ：付いている仮予約 P が取消になった第二キープ K：仮予約になる。下書きはない。履歴の「誰が」は API を呼んだ管理者", async () => {
    const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    const k = await applyApproved("second-hold", "2026-10-20T14:00", "2026-10-20T17:00");
    await prepareOperation({ kind: "cancel", reservationId: p });

    const drafts = await acceptedDrafts(await post(`/admin/reservations/${k}/move-up`));

    const stored = await getReservation(store, k);
    expect(stored?.status).toBe("provisional");
    expect(stored?.history.at(-1)?.operation).toBe("move-up");
    expect(stored?.history.at(-1)?.actor).toEqual({ kind: "admin", userId: adminUserId });
    expect(drafts).toEqual([]);
  });

  it("繰り上げ：2件の仮予約 P1・P2 に付く第二キープ K で、P1 だけが取消になった：409 と { error: still-held }。何も書かない", async () => {
    const p1 = await applyApproved("provisional", "2026-10-20T10:00", "2026-10-20T12:00");
    await applyApproved("provisional", "2026-10-20T15:00", "2026-10-20T17:00");
    const k = await applyApproved("second-hold", "2026-10-20T12:00", "2026-10-20T16:00");
    await prepareOperation({ kind: "cancel", reservationId: p1 });
    const before = await scanAll();

    await expectError(await post(`/admin/reservations/${k}/move-up`), 409, "still-held");
    await expectNothingWritten(before);
  });

  it.each([
    ["approve", { confirmedPrice: 11_000 }],
    ["reject", {}],
    ["promote", {}],
    ["cancel", {}],
    ["move-up", {}],
  ])(
    "ない予約の id への %s：404 と { error: not-found }。何も書かない",
    async (operation, body) => {
      await apply("firm", "2026-10-20T10:00", "2026-10-20T12:00");
      const before = await scanAll();

      await expectError(
        await post(`/admin/reservations/no-such-reservation/${operation}`, body),
        404,
        "not-found",
      );
      await expectNothingWritten(before);
    },
  );

  it("混み合っている（書く直前に毎回ほかの書き込みで 10/20 の版番号が進み、やり直しの上限を超える）：503 と { error: busy }。承認されず、下書きもできない", async () => {
    const a = await apply("firm", "2026-10-20T10:00", "2026-10-20T12:00");

    const res = await post(
      `/admin/reservations/${a}/approve`,
      { confirmedPrice: 11_000 },
      { save: { maxAttempts: 2, beforeWrite: () => bumpDay("2026-10-20") } },
    );

    await expectError(res, 503, "busy");
    expect((await getReservation(store, a))?.status).toBe("pending-firm");
    expect(await unsentDraftCount()).toBe(0);
  });

  describe("本文のパース（INV-4）", () => {
    it.each([
      ["確定金額がない", {}],
      ["確定金額が小数（INV-9）", { confirmedPrice: 11_000.5 }],
      ["確定金額が負", { confirmedPrice: -1 }],
      ["確定金額が文字列", { confirmedPrice: "11000" }],
      [
        "余計なキー（日時。承認は申込どおり）",
        { confirmedPrice: 11_000, start: "2026-10-20T11:00:00+09:00" },
      ],
      ["余計なキー（誰が）", { confirmedPrice: 11_000, userId: "admin-user-kaku-other" }],
      ["null", null],
      ["配列", [{ confirmedPrice: 11_000 }]],
      ["JSON でない本文", "confirmedPrice=11000"],
      ["空の本文", ""],
    ])("承認の本文が %s：400 と { error: invalid-input }。何も書かない", async (_, body) => {
      const a = await apply("firm", "2026-10-20T10:00", "2026-10-20T12:00");
      const before = await scanAll();

      await expectError(await post(`/admin/reservations/${a}/approve`, body), 400, "invalid-input");
      await expectNothingWritten(before);
    });

    /** 却下・昇格・取消・繰り上げが、本文さえ正しければできる予約を用意し、操作ごとのあて先を返す */
    async function prepareTargets(): Promise<Record<string, string>> {
      const a = await apply("firm", "2026-10-21T10:00", "2026-10-21T12:00");
      const q = await applyApproved("provisional", "2026-10-22T10:00", "2026-10-22T12:00");
      const f = await applyApproved("firm", "2026-10-23T10:00", "2026-10-23T12:00");
      const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
      const k = await applyApproved("second-hold", "2026-10-20T14:00", "2026-10-20T17:00");
      await prepareOperation({ kind: "cancel", reservationId: p });
      return { reject: a, promote: q, cancel: f, "move-up": k };
    }

    it.each([
      ["reject", "余計なキー（理由）", { reason: "架空の却下の理由" }],
      ["promote", "余計なキー（確定金額）", { confirmedPrice: 11_000 }],
      [
        "cancel",
        "余計なキー（キャンセル料。キャンセル料は API が計算する）",
        { cancellationFee: 0 },
      ],
      ["move-up", "配列", []],
      ["cancel", "JSON でない本文", "cancel"],
      ["reject", "null", null],
    ])(
      "%s の本文が %s：400 と { error: invalid-input }。何も書かない",
      async (operation, _, body) => {
        const targets = await prepareTargets();
        const before = await scanAll();

        await expectError(
          await post(`/admin/reservations/${targets[operation] ?? ""}/${operation}`, body),
          400,
          "invalid-input",
        );
        await expectNothingWritten(before);
      },
    );
  });
});

describe("管理 API：認証（管理者の id）", () => {
  const noAdmin: AdminUserIdSource = () => undefined;

  /** どのルートも、管理者の id が取れなければ 401（入力の誤りや、ない予約でも） */
  const routes: [string, string, string, unknown?][] = [
    ["一覧（期間）", "GET", "/admin/reservations?from=2026-10-20&to=2026-10-21"],
    ["一覧（状態）", "GET", "/admin/reservations?status=pending-firm"],
    ["一覧（クエリの誤り）", "GET", "/admin/reservations"],
    ["詳細", "GET", "/admin/reservations/{a}"],
    ["詳細（ない予約）", "GET", "/admin/reservations/no-such-reservation"],
    ["受付番号から探す", "GET", "/admin/receipts/{receipt}"],
    ["承認", "POST", "/admin/reservations/{a}/approve", { confirmedPrice: 11_000 }],
    ["承認（本文の誤り）", "POST", "/admin/reservations/{a}/approve", {}],
    ["却下", "POST", "/admin/reservations/{a}/reject", {}],
    ["昇格", "POST", "/admin/reservations/{p}/promote", {}],
    ["取消", "POST", "/admin/reservations/{p}/cancel", {}],
    ["繰り上げ", "POST", "/admin/reservations/{k}/move-up", {}],
  ];

  it.each(routes)(
    "管理者の id が取れない：%s（%s）は 401 と { error: unauthorized }。何も書かない",
    async (_, method, template, body) => {
      const { id: a, receiptNumber } = await applyViaForm(
        "firm",
        "2026-10-21T10:00",
        "2026-10-21T12:00",
      );
      const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
      const k = await applyApproved("second-hold", "2026-10-20T14:00", "2026-10-20T17:00");
      const path = template
        .replace("{a}", a)
        .replace("{p}", p)
        .replace("{k}", k)
        .replace("{receipt}", receiptNumber);
      const before = await scanAll();

      const route = createAdminRoute(deps({ adminUserId: noAdmin }));
      const res =
        method === "GET"
          ? await route.request(path)
          : await route.request(path, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            });

      await expectError(res, 401, "unauthorized");
      await expectNothingWritten(before);
    },
  );

  it("本番（Lambda）の取り出し方：JWT オーソライザーが確かめたトークンの sub（リクエストの文脈のクレーム）を管理者の id として使い、承認の履歴の「誰が」になる", async () => {
    const a = await apply("firm", "2026-10-20T10:00", "2026-10-20T12:00");
    const sub = "cognito-sub-kaku-0001";

    const res = await requestWithEnv(
      adminUserIdFromLambdaContext,
      `/admin/reservations/${a}/approve`,
      approveInit(11_000),
      lambdaEnv({ sub, email: "admin.kaku@example.com" }),
    );

    expect(await acceptedDrafts(res)).toHaveLength(1);
    expect((await getReservation(store, a))?.history.at(-1)?.actor).toEqual({
      kind: "admin",
      userId: sub,
    });
  });

  it.each([
    ["オーソライザーのクレームがない", lambdaEnv()],
    ["クレームに sub がない", lambdaEnv({ email: "admin.kaku@example.com" })],
    ["sub が空", lambdaEnv({ sub: "" })],
    ["リクエストの文脈がない", {}],
  ])(
    "本番（Lambda）の取り出し方で、%s：401。環境変数に DEV_ADMIN_USER_ID があっても 401（本番で仮の管理者は効かない）。何も書かない",
    async (_, env) => {
      vi.stubEnv("DEV_ADMIN_USER_ID", "dev-admin-kaku-env");
      const a = await apply("firm", "2026-10-20T10:00", "2026-10-20T12:00");
      const before = await scanAll();

      await expectError(
        await requestWithEnv(
          adminUserIdFromLambdaContext,
          `/admin/reservations/${a}/approve`,
          approveInit(11_000),
          env,
        ),
        401,
        "unauthorized",
      );
      await expectError(
        await requestWithEnv(adminUserIdFromLambdaContext, `/admin/reservations/${a}`, {}, env),
        401,
        "unauthorized",
      );
      await expectNothingWritten(before);
    },
  );

  it("手元（Node サーバー）の取り出し方：DEV_ADMIN_USER_ID の値（dev-admin-kaku）の管理者として承認でき、履歴の「誰が」がその id になる", async () => {
    const a = await apply("firm", "2026-10-20T10:00", "2026-10-20T12:00");

    const drafts = await acceptedDrafts(
      await post(
        `/admin/reservations/${a}/approve`,
        { confirmedPrice: 11_000 },
        { adminUserId: devAdminUserId("dev-admin-kaku") },
      ),
    );

    expect(drafts).toHaveLength(1);
    expect((await getReservation(store, a))?.history.at(-1)?.actor).toEqual({
      kind: "admin",
      userId: "dev-admin-kaku",
    });
  });

  it.each([
    ["値がない", undefined],
    ["値が空", ""],
  ])("手元の取り出し方で、DEV_ADMIN_USER_ID の%s：401", async (_, value) => {
    const a = await apply("firm", "2026-10-20T10:00", "2026-10-20T12:00");

    await expectError(
      await get(`/admin/reservations/${a}`, { adminUserId: devAdminUserId(value) }),
      401,
      "unauthorized",
    );
  });
});

describe("管理 API：ログに本文や個人情報を出さない（INV-10）", () => {
  /** console と標準出力・標準エラーに出たものを集める（出力はそのまま通す） */
  function captureOutput(): () => string {
    const calls: (() => unknown[][])[] = [
      ...(["log", "info", "warn", "error", "debug"] as const).map((method) => {
        const spy = vi.spyOn(console, method);
        return () => spy.mock.calls as unknown[][];
      }),
      ...[process.stdout, process.stderr].map((stream) => {
        const spy = vi.spyOn(stream, "write");
        return () => spy.mock.calls as unknown[][];
      }),
    ];
    const show = (arg: unknown): string =>
      typeof arg === "string"
        ? arg
        : arg instanceof Uint8Array
          ? Buffer.from(arg).toString("utf8")
          : inspect(arg, { depth: 10, breakLength: Number.POSITIVE_INFINITY });
    return () =>
      calls
        .flatMap((read) => read())
        .map((args) => args.map(show).join(" "))
        .join("\n");
  }

  it("一覧・詳細・受付番号・操作（成功・できない・入力の誤り・混み合っている・認証なし）の処理中のログ（console、標準出力、標準エラー）に、お客様の情報と自由記述の値、本文の値が出ない", async () => {
    const { id: a, receiptNumber: receipt } = await applyViaForm(
      "firm",
      "2026-10-20T10:00",
      "2026-10-20T12:00",
    );
    const b = await apply("firm", "2026-10-21T10:00", "2026-10-21T12:00");
    const f = await applyApproved("firm", "2026-10-22T10:00", "2026-10-22T12:00");
    /** 本文に入れる、ログに出てはいけない値（架空） */
    const bodyMarker = "架空の本文の値：ログに出さない";
    const output = captureOutput();

    await get("/admin/reservations?from=2026-10-20&to=2026-10-22");
    await get("/admin/reservations?status=pending-firm");
    await get(`/admin/reservations/${a}`);
    await get(`/admin/receipts/${receipt}`);
    await post(`/admin/reservations/${a}/approve`, { confirmedPrice: 11_000 });
    await post(`/admin/reservations/${f}/approve`, { confirmedPrice: 11_000 });
    await post(`/admin/reservations/${b}/approve`, { confirmedPrice: 11_000, memo: bodyMarker });
    await post(`/admin/reservations/${b}/approve`, `{"memo":"${bodyMarker}"`);
    await post(
      `/admin/reservations/${b}/approve`,
      { confirmedPrice: 11_000 },
      { save: { maxAttempts: 1, beforeWrite: () => bumpDay("2026-10-21") } },
    );
    await get(`/admin/reservations/${a}`, { adminUserId: () => undefined });
    await post(`/admin/reservations/${f}/cancel`);

    const text = output();
    for (const value of [...personalValues, bodyMarker]) {
      expect(text).not.toContain(value);
    }
  });
});
