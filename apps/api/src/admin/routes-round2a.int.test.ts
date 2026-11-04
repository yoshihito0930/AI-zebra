import {
  type AttributeValue,
  CreateTableCommand,
  DeleteTableCommand,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  ScanCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  AdminBlockCreated,
  AdminDirectEntryAccepted,
  AdminOperationAccepted,
  AdminRejected,
  AdminReservationDetail,
  AdminReservationList,
  type AdminWarning,
  PriceTable,
  Yen,
} from "@zebra/contracts";
import fc from "fast-check";
import { DateTime } from "luxon";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveAdminBlock } from "../db/blocks.ts";
import { createLocalDynamoClient } from "../db/client.ts";
import { type ReservationOperationInput, saveReservationOperation } from "../db/operations.ts";
import {
  type ApplicationKind,
  type ReservationApplication,
  type ReservationStore,
  getReservation,
  saveApplication,
} from "../db/reservations.ts";
import { submitApplication } from "../public/applications.ts";
import { type AdminDeps, createAdminRoute } from "./routes.ts";

// 管理 API の2回目a（予約の変更・直接入力・ブロック枠を入れる・直す・消す、と警告の確認）のルートの統合テスト（DynamoDB Local）。
// 根拠：docs/design-docs/admin-api.md「警告の確認（2回目）」「変更・直接入力・ブロック枠（2回目a）」「返すときの決まり」「認証」、
// docs/product-specs/booking.md「予約の変更」（例の表のすべての行）、「管理者による予約の直接入力とブロック枠」
// （例の表のうち、直接入力の行と、管理者が入れる・直す・消すブロック枠の行）、「直接入れる予約のルール」「申込フォーム」「料金」、
// reservation-model.md（金額、履歴）、core-beliefs.md（INV-1、INV-2、INV-4、INV-7、INV-9、INV-10）、
// packages/contracts の admin.ts（返す本文は契約でパースできること）。
// 判定の細かい決まりは booking-core（checkReservationChangeTime・checkDirectEntry・checkAdminBlock）と保存の層のテストで
// 確かめているので、ここでは例の行が API の返事（ステータス・本文）と DB に正しく現れることを確かめる。
// - 例の表の行は、本文の日時と API の現在時刻を JST で渡す場合と、同じ時点を UTC に直して渡す場合の両方で確かめる（INV-7）
// - 例の行に操作の日時が書かれていないときは、API の現在時刻を 2026/10/05 09:00 とする（どの行でも、行に書かれた警告のほかは
//   当てはまらない）。例の表には年がないので 2026 年とし、日付のない行は 10/20 とする
// - 「確認すれば入る／変えられる」の行は、確認なしで送ると 409 unacknowledged-warnings と今の警告の一覧が返って何も書かれず、
//   返った一覧を付けて送り直すと保存される、ことで確かめる
// - 警告が2つ以上あるときの並び順は決めていないので、警告の一覧は集合として比べる
// - 下書きの並び順は決めていないので、件数と中身で比べる
// - 承認待ちの仮予約と重なる第二キープの直接入力は「不可（承認待ちとは重なれない）」。理由が overlaps-existing か
//   no-provisional-to-hold かは資料で決まっていない（保存の層のテストも理由を決めていない）ので、422 とどちらかであることだけを確かめる
// - 変更できる状態は、承認済みの仮予約・本予約だけ（booking.md の未決事項「第二キープ（承認待ちを含む）自身の日時を変えられるか」）。
//   第二キープ・承認待ち・取消の予約の変更は 409 not-changeable（admin-api.md「返すときの決まり」の「変更できない状態」）
// - ブロック枠を直す・消すの成功は 200。返す本文の形は資料にない（契約がない）ので、ステータスだけを確かめる
// - Googleカレンダーから取り込んだブロック枠は、取り込みの保存がまだないので、db/blocks.int.test.ts と同じく
//   資料の形（id は gcal-<イベントの id>、日ごとのアイテムの占有区間）でテストから直接入れる
// - 既存の routes.int.test.ts は変えず、このファイルに分けた。道具は routes.int.test.ts と同じものをこのファイルにも持つ

const client = createLocalDynamoClient();
let store: ReservationStore;

// テーブルはキー設計どおり（pk・sk、GSI の gsi1pk・gsi1sk）にテストごとに作り、終わったら消す
async function createTable(): Promise<ReservationStore> {
  const tableName = `int-test-admin-2a-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
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

async function deleteTable(target: ReservationStore): Promise<void> {
  await client.send(new DeleteTableCommand({ TableName: target.tableName }));
}

beforeEach(async () => {
  store = await createTable();
});

afterEach(async () => {
  await deleteTable(store);
  vi.restoreAllMocks();
});

// ---- 日時（INV-7）。テストの日時は JST で書く。現在時刻は固定する ----

function jst(iso: string): DateTime {
  const dateTime = DateTime.fromISO(iso, { zone: "Asia/Tokyo" });
  if (!dateTime.isValid) {
    throw new Error(`テストの日時が不正：${iso}`);
  }
  return dateTime;
}

type ToZone = (at: DateTime) => DateTime;

/** 日時の表し方（INV-7）：JST のまま渡すか、同じ時点を UTC に直して渡すか */
const zones: readonly (readonly [string, ToZone])[] = [
  ["JST", (at) => at],
  ["UTC", (at) => at.toUTC()],
];

/** 本文に入れる日時（ISO 8601、オフセット付き。UTC なら Z） */
function iso(toZone: ToZone, local: string): string {
  const text = toZone(jst(local)).toISO({ suppressMilliseconds: true });
  if (text === null) throw new Error(`テストの日時が不正：${local}`);
  return text;
}

/** 申込の時刻（固定） */
const appliedAt = jst("2026-10-01T12:00");
/** テストの準備でする承認の時刻（固定） */
const preparedAt = jst("2026-10-02T12:00");
/** 例の行に操作の日時が書かれていないときの、API の現在時刻（固定） */
const operatedAt = "2026-10-05T09:00";

/** API を呼ぶ管理者（架空のユーザー id） */
const adminUserId = "admin-user-kaku-2a";
/** 準備の承認をした管理者（架空のユーザー id。API を呼ぶ管理者と見分けるため別にする） */
const preparingAdminUserId = "admin-user-kaku-2a-prep";

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

/** 保存された日時（UTC）を、比べやすい JST の "yyyy-MM-ddTHH:mm" にする */
function storedLocal(value: unknown): string {
  const parsed = DateTime.fromISO(String(value), { setZone: true });
  expect(parsed.isValid, String(value)).toBe(true);
  return parsed.setZone("Asia/Tokyo").toFormat("yyyy-MM-dd'T'HH:mm");
}

/** JST の日付 from から count 日分の YYYY-MM-DD */
function jstDays(from: string, count: number): string[] {
  const first = jst(`${from}T00:00`);
  return Array.from({ length: count }, (_, i) => first.plus({ days: i }).toFormat("yyyy-MM-dd"));
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

/** 準備の申込のお客様 */
const customer = {
  name: "架空 変更花子",
  companyName: "架空変更株式会社",
  email: "henkou.kaku@example.com",
  phone: "090-0000-9753",
  address: "架空県架空市変更町9-7-5",
  photographerName: "仮名 変更撮影",
} as const;

const shooting = {
  types: ["still"],
  details: "架空の撮影詳細：2回目aの確認用",
  notes: "架空の補足事項：2回目aの確認用",
} as const;

/** 電話で受けた直接入力のお客様（氏名と電話番号だけ） */
const phoneCustomer = { name: "架空 電話一郎", phone: "090-0000-7531" } as const;
/** メールで受けた直接入力のお客様（氏名とメールアドレスだけ） */
const emailCustomer = { name: "架空 メール二子", email: "mail.niko.kaku@example.com" } as const;
/** 全部の欄を入れた直接入力のお客様と撮影の内容 */
const fullCustomer = {
  name: "架空 全部三郎",
  companyName: "架空全部合同会社",
  email: "zenbu.saburo.kaku@example.com",
  phone: "03-0000-8642",
  address: "架空県架空市全部町8-6-4",
  photographerName: "仮名 全部撮影",
} as const;
const fullShooting = {
  types: ["movie"],
  details: "架空の撮影詳細：直接入力の確認用",
  notes: "架空の補足事項：直接入力の確認用",
} as const;

const personalValues: readonly string[] = [
  ...Object.values(customer),
  shooting.details,
  shooting.notes,
  ...Object.values(phoneCustomer),
  ...Object.values(emailCustomer),
  ...Object.values(fullCustomer),
  fullShooting.details,
  fullShooting.notes,
];

/** 申込（4人・養生なし〈プランA〉・機材保険なし・オプションなし。見積は 10,000円・税込 11,000円） */
function application(kind: ApplicationKind, start: string, end: string): ReservationApplication {
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
  };
}

// ---- 準備の道具（保存の層の関数で作る） ----

async function apply(kind: ApplicationKind, start: string, end: string): Promise<string> {
  const result = await saveApplication(store, application(kind, start, end), { now: appliedAt });
  if (!result.ok) {
    throw new Error(`準備の申込が不可になった（${kind} ${start}–${end}、${result.reason}）`);
  }
  return result.id;
}

async function prepareOperation(operation: ReservationOperationInput): Promise<void> {
  const result = await saveReservationOperation(store, operation, {
    now: preparedAt,
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

/** お客様がウィジェット（公開API の申込）から申込む。受け付けられたかを返す */
async function applyViaWidget(toZone: ToZone, start: string, end: string): Promise<boolean> {
  const result = await submitApplication(
    { store, now: () => toZone(appliedAt), priceTable: specPriceTable },
    {
      kind: "firm",
      start: iso(toZone, start),
      end: iso(toZone, end),
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
  return result.ok;
}

/** Googleカレンダーから取り込んだブロック枠を直接入れる（id は gcal-<イベントの id>、バッファ1時間。dynamodb-keys.md） */
async function putCalendarBlock(
  id: string,
  day: string,
  start: string,
  end: string,
): Promise<void> {
  await client.send(
    new PutItemCommand({
      TableName: store.tableName,
      Item: { pk: { S: `BLK#${id}` }, sk: { S: "META" } },
    }),
  );
  await client.send(
    new PutItemCommand({
      TableName: store.tableName,
      Item: {
        pk: { S: `DAY#${day}` },
        sk: { S: "META" },
        version: { N: "1" },
        intervals: {
          L: [
            {
              M: {
                kind: { S: "block" },
                id: { S: id },
                start: { S: jst(start).toUTC().toISO() ?? "" },
                end: { S: jst(end).toUTC().toISO() ?? "" },
                bufferMinutes: { N: "60" },
              },
            },
          ],
        },
      },
    }),
  );
}

// ---- API を呼ぶ道具 ----

function deps(now: DateTime, overrides: Partial<AdminDeps> = {}): AdminDeps {
  return {
    store,
    now: () => now,
    priceTable: specPriceTable,
    adminUserId: () => adminUserId,
    ...overrides,
  };
}

/** 本文を付けて呼ぶ。body が文字列ならそのまま本文にし、undefined なら本文を付けず、それ以外は JSON にする */
async function send(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body: unknown,
  now: DateTime,
  overrides: Partial<AdminDeps> = {},
): Promise<Response> {
  const route = createAdminRoute(deps(now, overrides));
  if (body === undefined) {
    return route.request(path, { method });
  }
  return route.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** 予約の変更（POST /admin/reservations/{id}/change） */
async function change(
  id: string,
  body: unknown,
  now: DateTime,
  overrides: Partial<AdminDeps> = {},
): Promise<Response> {
  return send("POST", `/admin/reservations/${id}/change`, body, now, overrides);
}

/** 直接入力（POST /admin/reservations） */
async function enter(
  body: unknown,
  now: DateTime,
  overrides: Partial<AdminDeps> = {},
): Promise<Response> {
  return send("POST", "/admin/reservations", body, now, overrides);
}

/** ブロック枠を入れる（POST /admin/blocks） */
async function createBlock(
  body: unknown,
  now: DateTime,
  overrides: Partial<AdminDeps> = {},
): Promise<Response> {
  return send("POST", "/admin/blocks", body, now, overrides);
}

/** ブロック枠を直す（PUT /admin/blocks/{id}） */
async function updateBlock(
  id: string,
  body: unknown,
  now: DateTime,
  overrides: Partial<AdminDeps> = {},
): Promise<Response> {
  return send("PUT", `/admin/blocks/${id}`, body, now, overrides);
}

/** ブロック枠を消す（DELETE /admin/blocks/{id}）。本文は付けない */
async function deleteBlock(
  id: string,
  now: DateTime,
  overrides: Partial<AdminDeps> = {},
): Promise<Response> {
  return send("DELETE", `/admin/blocks/${id}`, undefined, now, overrides);
}

/** 成功の JSON を返す（ステータスと content-type を確かめる） */
async function okJson(res: Response, status: number): Promise<unknown> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  expect(res.headers.get("content-type") ?? "").toContain("application/json");
  return JSON.parse(text) as unknown;
}

/** エラーの応答が、ステータスと { error: <理由> }（AdminRejected）であることを確かめる */
async function expectError(res: Response, status: number, error: string): Promise<void> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  expect(res.headers.get("content-type") ?? "").toContain("application/json");
  const json = JSON.parse(text) as unknown;
  expect(AdminRejected.safeParse(json).success, text).toBe(true);
  expect(json).toEqual({ error });
}

/** 決まりで不可の応答が、422 と、理由の候補のどれかであることを確かめる */
async function expectRejectedWithOneOf(res: Response, errors: readonly string[]): Promise<void> {
  const text = await res.text();
  expect(res.status, text).toBe(422);
  const json = JSON.parse(text) as unknown;
  const parsed = AdminRejected.safeParse(json);
  expect(parsed.success, text).toBe(true);
  expect(errors).toContain(parsed.success ? parsed.data.error : undefined);
  expect(Object.keys(json as object)).toEqual(["error"]);
}

/**
 * 確認していない警告がある応答が、409 と { error: unacknowledged-warnings, warnings: 今の警告の一覧 } であることを確かめ、
 * 返った警告の一覧を返す（並び順は決めていないので、集合として比べる）
 */
async function expectUnacknowledged(
  res: Response,
  expected: readonly AdminWarning[],
): Promise<AdminWarning[]> {
  const text = await res.text();
  expect(res.status, text).toBe(409);
  expect(res.headers.get("content-type") ?? "").toContain("application/json");
  const json = JSON.parse(text) as unknown;
  const parsed = AdminRejected.safeParse(json);
  expect(parsed.success, text).toBe(true);
  if (!parsed.success) throw new Error("AdminRejected を通らない");
  expect(parsed.data.error).toBe("unacknowledged-warnings");
  const warnings = parsed.data.warnings ?? [];
  expect(new Set(warnings).size, text).toBe(warnings.length);
  expect([...warnings].sort(), text).toEqual([...expected].sort());
  return warnings;
}

/** 操作が成功したときの返事が 200 と AdminOperationAccepted であることを確かめ、下書きを返す */
async function acceptedDrafts(res: Response): Promise<AdminOperationAccepted["drafts"]> {
  const json = await okJson(res, 200);
  const parsed = AdminOperationAccepted.safeParse(json);
  expect(parsed.success, JSON.stringify(json)).toBe(true);
  return parsed.success ? parsed.data.drafts : [];
}

/** 下書きの並び順は決めていないので、件数と中身で比べる */
function expectDrafts(actual: readonly unknown[], expected: readonly unknown[]): void {
  expect(actual).toHaveLength(expected.length);
  expect(actual).toEqual(expect.arrayContaining([...expected]));
}

/** 直接入力が成功したときの返事が 201 と AdminDirectEntryAccepted であることを確かめ、予約の id を返す */
async function enteredId(res: Response): Promise<string> {
  const json = await okJson(res, 201);
  const parsed = AdminDirectEntryAccepted.safeParse(json);
  expect(parsed.success, JSON.stringify(json)).toBe(true);
  if (!parsed.success) throw new Error("AdminDirectEntryAccepted を通らない");
  return parsed.data.reservationId;
}

/** ブロック枠を入れたときの返事が 201 と AdminBlockCreated であることを確かめ、ブロック枠の id を返す */
async function createdBlockId(res: Response): Promise<string> {
  const json = await okJson(res, 201);
  const parsed = AdminBlockCreated.safeParse(json);
  expect(parsed.success, JSON.stringify(json)).toBe(true);
  if (!parsed.success) throw new Error("AdminBlockCreated を通らない");
  return parsed.data.blockId;
}

/** ブロック枠を直す・消すの成功（200。本文の形は資料にないので見ない） */
async function expectOk(res: Response): Promise<void> {
  const text = await res.text();
  expect(res.status, text).toBe(200);
}

async function detailJson(id: string, now: DateTime): Promise<AdminReservationDetail> {
  const json = await okJson(await send("GET", `/admin/reservations/${id}`, undefined, now), 200);
  const parsed = AdminReservationDetail.safeParse(json);
  expect(parsed.success, JSON.stringify(json)).toBe(true);
  if (!parsed.success) throw new Error("AdminReservationDetail を通らない");
  return parsed.data;
}

async function listJson(query: string, now: DateTime): Promise<AdminReservationList> {
  const json = await okJson(await send("GET", `/admin/reservations?${query}`, undefined, now), 200);
  const parsed = AdminReservationList.safeParse(json);
  expect(parsed.success, JSON.stringify(json)).toBe(true);
  if (!parsed.success) throw new Error("AdminReservationList を通らない");
  return parsed.data;
}

// ---- 本文を作る道具 ----

const allWarnings: readonly AdminWarning[] = [
  "past-24-hours-before-start",
  "past-provisional-deadline",
  "late-night-shorter-than-4-hours",
];

/** 変更の本文。中身は準備の申込と同じ（4人・養生なし・機材保険なし・オプションなし）、確定金額は指定がなければ 11,000円 */
function changeBody(
  toZone: ToZone,
  start: string,
  end: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    start: iso(toZone, start),
    end: iso(toZone, end),
    partySize: 4,
    cycloramaFloorProtection: false,
    equipmentInsurance: false,
    optionIds: [],
    confirmedPrice: 11_000,
    ...overrides,
  };
}

/** 直接入力の本文。3人・養生なし・機材保険なし・オプションなし、確定金額 11,000円、お客様は氏名と電話番号だけ */
function entryBody(
  toZone: ToZone,
  kind: "firm" | "provisional" | "second-hold",
  start: string,
  end: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind,
    start: iso(toZone, start),
    end: iso(toZone, end),
    partySize: 3,
    cycloramaFloorProtection: false,
    equipmentInsurance: false,
    optionIds: [],
    confirmedPrice: 11_000,
    customer: { ...phoneCustomer },
    shooting: {},
    ...overrides,
  };
}

/** ブロック枠の本文 */
function blockBody(
  toZone: ToZone,
  start: string,
  end: string,
  bufferMinutes: 0 | 30 | 60,
  memo?: string,
): Record<string, unknown> {
  return {
    start: iso(toZone, start),
    end: iso(toZone, end),
    bufferMinutes,
    ...(memo === undefined ? {} : { memo }),
  };
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

function sortedItems(items: readonly PlainItem[]): PlainItem[] {
  return [...items].sort((x, y) => itemKey(x).localeCompare(itemKey(y)));
}

/** できない操作で、テーブルの中身（予約・個人情報・履歴・日ごとのアイテム・ブロック枠・下書き）が何も変わっていないことを確かめる */
async function expectNothingWritten(before: readonly PlainItem[]): Promise<void> {
  expect(sortedItems(await scanAll())).toEqual(sortedItems(before));
}

/** 日ごとのアイテムにある占有区間 */
async function dayIntervals(day: string): Promise<PlainItem[]> {
  const res = await client.send(
    new GetItemCommand({
      TableName: store.tableName,
      Key: { pk: { S: `DAY#${day}` }, sk: { S: "META" } },
      ConsistentRead: true,
    }),
  );
  if (res.Item === undefined) return [];
  return plainItem(res.Item)["intervals"] as PlainItem[];
}

/** 日ごとのアイテムにある占有区間の id（枠を確保している予約・ブロック枠） */
async function idsHolding(day: string): Promise<string[]> {
  return (await dayIntervals(day)).map((i) => String(i["id"]));
}

/** その日のアイテムにある、その id の占有区間（バッファ込み）を JST の [開始, 終わり] で返す。なければ undefined */
async function occupancy(day: string, id: string): Promise<[string, string] | undefined> {
  const found = (await dayIntervals(day)).filter((i) => i["id"] === id);
  if (found.length === 0) return undefined;
  expect(found).toHaveLength(1);
  return [storedLocal(found[0]?.["start"]), storedLocal(found[0]?.["end"])];
}

/** その id の占有区間が入っている日ごとのアイテムの日付（JST の YYYY-MM-DD）の一覧 */
async function daysHolding(id: string): Promise<string[]> {
  return (await scanAll())
    .filter((item) => String(item["pk"]).startsWith("DAY#"))
    .filter((item) => (item["intervals"] as PlainItem[]).some((i) => i["id"] === id))
    .map((item) => String(item["pk"]).slice("DAY#".length))
    .sort();
}

/** 保存された予約の id（RES#<id> / META のアイテムから） */
async function reservationIds(): Promise<string[]> {
  return (await scanAll())
    .filter((item) => String(item["pk"]).startsWith("RES#") && item["sk"] === "META")
    .map((item) => String(item["pk"]).slice("RES#".length));
}

/** 保存されたブロック枠の id（BLK#<id> / META のアイテムから） */
async function blockIds(): Promise<string[]> {
  return (await scanAll())
    .filter((item) => String(item["pk"]).startsWith("BLK#") && item["sk"] === "META")
    .map((item) => String(item["pk"]).slice("BLK#".length));
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

/** ほかの書き込みがあったことにする：日ごとのアイテムの版番号を1増やす（アイテムがなければ版番号1で作る） */
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

/** 履歴の最後の1件 */
function lastHistory(detail: AdminReservationDetail): AdminReservationDetail["history"][number] {
  const entry = detail.history.at(-1);
  if (entry === undefined) throw new Error("履歴がない");
  return entry;
}

function sameInstant(value: string, expected: DateTime): void {
  expect(DateTime.fromISO(value, { setZone: true }).toMillis(), value).toBe(expected.toMillis());
}

// ---- テスト ----

/** 本予約 A 10/20 10:00–12:00（確定金額 11,000円） */
async function prepareA(): Promise<string> {
  return applyApproved("firm", "2026-10-20T10:00", "2026-10-20T12:00", 11_000);
}

describe("予約の変更", () => {
  describe("本予約 A が 10/20 10:00–12:00（占有区間 10:00–13:00、金額 11,000円）の場合。（POST /admin/reservations/{id}/change）", () => {
    for (const [zone, toZone] of zones) {
      const z = `（日時を ${zone} で渡す）`;
      const now = toZone(jst(operatedAt));

      it(`A を 10:00–13:00 に延長：可。占有区間は 10:00–14:00。再計算した見積 16,500円を表示し、管理者が金額を確定する${z}`, async () => {
        const a = await prepareA();

        const drafts = await acceptedDrafts(
          await change(
            a,
            changeBody(toZone, "2026-10-20T10:00", "2026-10-20T13:00", { confirmedPrice: 16_500 }),
            now,
          ),
        );

        expectDrafts(drafts, [{ kind: "change", reservationId: a }]);
        expect(await occupancy("2026-10-20", a)).toEqual(["2026-10-20T10:00", "2026-10-20T14:00"]);
        const detail = await detailJson(a, now);
        expect(detail.status).toBe("firm");
        expect([local(detail.start), local(detail.end)]).toEqual([
          "2026-10-20T10:00",
          "2026-10-20T13:00",
        ]);
        // 管理者が確定した金額になる。申込のときの見積は変わらない
        expect(detail.confirmedPrice).toBe(16_500);
        expect(detail.estimate).toEqual({
          subtotalExcludingTax: 10_000,
          estimateIncludingTax: 11_000,
        });
        // 再計算した見積（2,500 × 6 = 15,000、税込 16,500）は変更の履歴に残る。誰がは API を呼んだ管理者、日時は API の現在時刻
        const entry = lastHistory(detail);
        expect(entry.operation).toBe("change");
        expect(entry.actor).toEqual({ kind: "admin", userId: adminUserId });
        sameInstant(entry.at, now);
        expect(entry.estimate).toEqual({
          subtotalExcludingTax: 15_000,
          estimateIncludingTax: 16_500,
        });
      });

      it(`本予約 B 14:00–16:00 があるときに、A を 10:00–13:00 に延長：可（占有区間 10:00–14:00。14:00で接するだけ）${z}`, async () => {
        const a = await prepareA();
        const b = await applyApproved("firm", "2026-10-20T14:00", "2026-10-20T16:00");

        const drafts = await acceptedDrafts(
          await change(
            a,
            changeBody(toZone, "2026-10-20T10:00", "2026-10-20T13:00", { confirmedPrice: 16_500 }),
            now,
          ),
        );

        expectDrafts(drafts, [{ kind: "change", reservationId: a }]);
        expect(await occupancy("2026-10-20", a)).toEqual(["2026-10-20T10:00", "2026-10-20T14:00"]);
        expect(await occupancy("2026-10-20", b)).toEqual(["2026-10-20T14:00", "2026-10-20T17:00"]);
      });

      it(`本予約 B 14:00–16:00 があるときに、A を 10:00–13:30 に延長：不可（占有区間 10:00–14:30 が B と重なる）${z}`, async () => {
        const a = await prepareA();
        await applyApproved("firm", "2026-10-20T14:00", "2026-10-20T16:00");
        const before = await scanAll();

        await expectError(
          await change(a, changeBody(toZone, "2026-10-20T10:00", "2026-10-20T13:30"), now),
          422,
          "overlaps-existing",
        );
        await expectNothingWritten(before);
      });

      it(`A を 11:00–13:00 に移動：可（変更前の自分の占有区間とは重なってよい）${z}`, async () => {
        const a = await prepareA();

        const drafts = await acceptedDrafts(
          await change(a, changeBody(toZone, "2026-10-20T11:00", "2026-10-20T13:00"), now),
        );

        expectDrafts(drafts, [{ kind: "change", reservationId: a }]);
        expect(await occupancy("2026-10-20", a)).toEqual(["2026-10-20T11:00", "2026-10-20T14:00"]);
      });

      it(`A を 10/27 10:00–12:00 に移動：可。10/20 の枠を解放し、10/27 の枠を確保する（1トランザクション）${z}`, async () => {
        const a = await prepareA();

        const drafts = await acceptedDrafts(
          await change(a, changeBody(toZone, "2026-10-27T10:00", "2026-10-27T12:00"), now),
        );

        expectDrafts(drafts, [{ kind: "change", reservationId: a }]);
        expect(await idsHolding("2026-10-20")).not.toContain(a);
        expect(await occupancy("2026-10-27", a)).toEqual(["2026-10-27T10:00", "2026-10-27T13:00"]);
        const detail = await detailJson(a, now);
        expect([local(detail.start), local(detail.end)]).toEqual([
          "2026-10-27T10:00",
          "2026-10-27T12:00",
        ]);
      });

      it(`A を 10/27 に移動したあと、10/22 に取消：キャンセル料は、利用日 10/27 の5日前として 50%${z}`, async () => {
        const a = await prepareA();
        await acceptedDrafts(
          await change(a, changeBody(toZone, "2026-10-27T10:00", "2026-10-27T12:00"), now),
        );

        const drafts = await acceptedDrafts(
          await send(
            "POST",
            `/admin/reservations/${a}/cancel`,
            {},
            toZone(jst("2026-10-22T12:00")),
          ),
        );

        expectDrafts(drafts, [
          {
            kind: "cancellation",
            reservationId: a,
            cancellationFee: { ratePercent: 50, fee: 5_500 },
          },
        ]);
      });

      it(`A を 10/20 10:00–11:00 に短縮：不可（2時間未満）${z}`, async () => {
        const a = await prepareA();
        const before = await scanAll();

        await expectError(
          await change(a, changeBody(toZone, "2026-10-20T10:00", "2026-10-20T11:00"), now),
          422,
          "shorter-than-2-hours",
        );
        await expectNothingWritten(before);
      });

      it(`A を 10/20 03:00–05:00 に移動：深夜帯にかかり4時間未満なので警告。確認すれば変えられる${z}`, async () => {
        const a = await prepareA();
        const before = await scanAll();
        const body = changeBody(toZone, "2026-10-20T03:00", "2026-10-20T05:00");

        const warnings = await expectUnacknowledged(await change(a, body, now), [
          "late-night-shorter-than-4-hours",
        ]);
        await expectNothingWritten(before);

        const drafts = await acceptedDrafts(
          await change(a, { ...body, acknowledgedWarnings: warnings }, now),
        );
        expectDrafts(drafts, [{ kind: "change", reservationId: a }]);
        expect(await occupancy("2026-10-20", a)).toEqual(["2026-10-20T03:00", "2026-10-20T06:00"]);
      });

      it(`A を 10/20 10:00–10/21 10:30 に延長：不可（24時間を超える）${z}`, async () => {
        const a = await prepareA();
        const before = await scanAll();

        await expectError(
          await change(a, changeBody(toZone, "2026-10-20T10:00", "2026-10-21T10:30"), now),
          422,
          "longer-than-24-hours",
        );
        await expectNothingWritten(before);
      });

      it(`A を 10/20 10:15–12:15 に移動：不可（30分単位でない）${z}`, async () => {
        const a = await prepareA();
        const before = await scanAll();

        await expectError(
          await change(a, changeBody(toZone, "2026-10-20T10:15", "2026-10-20T12:15"), now),
          422,
          "not-on-30-minute-boundary",
        );
        await expectNothingWritten(before);
      });

      it(`10/20 9:00 に、A を 10/20 15:00–17:00 に移動：締め切り（変更後の開始の24時間前）を過ぎているので警告。確認すれば変えられる${z}`, async () => {
        const a = await prepareA();
        const before = await scanAll();
        const at = toZone(jst("2026-10-20T09:00"));
        const body = changeBody(toZone, "2026-10-20T15:00", "2026-10-20T17:00");

        const warnings = await expectUnacknowledged(await change(a, body, at), [
          "past-24-hours-before-start",
        ]);
        await expectNothingWritten(before);

        const drafts = await acceptedDrafts(
          await change(a, { ...body, acknowledgedWarnings: warnings }, at),
        );
        expectDrafts(drafts, [{ kind: "change", reservationId: a }]);
        expect(await occupancy("2026-10-20", a)).toEqual(["2026-10-20T15:00", "2026-10-20T18:00"]);
      });

      it(`10/20 9:00 に、A の人数だけを変える：可。日時を変えないので、締め切りの警告は出さない${z}`, async () => {
        const a = await prepareA();
        const at = toZone(jst("2026-10-20T09:00"));

        const drafts = await acceptedDrafts(
          await change(
            a,
            changeBody(toZone, "2026-10-20T10:00", "2026-10-20T12:00", { partySize: 6 }),
            at,
          ),
        );

        expectDrafts(drafts, [{ kind: "change", reservationId: a }]);
        const detail = await detailJson(a, at);
        expect(detail.partySize).toBe(6);
        expect([local(detail.start), local(detail.end)]).toEqual([
          "2026-10-20T10:00",
          "2026-10-20T12:00",
        ]);
        expect(await occupancy("2026-10-20", a)).toEqual(["2026-10-20T10:00", "2026-10-20T13:00"]);
      });
    }
  });

  describe("仮予約 P が 10/20 15:00–19:00（仮予約の期限は 10/13 18:00）の場合。（POST /admin/reservations/{id}/change）", () => {
    for (const [zone, toZone] of zones) {
      const z = `（日時を ${zone} で渡す）`;

      it(`P を 11/10 15:00–19:00 に移動：仮予約のまま。期限は 11/03 18:00 になる${z}`, async () => {
        const p = await applyApproved("provisional", "2026-10-20T15:00", "2026-10-20T19:00");
        const now = toZone(jst(operatedAt));

        const drafts = await acceptedDrafts(
          await change(
            p,
            changeBody(toZone, "2026-11-10T15:00", "2026-11-10T19:00", { confirmedPrice: 22_000 }),
            now,
          ),
        );

        expectDrafts(drafts, [{ kind: "change", reservationId: p }]);
        const detail = await detailJson(p, now);
        expect(detail.status).toBe("provisional");
        expect([local(detail.start), local(detail.end)]).toEqual([
          "2026-11-10T15:00",
          "2026-11-10T19:00",
        ]);
        expect(await idsHolding("2026-10-20")).not.toContain(p);
        expect(await occupancy("2026-11-10", p)).toEqual(["2026-11-10T15:00", "2026-11-10T20:00"]);
      });

      it(`10/14 12:00 に、P を 10/18 15:00–19:00 に移動：変更後の仮予約の期限（10/11 18:00）を過ぎているので警告。確認すれば変えられる${z}`, async () => {
        const p = await applyApproved("provisional", "2026-10-20T15:00", "2026-10-20T19:00");
        const before = await scanAll();
        const at = toZone(jst("2026-10-14T12:00"));
        const body = changeBody(toZone, "2026-10-18T15:00", "2026-10-18T19:00", {
          confirmedPrice: 22_000,
        });

        const warnings = await expectUnacknowledged(await change(p, body, at), [
          "past-provisional-deadline",
        ]);
        await expectNothingWritten(before);

        const drafts = await acceptedDrafts(
          await change(p, { ...body, acknowledgedWarnings: warnings }, at),
        );
        expectDrafts(drafts, [{ kind: "change", reservationId: p }]);
        expect((await detailJson(p, at)).status).toBe("provisional");
        expect(await occupancy("2026-10-18", p)).toEqual(["2026-10-18T15:00", "2026-10-18T20:00"]);
      });
    }
  });

  describe("仮予約 P が 13:00–15:00（占有区間 13:00–16:00）、第二キープ K が 14:00–17:00（占有区間 14:00–18:00）の場合。（POST /admin/reservations/{id}/change）", () => {
    for (const [zone, toZone] of zones) {
      const z = `（日時を ${zone} で渡す）`;
      const now = toZone(jst(operatedAt));

      it(`P を 13:30–15:30 に移動：可。P と K はまだ重なっているので、K はそのまま${z}`, async () => {
        const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
        const k = await applyApproved("second-hold", "2026-10-20T14:00", "2026-10-20T17:00");

        const drafts = await acceptedDrafts(
          await change(
            p,
            changeBody(toZone, "2026-10-20T13:30", "2026-10-20T15:30", { confirmedPrice: 22_000 }),
            now,
          ),
        );

        expectDrafts(drafts, [{ kind: "change", reservationId: p }]);
        expect(await occupancy("2026-10-20", p)).toEqual(["2026-10-20T13:30", "2026-10-20T16:30"]);
        expect(await occupancy("2026-10-20", k)).toEqual(["2026-10-20T14:00", "2026-10-20T18:00"]);
        const kDetail = await detailJson(k, now);
        expect(kDetail.status).toBe("second-hold");
        expect(kDetail.provisionalIds).toEqual([p]);
      });

      it(`P を翌日 13:00–15:00 に移動：可。P と K が重ならなくなるので、K のお客様への繰り上げ案内の下書きを作る。K の枠は確保されたまま${z}`, async () => {
        const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
        const k = await applyApproved("second-hold", "2026-10-20T14:00", "2026-10-20T17:00");

        const drafts = await acceptedDrafts(
          await change(
            p,
            changeBody(toZone, "2026-10-21T13:00", "2026-10-21T15:00", { confirmedPrice: 22_000 }),
            now,
          ),
        );

        expectDrafts(drafts, [
          { kind: "change", reservationId: p },
          { kind: "move-up-notice", reservationId: k, remainingProvisionalIds: [] },
        ]);
        expect(await idsHolding("2026-10-20")).not.toContain(p);
        expect(await occupancy("2026-10-21", p)).toEqual(["2026-10-21T13:00", "2026-10-21T16:00"]);
        expect(await occupancy("2026-10-20", k)).toEqual(["2026-10-20T14:00", "2026-10-20T18:00"]);
        const kDetail = await detailJson(k, now);
        expect(kDetail.status).toBe("second-hold");
        expect(kDetail.provisionalIds ?? []).toEqual([]);
      });
    }
  });
});

describe("管理 API：予約の変更（POST /admin/reservations/{id}/change）", () => {
  for (const [zone, toZone] of zones) {
    const z = `（日時を ${zone} で渡す）`;
    const now = toZone(jst(operatedAt));

    it(`第二キープ K（仮予約 P 13:00–15:00 に付く 14:00–17:00）を変更しようとする：409 と { error: not-changeable }。何も書かない${z}`, async () => {
      await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
      const k = await applyApproved("second-hold", "2026-10-20T14:00", "2026-10-20T17:00");
      const before = await scanAll();

      await expectError(
        await change(
          k,
          changeBody(toZone, "2026-10-20T14:30", "2026-10-20T17:30", { confirmedPrice: 22_000 }),
          now,
        ),
        409,
        "not-changeable",
      );
      await expectNothingWritten(before);
    });

    it(`承認待ち（本）の予約を変更しようとする（変更できるのは承認済みの仮予約・本予約だけ）：409 と { error: not-changeable }。何も書かない${z}`, async () => {
      const x = await apply("firm", "2026-10-20T10:00", "2026-10-20T12:00");
      const before = await scanAll();

      await expectError(
        await change(x, changeBody(toZone, "2026-10-20T10:00", "2026-10-20T13:00"), now),
        409,
        "not-changeable",
      );
      await expectNothingWritten(before);
    });

    it(`取消した本予約を変更しようとする：409 と { error: not-changeable }。何も書かない${z}`, async () => {
      const a = await prepareA();
      await prepareOperation({ kind: "cancel", reservationId: a });
      const before = await scanAll();

      await expectError(
        await change(a, changeBody(toZone, "2026-10-20T10:00", "2026-10-20T13:00"), now),
        409,
        "not-changeable",
      );
      await expectNothingWritten(before);
    });

    it(`ない予約の id：404 と { error: not-found }。何も書かない${z}`, async () => {
      await prepareA();
      const before = await scanAll();

      await expectError(
        await change(
          "no-such-reservation",
          changeBody(toZone, "2026-10-20T10:00", "2026-10-20T13:00"),
          now,
        ),
        404,
        "not-found",
      );
      await expectNothingWritten(before);
    });

    it(`中身の変更（A を 10:00–13:00・12人・養生なし・機材保険あり・オプション glitter・確定金額 21,450円に）：予約の値が新しくなり、プランは B。履歴の見積は今の料金表で計算し直したもの（2,750 × 6 + 1,000 + 2,000 = 19,500、税込 21,450）${z}`, async () => {
      const a = await prepareA();

      await acceptedDrafts(
        await change(
          a,
          changeBody(toZone, "2026-10-20T10:00", "2026-10-20T13:00", {
            partySize: 12,
            equipmentInsurance: true,
            optionIds: ["glitter"],
            confirmedPrice: 21_450,
          }),
          now,
        ),
      );

      const detail = await detailJson(a, now);
      expect(detail.partySize).toBe(12);
      expect(detail.cycloramaFloorProtection).toBe(false);
      expect(detail.planId).toBe("B");
      expect(detail.equipmentInsurance).toBe(true);
      expect(detail.optionIds).toEqual(["glitter"]);
      expect(detail.confirmedPrice).toBe(21_450);
      expect(detail.estimate).toEqual({
        subtotalExcludingTax: 10_000,
        estimateIncludingTax: 11_000,
      });
      expect(lastHistory(detail).estimate).toEqual({
        subtotalExcludingTax: 19_500,
        estimateIncludingTax: 21_450,
      });
    });

    it(`見積は、渡した今の料金表で計算し直す：プランA の通常帯を 3,000円/30分 にした料金表なら、A を 10:00–13:00 に延長した見積は 18,000円・税込 19,800円${z}`, async () => {
      const a = await prepareA();
      const priceTable = PriceTable.parse({
        ...priceTableInput,
        plans: [
          { id: "A", name: "プランA", halfHourRates: { normal: 3_000, lateNight: 3_750 } },
          { id: "B", name: "プランB", halfHourRates: { normal: 2_750, lateNight: 4_125 } },
        ],
      });

      await acceptedDrafts(
        await change(a, changeBody(toZone, "2026-10-20T10:00", "2026-10-20T13:00"), now, {
          priceTable,
        }),
      );

      expect(lastHistory(await detailJson(a, now)).estimate).toEqual({
        subtotalExcludingTax: 18_000,
        estimateIncludingTax: 19_800,
      });
    });

    it(`混み合っている（A を 10/27 に移動するとき、書く直前に毎回ほかの書き込みで 10/27 の版番号が進み、やり直しの上限を超える）：503 と { error: busy }。A は 10/20 のまま枠を確保し、履歴・下書きは増えない（INV-2）${z}`, async () => {
      const a = await prepareA();
      const historyBefore = (await getReservation(store, a))?.history.length;
      const draftsBefore = await unsentDraftCount();

      await expectError(
        await change(a, changeBody(toZone, "2026-10-27T10:00", "2026-10-27T12:00"), now, {
          save: { maxAttempts: 2, beforeWrite: () => bumpDay("2026-10-27") },
        }),
        503,
        "busy",
      );

      const stored = await getReservation(store, a);
      expect(stored?.start.toMillis()).toBe(jst("2026-10-20T10:00").toMillis());
      expect(stored?.history.length).toBe(historyBefore);
      expect(await occupancy("2026-10-20", a)).toEqual(["2026-10-20T10:00", "2026-10-20T13:00"]);
      expect(await idsHolding("2026-10-27")).toEqual([]);
      expect(await unsentDraftCount()).toBe(draftsBefore);
    });
  }
});

describe("管理者による予約の直接入力とブロック枠", () => {
  describe("直接入力（POST /admin/reservations）", () => {
    for (const [zone, toZone] of zones) {
      const z = `（日時を ${zone} で渡す）`;
      const now = toZone(jst(operatedAt));

      /** 確認なしで送ると 409 と警告の一覧、何も書かれない。返った一覧を付けて送り直すと 201 で入る。入った予約の id を返す */
      async function enterAfterAcknowledging(
        body: Record<string, unknown>,
        at: DateTime,
        expected: readonly AdminWarning[],
      ): Promise<string> {
        const before = await scanAll();
        const warnings = await expectUnacknowledged(await enter(body, at), expected);
        await expectNothingWritten(before);
        return enteredId(await enter({ ...body, acknowledgedWarnings: warnings }, at));
      }

      async function expectRejected(body: Record<string, unknown>, error: string): Promise<void> {
        const before = await scanAll();
        await expectError(await enter(body, now), 422, error);
        await expectNothingWritten(before);
      }

      it(`10/20 9:00 に、管理者が 10/20 15:00–17:00 の本予約を入れる：締め切り（24時間前）を過ぎているので警告。確認すれば入る${z}`, async () => {
        const at = toZone(jst("2026-10-20T09:00"));

        const id = await enterAfterAcknowledging(
          entryBody(toZone, "firm", "2026-10-20T15:00", "2026-10-20T17:00"),
          at,
          ["past-24-hours-before-start"],
        );

        expect((await detailJson(id, at)).status).toBe("firm");
        expect(await occupancy("2026-10-20", id)).toEqual(["2026-10-20T15:00", "2026-10-20T18:00"]);
      });

      it(`管理者が 10/20 10:00–11:00 の本予約を入れる：不可（2時間未満）${z}`, async () => {
        await expectRejected(
          entryBody(toZone, "firm", "2026-10-20T10:00", "2026-10-20T11:00"),
          "shorter-than-2-hours",
        );
      });

      it(`管理者が 10/20 03:00–05:00 の本予約を入れる：深夜帯にかかり4時間未満なので警告。確認すれば入る${z}`, async () => {
        const id = await enterAfterAcknowledging(
          entryBody(toZone, "firm", "2026-10-20T03:00", "2026-10-20T05:00"),
          now,
          ["late-night-shorter-than-4-hours"],
        );

        expect((await detailJson(id, now)).status).toBe("firm");
        expect(await occupancy("2026-10-20", id)).toEqual(["2026-10-20T03:00", "2026-10-20T06:00"]);
      });

      it(`管理者が 10/20 03:00–04:30 の本予約を入れる：不可（2時間未満。深夜帯にかかっても、2時間未満は入れられない）${z}`, async () => {
        await expectRejected(
          entryBody(toZone, "firm", "2026-10-20T03:00", "2026-10-20T04:30"),
          "shorter-than-2-hours",
        );
      });

      it(`管理者が、利用日の5日前に仮予約を入れる：仮予約の期限を過ぎているので警告。確認すれば入る（10/15 12:00 に、仮予約 10/20 15:00–17:00）${z}`, async () => {
        const at = toZone(jst("2026-10-15T12:00"));

        const id = await enterAfterAcknowledging(
          entryBody(toZone, "provisional", "2026-10-20T15:00", "2026-10-20T17:00"),
          at,
          ["past-provisional-deadline"],
        );

        expect((await detailJson(id, at)).status).toBe("provisional");
        expect(await occupancy("2026-10-20", id)).toEqual(["2026-10-20T15:00", "2026-10-20T18:00"]);
      });

      it(`管理者が 10/20 10:15–12:15 の予約を入れる：不可（30分単位でない）${z}`, async () => {
        await expectRejected(
          entryBody(toZone, "firm", "2026-10-20T10:15", "2026-10-20T12:15"),
          "not-on-30-minute-boundary",
        );
      });

      it(`管理者が、既存の本予約と重なる予約を入れる：不可（空き判定）（本予約 10/20 10:00–12:00〈占有区間 10:00–13:00〉があるときの本予約 12:00–14:00）${z}`, async () => {
        await applyApproved("firm", "2026-10-20T10:00", "2026-10-20T12:00");

        await expectRejected(
          entryBody(toZone, "firm", "2026-10-20T12:00", "2026-10-20T14:00"),
          "overlaps-existing",
        );
      });

      it(`管理者が 10/20 10:00–10/21 10:30 の本予約を入れる：不可（24時間を超える）${z}`, async () => {
        await expectRejected(
          entryBody(toZone, "firm", "2026-10-20T10:00", "2026-10-21T10:30"),
          "longer-than-24-hours",
        );
      });

      it(`開始 10/20 15:00 の第二キープを、10/14 12:00 に管理者が入れる。承認済みの仮予約 P 10/20 15:00–17:00 と重なる：仮予約の期限（10/13 18:00）を過ぎているので警告。確認すれば入る。P に付く${z}`, async () => {
        const p = await applyApproved("provisional", "2026-10-20T15:00", "2026-10-20T17:00");
        const at = toZone(jst("2026-10-14T12:00"));

        const id = await enterAfterAcknowledging(
          entryBody(toZone, "second-hold", "2026-10-20T15:00", "2026-10-20T17:00"),
          at,
          ["past-provisional-deadline"],
        );

        const detail = await detailJson(id, at);
        expect(detail.status).toBe("second-hold");
        expect(detail.provisionalIds).toEqual([p]);
        expect(await idsHolding("2026-10-20")).toEqual(expect.arrayContaining([p, id]));
      });

      it(`承認済みの仮予約 P 10/20 15:00–17:00 があるときに、管理者が第二キープ 10/20 15:00–17:00 を入れる（締め切りは満たす）：第二キープとして入る。P に付く${z}`, async () => {
        const p = await applyApproved("provisional", "2026-10-20T15:00", "2026-10-20T17:00");

        const id = await enteredId(
          await enter(
            entryBody(toZone, "second-hold", "2026-10-20T15:00", "2026-10-20T17:00"),
            now,
          ),
        );

        const detail = await detailJson(id, now);
        expect(detail.status).toBe("second-hold");
        expect(detail.provisionalIds).toEqual([p]);
      });

      it(`重なる承認済みの仮予約がないときに、管理者が第二キープ 10/20 15:00–17:00 を入れる：不可（付く仮予約がない）${z}`, async () => {
        await expectRejected(
          entryBody(toZone, "second-hold", "2026-10-20T15:00", "2026-10-20T17:00"),
          "no-provisional-to-hold",
        );
      });

      it(`承認待ちの仮予約 10/20 15:00–17:00 があるときに、管理者が第二キープ 10/20 15:00–17:00 を入れる：不可（承認待ちとは重なれない）${z}`, async () => {
        await apply("provisional", "2026-10-20T15:00", "2026-10-20T17:00");
        const before = await scanAll();

        await expectRejectedWithOneOf(
          await enter(
            entryBody(toZone, "second-hold", "2026-10-20T15:00", "2026-10-20T17:00"),
            now,
          ),
          ["overlaps-existing", "no-provisional-to-hold"],
        );
        await expectNothingWritten(before);
      });
    }
  });

  describe("管理者が入れる・直す・消すブロック枠（POST /admin/blocks、PUT・DELETE /admin/blocks/{id}）", () => {
    for (const [zone, toZone] of zones) {
      const z = `（日時を ${zone} で渡す）`;
      const now = toZone(jst(operatedAt));

      it(`管理者が休業のブロック枠 10/20 00:00–10/21 00:00 をバッファなしで入れる：占有区間は 10/20 00:00–10/21 00:00。10/21 00:00–04:00 の申込は予約可${z}`, async () => {
        const id = await createdBlockId(
          await createBlock(
            blockBody(toZone, "2026-10-20T00:00", "2026-10-21T00:00", 0, "休業"),
            now,
          ),
        );

        expect(await occupancy("2026-10-20", id)).toEqual(["2026-10-20T00:00", "2026-10-21T00:00"]);
        expect(await daysHolding(id)).toEqual(["2026-10-20"]);
        expect(await applyViaWidget(toZone, "2026-10-21T00:00", "2026-10-21T04:00")).toBe(true);
      });

      it(`管理者が清掃のブロック枠 15:00–16:00 をバッファ30分で入れる：占有区間は 15:00–16:30${z}`, async () => {
        const id = await createdBlockId(
          await createBlock(
            blockBody(toZone, "2026-10-20T15:00", "2026-10-20T16:00", 30, "清掃"),
            now,
          ),
        );

        expect(await occupancy("2026-10-20", id)).toEqual(["2026-10-20T15:00", "2026-10-20T16:30"]);
      });

      it(`管理者が清掃のブロック枠 15:15–16:00 を入れる：不可（30分単位でない）${z}`, async () => {
        const before = await scanAll();

        await expectError(
          await createBlock(
            blockBody(toZone, "2026-10-20T15:15", "2026-10-20T16:00", 0, "清掃"),
            now,
          ),
          422,
          "not-on-30-minute-boundary",
        );
        await expectNothingWritten(before);
      });

      it(`管理者が休業のブロック枠 10/20 00:00–10/23 00:00 をバッファなしで入れる：入る（24時間を超えてよい）。占有区間は 10/20 00:00–10/23 00:00${z}`, async () => {
        const id = await createdBlockId(
          await createBlock(
            blockBody(toZone, "2026-10-20T00:00", "2026-10-23T00:00", 0, "休業"),
            now,
          ),
        );

        expect(await daysHolding(id)).toEqual(["2026-10-20", "2026-10-21", "2026-10-22"]);
        for (const day of ["2026-10-20", "2026-10-21", "2026-10-22"]) {
          expect(await occupancy(day, id), day).toEqual(["2026-10-20T00:00", "2026-10-23T00:00"]);
        }
      });

      it(`管理者が、既存の本予約と重なるブロック枠を入れる：不可（空き判定）（本予約 10/20 10:00–12:00〈占有区間 10:00–13:00〉があるときのブロック枠 12:00–13:00）${z}`, async () => {
        await applyApproved("firm", "2026-10-20T10:00", "2026-10-20T12:00");
        const before = await scanAll();

        await expectError(
          await createBlock(blockBody(toZone, "2026-10-20T12:00", "2026-10-20T13:00", 0), now),
          422,
          "overlaps-existing",
        );
        await expectNothingWritten(before);
      });

      it(`管理者が休業のブロック枠 2026/10/20 00:00–2027/01/18 00:00 をバッファなしで入れる：入る（かかる日がちょうど90日）${z}`, async () => {
        const id = await createdBlockId(
          await createBlock(
            blockBody(toZone, "2026-10-20T00:00", "2027-01-18T00:00", 0, "休業"),
            now,
          ),
        );

        expect(await daysHolding(id)).toEqual(jstDays("2026-10-20", 90));
      }, 60_000);

      it(`管理者が休業のブロック枠 2026/10/20 00:00–2027/01/19 00:00 をバッファなしで入れる：不可（かかる日が90日を超える）${z}`, async () => {
        const before = await scanAll();

        await expectError(
          await createBlock(
            blockBody(toZone, "2026-10-20T00:00", "2027-01-19T00:00", 0, "休業"),
            now,
          ),
          422,
          "more-than-90-days",
        );
        await expectNothingWritten(before);
      });

      it(`管理者がブロック枠 10/20 15:00–16:00（バッファなし）を消したあとに、ウィジェットから 10/20 14:00–16:00 を申込む：予約可${z}`, async () => {
        const id = await createdBlockId(
          await createBlock(blockBody(toZone, "2026-10-20T15:00", "2026-10-20T16:00", 0), now),
        );

        await expectOk(await deleteBlock(id, now));

        expect(await idsHolding("2026-10-20")).not.toContain(id);
        expect(await blockIds()).toEqual([]);
        expect(await applyViaWidget(toZone, "2026-10-20T14:00", "2026-10-20T16:00")).toBe(true);
      });

      it(`管理者がブロック枠 10/20 15:00–16:00（バッファなし）を 10/20 15:00–17:00 に直す：直る（直す前の自分の占有区間とは重なってよい）。占有区間は 15:00–17:00${z}`, async () => {
        const id = await createdBlockId(
          await createBlock(blockBody(toZone, "2026-10-20T15:00", "2026-10-20T16:00", 0), now),
        );

        await expectOk(
          await updateBlock(id, blockBody(toZone, "2026-10-20T15:00", "2026-10-20T17:00", 0), now),
        );

        expect(await occupancy("2026-10-20", id)).toEqual(["2026-10-20T15:00", "2026-10-20T17:00"]);
      });

      it(`本予約 10/20 17:00–19:00 があるときに、管理者がブロック枠 10/20 15:00–16:00（バッファなし）を 10/20 16:00–18:00 に直す：不可（空き判定）。ブロック枠は直す前のまま${z}`, async () => {
        await applyApproved("firm", "2026-10-20T17:00", "2026-10-20T19:00");
        const id = await createdBlockId(
          await createBlock(blockBody(toZone, "2026-10-20T15:00", "2026-10-20T16:00", 0), now),
        );
        const before = await scanAll();

        await expectError(
          await updateBlock(id, blockBody(toZone, "2026-10-20T16:00", "2026-10-20T18:00", 0), now),
          422,
          "overlaps-existing",
        );

        await expectNothingWritten(before);
        expect(await occupancy("2026-10-20", id)).toEqual(["2026-10-20T15:00", "2026-10-20T16:00"]);
      });

      it(`管理者がブロック枠 10/20 15:00–16:00 のバッファを「なし」から「1時間」に直す：直る。占有区間は 15:00–17:00${z}`, async () => {
        const id = await createdBlockId(
          await createBlock(blockBody(toZone, "2026-10-20T15:00", "2026-10-20T16:00", 0), now),
        );

        await expectOk(
          await updateBlock(id, blockBody(toZone, "2026-10-20T15:00", "2026-10-20T16:00", 60), now),
        );

        expect(await occupancy("2026-10-20", id)).toEqual(["2026-10-20T15:00", "2026-10-20T17:00"]);
      });

      it(`管理者が休業のブロック枠 2026/10/20 00:00–2027/01/18 00:00 を 2027/01/18 00:00–2027/04/18 00:00 に直す：不可（直す前と直したあとのかかる日を合わせて90日を超える）。消して入れ直す${z}`, async () => {
        const id = await createdBlockId(
          await createBlock(
            blockBody(toZone, "2026-10-20T00:00", "2027-01-18T00:00", 0, "休業"),
            now,
          ),
        );
        const before = await scanAll();

        await expectError(
          await updateBlock(
            id,
            blockBody(toZone, "2027-01-18T00:00", "2027-04-18T00:00", 0, "休業"),
            now,
          ),
          422,
          "more-than-90-days",
        );
        await expectNothingWritten(before);

        // 消して入れ直す：直したあとのブロック枠だけなら、かかる日はちょうど90日なので入る
        await expectOk(await deleteBlock(id, now));
        const again = await createdBlockId(
          await createBlock(
            blockBody(toZone, "2027-01-18T00:00", "2027-04-18T00:00", 0, "休業"),
            now,
          ),
        );
        expect(await daysHolding(id)).toEqual([]);
        expect(await daysHolding(again)).toEqual(jstDays("2027-01-18", 90));
      }, 60_000);

      it(`管理者が休業のブロック枠 2026/10/20 00:00–2027/01/18 00:00 を 2026/10/20 00:00–2027/01/17 00:00 に縮める：直る（両方にかかる日は1日と数えるので、合わせて90日）${z}`, async () => {
        const id = await createdBlockId(
          await createBlock(
            blockBody(toZone, "2026-10-20T00:00", "2027-01-18T00:00", 0, "休業"),
            now,
          ),
        );

        await expectOk(
          await updateBlock(
            id,
            blockBody(toZone, "2026-10-20T00:00", "2027-01-17T00:00", 0, "休業"),
            now,
          ),
        );

        expect(await daysHolding(id)).toEqual(jstDays("2026-10-20", 89));
      }, 60_000);

      it(`管理者が、Googleカレンダーから取り込んだブロック枠を消す：不可（取り込みで更新する）${z}`, async () => {
        await putCalendarBlock(
          "gcal-kaku-event-1",
          "2026-10-20",
          "2026-10-20T10:00",
          "2026-10-20T13:00",
        );
        const before = await scanAll();

        await expectError(
          await deleteBlock("gcal-kaku-event-1", now),
          409,
          "google-calendar-block",
        );
        await expectNothingWritten(before);
      });
    }
  });
});

describe("管理 API：直接入力（POST /admin/reservations）", () => {
  for (const [zone, toZone] of zones) {
    const z = `（日時を ${zone} で渡す）`;
    const now = toZone(jst(operatedAt));

    it(`電話で受けた本予約 10/22 10:00–13:00（12人・養生あり・機材保険あり・オプション2つ、確定金額 20,000円、お客様は氏名と電話番号だけ）：201 と予約の id。詳細は経路 admin・受付番号なし・バッファ60分・プランA（養生あり）・確定金額 20,000円・見積は今の料金表（2,500 × 6 + 1,000 + 2,000 × 2 = 20,000、税込 22,000）・お客様の情報は任意の欄なし。履歴は直接入力1件で、誰がは管理者の id${z}`, async () => {
      const id = await enteredId(
        await enter(
          entryBody(toZone, "firm", "2026-10-22T10:00", "2026-10-22T13:00", {
            partySize: 12,
            cycloramaFloorProtection: true,
            equipmentInsurance: true,
            optionIds: ["workshop", "glitter"],
            confirmedPrice: 20_000,
          }),
          now,
        ),
      );

      const detail = await detailJson(id, now);
      expect(detail.id).toBe(id);
      expect(detail.receiptNumber).toBeUndefined();
      expect(detail.status).toBe("firm");
      expect(detail.route).toBe("admin");
      expect([local(detail.start), local(detail.end)]).toEqual([
        "2026-10-22T10:00",
        "2026-10-22T13:00",
      ]);
      expect(detail.bufferMinutes).toBe(60);
      expect(detail.partySize).toBe(12);
      expect(detail.cycloramaFloorProtection).toBe(true);
      expect(detail.planId).toBe("A");
      expect(detail.equipmentInsurance).toBe(true);
      expect([...detail.optionIds].sort()).toEqual(["glitter", "workshop"]);
      expect(detail.estimate).toEqual({
        subtotalExcludingTax: 20_000,
        estimateIncludingTax: 22_000,
      });
      expect(detail.confirmedPrice).toBe(20_000);
      expect(detail.provisionalIds ?? []).toEqual([]);
      sameInstant(detail.createdAt, now);
      sameInstant(detail.updatedAt, now);
      local(detail.createdAt);
      expect(detail.customer).toEqual({ ...phoneCustomer });
      expect(detail.shooting).toEqual({});
      expect(detail.history).toHaveLength(1);
      const entry = lastHistory(detail);
      expect(entry.operation).toBe("direct-entry");
      expect(entry.actor).toEqual({ kind: "admin", userId: adminUserId });
      sameInstant(entry.at, now);
      expect(await occupancy("2026-10-22", id)).toEqual(["2026-10-22T10:00", "2026-10-22T14:00"]);
    });

    it(`メールで受けた仮予約 10/22 10:00–12:00（15人・養生なし。15人以上は管理者が直接入れる）：201。プランB、見積は 2,750 × 4 = 11,000、税込 12,100。お客様の情報は氏名とメールアドレスだけ${z}`, async () => {
      const id = await enteredId(
        await enter(
          entryBody(toZone, "provisional", "2026-10-22T10:00", "2026-10-22T12:00", {
            partySize: 15,
            customer: { ...emailCustomer },
          }),
          now,
        ),
      );

      const detail = await detailJson(id, now);
      expect(detail.status).toBe("provisional");
      expect(detail.partySize).toBe(15);
      expect(detail.planId).toBe("B");
      expect(detail.estimate).toEqual({
        subtotalExcludingTax: 11_000,
        estimateIncludingTax: 12_100,
      });
      expect(detail.customer).toEqual({ ...emailCustomer });
    });

    it(`お客様の情報と撮影の内容を全部入れる：詳細のお客様の情報と撮影の内容は渡したとおり${z}`, async () => {
      const id = await enteredId(
        await enter(
          entryBody(toZone, "firm", "2026-10-22T10:00", "2026-10-22T12:00", {
            customer: { ...fullCustomer },
            shooting: { ...fullShooting, types: [...fullShooting.types] },
          }),
          now,
        ),
      );

      const detail = await detailJson(id, now);
      expect(detail.customer).toEqual({ ...fullCustomer });
      expect(detail.shooting).toEqual({ ...fullShooting, types: [...fullShooting.types] });
    });

    it(`見積は、渡した今の料金表で計算する：プランA の通常帯を 3,000円/30分 にした料金表なら、10/22 10:00–12:00（3人）は 12,000円・税込 13,200円${z}`, async () => {
      const priceTable = PriceTable.parse({
        ...priceTableInput,
        plans: [
          { id: "A", name: "プランA", halfHourRates: { normal: 3_000, lateNight: 3_750 } },
          { id: "B", name: "プランB", halfHourRates: { normal: 2_750, lateNight: 4_125 } },
        ],
      });

      const id = await enteredId(
        await enter(entryBody(toZone, "firm", "2026-10-22T10:00", "2026-10-22T12:00"), now, {
          priceTable,
        }),
      );

      expect((await detailJson(id, now)).estimate).toEqual({
        subtotalExcludingTax: 12_000,
        estimateIncludingTax: 13_200,
      });
    });

    it(`入れた予約は一覧に出る：?from=2026-10-22&to=2026-10-22 に、経路 admin・状態 本予約・確定金額・氏名で出る${z}`, async () => {
      const id = await enteredId(
        await enter(entryBody(toZone, "firm", "2026-10-22T10:00", "2026-10-22T12:00"), now),
      );

      const list = await listJson("from=2026-10-22&to=2026-10-22", now);
      expect(
        list.reservations.map((r) => ({ ...r, start: local(r.start), end: local(r.end) })),
      ).toEqual([
        {
          id,
          status: "firm",
          start: "2026-10-22T10:00",
          end: "2026-10-22T12:00",
          bufferMinutes: 60,
          route: "admin",
          partySize: 3,
          estimateIncludingTax: 11_000,
          confirmedPrice: 11_000,
          customerName: phoneCustomer.name,
        },
      ]);
    });

    it(`混み合っている（書く直前に毎回ほかの書き込みで 10/22 の版番号が進み、やり直しの上限を超える）：503 と { error: busy }。予約は残らない（INV-2）${z}`, async () => {
      await expectError(
        await enter(entryBody(toZone, "firm", "2026-10-22T10:00", "2026-10-22T12:00"), now, {
          save: { maxAttempts: 2, beforeWrite: () => bumpDay("2026-10-22") },
        }),
        503,
        "busy",
      );

      expect(await reservationIds()).toEqual([]);
      expect(await idsHolding("2026-10-22")).toEqual([]);
    });
  }
});

describe("管理 API：ブロック枠（POST /admin/blocks、PUT・DELETE /admin/blocks/{id}）", () => {
  for (const [zone, toZone] of zones) {
    const z = `（日時を ${zone} で渡す）`;
    const now = toZone(jst(operatedAt));

    it(`入れたブロック枠は一覧に出る（id・区間・バッファ・経路 admin・理由のメモ）。直すと一覧も直り、メモを送らなければメモはなくなる。消すと一覧から消える${z}`, async () => {
      const id = await createdBlockId(
        await createBlock(
          blockBody(toZone, "2026-10-20T15:00", "2026-10-20T16:00", 30, "架空のメモ：清掃"),
          now,
        ),
      );
      const blocksOf = async () =>
        (await listJson("from=2026-10-20&to=2026-10-20", now)).blocks.map((b) => ({
          ...b,
          start: local(b.start),
          end: local(b.end),
        }));

      expect(await blocksOf()).toEqual([
        {
          id,
          start: "2026-10-20T15:00",
          end: "2026-10-20T16:00",
          bufferMinutes: 30,
          route: "admin",
          memo: "架空のメモ：清掃",
        },
      ]);

      await expectOk(
        await updateBlock(id, blockBody(toZone, "2026-10-20T16:00", "2026-10-20T18:00", 60), now),
      );
      expect(await blocksOf()).toEqual([
        {
          id,
          start: "2026-10-20T16:00",
          end: "2026-10-20T18:00",
          bufferMinutes: 60,
          route: "admin",
        },
      ]);

      await expectOk(await deleteBlock(id, now));
      expect(await blocksOf()).toEqual([]);
    });

    it(`Googleカレンダーから取り込んだブロック枠を直す：409 と { error: google-calendar-block }。何も書かない${z}`, async () => {
      await putCalendarBlock(
        "gcal-kaku-event-2",
        "2026-10-20",
        "2026-10-20T10:00",
        "2026-10-20T13:00",
      );
      const before = await scanAll();

      await expectError(
        await updateBlock(
          "gcal-kaku-event-2",
          blockBody(toZone, "2026-10-20T10:00", "2026-10-20T11:00", 0),
          now,
        ),
        409,
        "google-calendar-block",
      );
      await expectNothingWritten(before);
    });

    it(`ないブロック枠を直す・消す：404 と { error: not-found }。何も書かない${z}`, async () => {
      await createdBlockId(
        await createBlock(blockBody(toZone, "2026-10-20T15:00", "2026-10-20T16:00", 0), now),
      );
      const before = await scanAll();

      await expectError(
        await updateBlock(
          "no-such-block",
          blockBody(toZone, "2026-10-21T15:00", "2026-10-21T16:00", 0),
          now,
        ),
        404,
        "not-found",
      );
      await expectError(await deleteBlock("no-such-block", now), 404, "not-found");
      await expectNothingWritten(before);
    });

    it(`ブロック枠を直すとき、30分単位でない日時（15:00–16:15）：422 と { error: not-on-30-minute-boundary }。何も書かない${z}`, async () => {
      const id = await createdBlockId(
        await createBlock(blockBody(toZone, "2026-10-20T15:00", "2026-10-20T16:00", 0), now),
      );
      const before = await scanAll();

      await expectError(
        await updateBlock(id, blockBody(toZone, "2026-10-20T15:00", "2026-10-20T16:15", 0), now),
        422,
        "not-on-30-minute-boundary",
      );
      await expectNothingWritten(before);
    });

    it(`混み合っている（入れるとき、書く直前に毎回ほかの書き込みで 10/20 の版番号が進み、やり直しの上限を超える）：503 と { error: busy }。ブロック枠は残らない（INV-2）${z}`, async () => {
      await expectError(
        await createBlock(blockBody(toZone, "2026-10-20T15:00", "2026-10-20T16:00", 0), now, {
          save: { maxAttempts: 2, beforeWrite: () => bumpDay("2026-10-20") },
        }),
        503,
        "busy",
      );

      expect(await blockIds()).toEqual([]);
      expect(await idsHolding("2026-10-20")).toEqual([]);
    });

    it(`混み合っている（消すとき、書く直前に毎回ほかの書き込みで 10/20 の版番号が進み、やり直しの上限を超える）：503 と { error: busy }。ブロック枠は残る（INV-2）${z}`, async () => {
      const id = await createdBlockId(
        await createBlock(blockBody(toZone, "2026-10-20T15:00", "2026-10-20T16:00", 0), now),
      );

      await expectError(
        await deleteBlock(id, now, {
          save: { maxAttempts: 2, beforeWrite: () => bumpDay("2026-10-20") },
        }),
        503,
        "busy",
      );

      expect(await blockIds()).toEqual([id]);
      expect(await occupancy("2026-10-20", id)).toEqual(["2026-10-20T15:00", "2026-10-20T16:00"]);
    });
  }
});

describe("管理 API：警告の確認（admin-api.md「警告の確認（2回目）」）", () => {
  for (const [zone, toZone] of zones) {
    const z = `（日時を ${zone} で渡す）`;
    /** 操作の日時：10/18 12:00。10/19 の予約は開始の24時間前を過ぎ、10/25 の予約の仮予約の期限（10/18 18:00）はまだ */
    const at = toZone(jst("2026-10-18T12:00"));

    it(`直接入力：確認した警告を省略しても、空の一覧を送っても、409 と今の警告の一覧。何も書かない。返った一覧を付けて送り直すと 201 で入る${z}`, async () => {
      const body = entryBody(toZone, "firm", "2026-10-19T03:00", "2026-10-19T05:00");
      const before = await scanAll();
      const expected: AdminWarning[] = [
        "past-24-hours-before-start",
        "late-night-shorter-than-4-hours",
      ];

      await expectUnacknowledged(await enter(body, at), expected);
      const warnings = await expectUnacknowledged(
        await enter({ ...body, acknowledgedWarnings: [] }, at),
        expected,
      );
      await expectNothingWritten(before);

      const id = await enteredId(await enter({ ...body, acknowledgedWarnings: warnings }, at));
      expect(await reservationIds()).toEqual([id]);
    });

    it(`直接入力：確認した一覧が今の警告を全部含まない（10/21 03:00–05:00 で深夜帯の警告を確認したあと、日時を 10/19 03:00–05:00 に直して締め切りの警告も出た）：409 と、今の警告の一覧（確認した警告も含む全部）。何も書かない${z}`, async () => {
      const first = await expectUnacknowledged(
        await enter(entryBody(toZone, "firm", "2026-10-21T03:00", "2026-10-21T05:00"), at),
        ["late-night-shorter-than-4-hours"],
      );
      const before = await scanAll();
      const moved = entryBody(toZone, "firm", "2026-10-19T03:00", "2026-10-19T05:00", {
        acknowledgedWarnings: first,
      });

      const current = await expectUnacknowledged(await enter(moved, at), [
        "past-24-hours-before-start",
        "late-night-shorter-than-4-hours",
      ]);
      await expectNothingWritten(before);

      const id = await enteredId(await enter({ ...moved, acknowledgedWarnings: current }, at));
      expect(await occupancy("2026-10-19", id)).toEqual(["2026-10-19T03:00", "2026-10-19T06:00"]);
    });

    it(`直接入力：確認した一覧に、今は出ていない警告が入っていてもよい（本予約 10/19 10:00–12:00 に3つとも確認して送る。今の警告は締め切りだけ）：201${z}`, async () => {
      const id = await enteredId(
        await enter(
          entryBody(toZone, "firm", "2026-10-19T10:00", "2026-10-19T12:00", {
            acknowledgedWarnings: [...allWarnings],
          }),
          at,
        ),
      );
      expect(await reservationIds()).toEqual([id]);
    });

    it(`直接入力：警告のない予約（本予約 10/25 10:00–12:00）は確認なしで 201。確認した警告を付けても 201${z}`, async () => {
      await enteredId(
        await enter(entryBody(toZone, "firm", "2026-10-25T10:00", "2026-10-25T12:00"), at),
      );
      await enteredId(
        await enter(
          entryBody(toZone, "firm", "2026-10-26T10:00", "2026-10-26T12:00", {
            acknowledgedWarnings: ["late-night-shorter-than-4-hours"],
          }),
          at,
        ),
      );
      expect(await reservationIds()).toHaveLength(2);
    });

    describe("直接入力：不可の決まりは警告より先に確かめる。不可なら、警告を確認していてもいなくても 422 で何も書かない", () => {
      const cases: [
        label: string,
        setup: () => Promise<void>,
        body: () => Record<string, unknown>,
        error: string,
      ][] = [
        [
          "本予約 10/19 03:00–04:30（2時間未満。締め切りも過ぎている）",
          async () => {},
          () => entryBody(toZone, "firm", "2026-10-19T03:00", "2026-10-19T04:30"),
          "shorter-than-2-hours",
        ],
        [
          "本予約 10/19 10:15–12:15（30分単位でない。締め切りも過ぎている）",
          async () => {},
          () => entryBody(toZone, "firm", "2026-10-19T10:15", "2026-10-19T12:15"),
          "not-on-30-minute-boundary",
        ],
        [
          "本予約 10/19 10:00–10/20 10:30（24時間を超える。締め切りも過ぎている）",
          async () => {},
          () => entryBody(toZone, "firm", "2026-10-19T10:00", "2026-10-20T10:30"),
          "longer-than-24-hours",
        ],
        [
          "本予約 10/19 10:00–12:00 があるときの本予約 12:00–14:00（空き判定。締め切りも過ぎている）",
          async () => {
            await applyApproved("firm", "2026-10-19T10:00", "2026-10-19T12:00");
          },
          () => entryBody(toZone, "firm", "2026-10-19T12:00", "2026-10-19T14:00"),
          "overlaps-existing",
        ],
        [
          "重なる仮予約のない第二キープ 10/19 15:00–17:00（付く仮予約がない。仮予約の期限も過ぎている）",
          async () => {},
          () => entryBody(toZone, "second-hold", "2026-10-19T15:00", "2026-10-19T17:00"),
          "no-provisional-to-hold",
        ],
      ];

      it.each(cases)(`%s${z}`, async (_, setup, body, error) => {
        await setup();
        const before = await scanAll();

        await expectError(await enter(body(), at), 422, error);
        await expectError(
          await enter({ ...body(), acknowledgedWarnings: [...allWarnings] }, at),
          422,
          error,
        );
        await expectNothingWritten(before);
      });
    });

    it(`変更：本予約 A 10/25 10:00–12:00 を 10/25 03:00–05:00 に移動して深夜帯の警告を確認したあと、日時を 10/19 03:00–05:00 に直して締め切りの警告も出た：409 と今の警告の一覧（全部）。何も書かない。その一覧を付けて送り直すと 200${z}`, async () => {
      const a = await applyApproved("firm", "2026-10-25T10:00", "2026-10-25T12:00", 11_000);
      const before = await scanAll();

      const first = await expectUnacknowledged(
        await change(a, changeBody(toZone, "2026-10-25T03:00", "2026-10-25T05:00"), at),
        ["late-night-shorter-than-4-hours"],
      );
      const moved = changeBody(toZone, "2026-10-19T03:00", "2026-10-19T05:00", {
        acknowledgedWarnings: first,
      });
      const current = await expectUnacknowledged(await change(a, moved, at), [
        "past-24-hours-before-start",
        "late-night-shorter-than-4-hours",
      ]);
      await expectNothingWritten(before);

      const drafts = await acceptedDrafts(
        await change(a, { ...moved, acknowledgedWarnings: current }, at),
      );
      expectDrafts(drafts, [{ kind: "change", reservationId: a }]);
      expect(await occupancy("2026-10-19", a)).toEqual(["2026-10-19T03:00", "2026-10-19T06:00"]);
    });

    it(`変更：確認した一覧に、今は出ていない警告が入っていてもよい（A 10/25 10:00–12:00 を 10/25 11:00–13:00 に移動。今の警告はない）：200${z}`, async () => {
      const a = await applyApproved("firm", "2026-10-25T10:00", "2026-10-25T12:00", 11_000);

      const drafts = await acceptedDrafts(
        await change(
          a,
          changeBody(toZone, "2026-10-25T11:00", "2026-10-25T13:00", {
            acknowledgedWarnings: [...allWarnings],
          }),
          at,
        ),
      );
      expectDrafts(drafts, [{ kind: "change", reservationId: a }]);
    });

    it.each([
      [
        "10/19 03:00–04:30（2時間未満。締め切りも過ぎている）",
        "2026-10-19T03:00",
        "2026-10-19T04:30",
        "shorter-than-2-hours",
      ],
      [
        "10/19 13:00–15:00（本予約 B 10/19 14:00–16:00 と重なる。締め切りも過ぎている）",
        "2026-10-19T13:00",
        "2026-10-19T15:00",
        "overlaps-existing",
      ],
    ])(
      `変更：A 10/25 10:00–12:00 を %s に移動：警告を確認していてもいなくても 422 で何も書かない（不可の決まりは警告より先）${z}`,
      async (_, start, end, error) => {
        const a = await applyApproved("firm", "2026-10-25T10:00", "2026-10-25T12:00", 11_000);
        await applyApproved("firm", "2026-10-19T14:00", "2026-10-19T16:00");
        const before = await scanAll();

        await expectError(await change(a, changeBody(toZone, start, end), at), 422, error);
        await expectError(
          await change(
            a,
            changeBody(toZone, start, end, { acknowledgedWarnings: [...allWarnings] }),
            at,
          ),
          422,
          error,
        );
        await expectNothingWritten(before);
      },
    );
  }
});

describe("管理 API：2回目aのルートの認証と本文のパース（INV-4）", () => {
  const now = jst(operatedAt);

  /** 本文さえ正しければ成功する対象を用意し、ルートごとのあて先を返す（保存の層の関数で作る） */
  async function prepareTargets(): Promise<{ a: string; block: string }> {
    const a = await prepareA();
    const saved = await saveAdminBlock(store, {
      start: jst("2026-10-21T15:00"),
      end: jst("2026-10-21T16:00"),
      bufferMinutes: 0,
    });
    if (!saved.ok) throw new Error(`準備のブロック枠が不可になった（${saved.reason}）`);
    return { a, block: saved.id };
  }

  const validChange = (): unknown =>
    changeBody((d) => d, "2026-10-20T10:00", "2026-10-20T13:00", { confirmedPrice: 16_500 });
  const validEntry = (): unknown =>
    entryBody((d) => d, "firm", "2026-10-22T10:00", "2026-10-22T12:00");
  const validBlock = (): unknown => blockBody((d) => d, "2026-10-23T15:00", "2026-10-23T16:00", 0);

  /** どのルートも、管理者の id が取れなければ 401（本文の誤りや、ないものでも） */
  const routes: [
    label: string,
    method: "POST" | "PUT" | "DELETE",
    path: string,
    body: () => unknown,
  ][] = [
    ["予約の変更", "POST", "/admin/reservations/{a}/change", validChange],
    ["予約の変更（本文の誤り）", "POST", "/admin/reservations/{a}/change", () => ({})],
    [
      "予約の変更（ない予約）",
      "POST",
      "/admin/reservations/no-such-reservation/change",
      validChange,
    ],
    ["直接入力", "POST", "/admin/reservations", validEntry],
    ["直接入力（本文の誤り）", "POST", "/admin/reservations", () => ({ kind: "firm" })],
    ["ブロック枠を入れる", "POST", "/admin/blocks", validBlock],
    ["ブロック枠を入れる（本文の誤り）", "POST", "/admin/blocks", () => ({ bufferMinutes: 45 })],
    ["ブロック枠を直す", "PUT", "/admin/blocks/{block}", validBlock],
    ["ブロック枠を直す（ないブロック枠）", "PUT", "/admin/blocks/no-such-block", validBlock],
    ["ブロック枠を消す", "DELETE", "/admin/blocks/{block}", () => undefined],
    [
      "ブロック枠を消す（ないブロック枠）",
      "DELETE",
      "/admin/blocks/no-such-block",
      () => undefined,
    ],
  ];

  it.each(routes)(
    "管理者の id が取れない：%s（%s）は 401 と { error: unauthorized }。何も書かない",
    async (_, method, template, body) => {
      const { a, block } = await prepareTargets();
      const path = template.replace("{a}", a).replace("{block}", block);
      const before = await scanAll();

      await expectError(
        await send(method, path, body(), now, { adminUserId: () => undefined }),
        401,
        "unauthorized",
      );
      await expectNothingWritten(before);
    },
  );

  const changeBodies: [label: string, body: unknown][] = [
    ["空のオブジェクト", {}],
    [
      "開始がない（日時を変えないときも、今の日時を送る）",
      { ...(validChange() as object), start: undefined },
    ],
    [
      "人数がない（変える欄だけを送る形にはしない）",
      { ...(validChange() as object), partySize: undefined },
    ],
    ["確定金額が小数（INV-9）", { ...(validChange() as object), confirmedPrice: 16_500.5 }],
    ["日時にオフセットがない", { ...(validChange() as object), start: "2026-10-20T10:00:00" }],
    [
      "同じ警告が2回ある",
      {
        ...(validChange() as object),
        acknowledgedWarnings: [
          "late-night-shorter-than-4-hours",
          "late-night-shorter-than-4-hours",
        ],
      },
    ],
    [
      "確認した警告の名前が不正",
      { ...(validChange() as object), acknowledgedWarnings: ["overlaps-existing"] },
    ],
    ["余計なキー（状態）", { ...(validChange() as object), status: "provisional" }],
    ["null", null],
    ["配列", [validChange()]],
    ["JSON でない本文", "start=2026-10-20T10:00"],
    ["空の本文", ""],
  ];

  it.each(changeBodies)(
    "予約の変更の本文が %s：400 と { error: invalid-input }。何も書かない",
    async (_, body) => {
      const { a } = await prepareTargets();
      const before = await scanAll();

      await expectError(await change(a, body, now), 400, "invalid-input");
      await expectNothingWritten(before);
    },
  );

  const entryBodies: [label: string, body: unknown][] = [
    ["空のオブジェクト", {}],
    [
      "お客様の情報に電話番号もメールアドレスもない（連絡先は1つ必須）",
      { ...(validEntry() as object), customer: { name: "架空 連絡先なし" } },
    ],
    ["お客様の氏名がない", { ...(validEntry() as object), customer: { phone: "090-0000-7531" } }],
    [
      "お客様の氏名が空白だけ",
      { ...(validEntry() as object), customer: { name: "  ", phone: "090-0000-7531" } },
    ],
    [
      "お客様の氏名が101文字（申込フォームの上限を超える）",
      { ...(validEntry() as object), customer: { name: "架".repeat(101), phone: "090-0000-7531" } },
    ],
    [
      "メールアドレスの形が不正",
      { ...(validEntry() as object), customer: { name: "架空 形違い", email: "katachigai.kaku" } },
    ],
    [
      "電話番号が +81 で始まる",
      { ...(validEntry() as object), customer: { name: "架空 形違い", phone: "+81-90-0000-7531" } },
    ],
    [
      "住所が201文字",
      {
        ...(validEntry() as object),
        customer: { ...phoneCustomer, address: "架".repeat(201) },
      },
    ],
    ["撮影の内容がない", { ...(validEntry() as object), shooting: undefined }],
    ["撮影内容が選択肢にない", { ...(validEntry() as object), shooting: { types: ["drone"] } }],
    ["種類が承認待ち", { ...(validEntry() as object), kind: "pending-firm" }],
    ["人数がない", { ...(validEntry() as object), partySize: undefined }],
    ["確定金額がない", { ...(validEntry() as object), confirmedPrice: undefined }],
    [
      "同じ警告が2回ある",
      {
        ...(validEntry() as object),
        acknowledgedWarnings: ["past-24-hours-before-start", "past-24-hours-before-start"],
      },
    ],
    ["余計なキー（経路）", { ...(validEntry() as object), route: "admin" }],
    ["余計なキー（申込フォームの同意）", { ...(validEntry() as object), agreedToTerms: true }],
    ["null", null],
    ["JSON でない本文", "kind=firm"],
    ["空の本文", ""],
  ];

  it.each(entryBodies)(
    "直接入力の本文が %s：400 と { error: invalid-input }。何も書かない",
    async (_, body) => {
      await prepareTargets();
      const before = await scanAll();

      await expectError(await enter(body, now), 400, "invalid-input");
      await expectNothingWritten(before);
    },
  );

  const blockBodies: [label: string, body: unknown][] = [
    ["空のオブジェクト", {}],
    [
      "バッファ45分（なし／30分／1時間から選ぶ）",
      { ...(validBlock() as object), bufferMinutes: 45 },
    ],
    ["バッファが文字列", { ...(validBlock() as object), bufferMinutes: "30" }],
    [
      "バッファがない（直すときも全部を送る）",
      { ...(validBlock() as object), bufferMinutes: undefined },
    ],
    ["終わりがない", { ...(validBlock() as object), end: undefined }],
    ["理由のメモが501文字", { ...(validBlock() as object), memo: "架".repeat(501) }],
    ["日時にオフセットがない", { ...(validBlock() as object), start: "2026-10-23T15:00:00" }],
    ["余計なキー（経路）", { ...(validBlock() as object), route: "google-calendar" }],
    ["null", null],
    ["JSON でない本文", "bufferMinutes=0"],
    ["空の本文", ""],
  ];

  it.each(blockBodies)(
    "ブロック枠を入れる本文が %s：400 と { error: invalid-input }。何も書かない",
    async (_, body) => {
      await prepareTargets();
      const before = await scanAll();

      await expectError(await createBlock(body, now), 400, "invalid-input");
      await expectNothingWritten(before);
    },
  );

  it.each(blockBodies)(
    "ブロック枠を直す本文が %s：400 と { error: invalid-input }。何も書かない",
    async (_, body) => {
      const { block } = await prepareTargets();
      const before = await scanAll();

      await expectError(await updateBlock(block, body, now), 400, "invalid-input");
      await expectNothingWritten(before);
    },
  );
});

describe("管理 API：2回目aのルートのログに本文や個人情報を出さない（INV-10）", () => {
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

  it("変更・直接入力・ブロック枠（成功・警告の確認待ち・不可・できない状態・入力の誤り・混み合っている・認証なし）の処理中のログ（console、標準出力、標準エラー）に、お客様の情報と自由記述の値、本文の値が出ない", async () => {
    const id = (d: DateTime) => d;
    const now = jst(operatedAt);
    const a = await prepareA();
    await applyApproved("provisional", "2026-10-21T13:00", "2026-10-21T15:00");
    const k = await applyApproved("second-hold", "2026-10-21T14:00", "2026-10-21T17:00");
    await putCalendarBlock(
      "gcal-kaku-event-3",
      "2026-10-24",
      "2026-10-24T10:00",
      "2026-10-24T13:00",
    );
    /** 本文に入れる、ログに出てはいけない値（架空） */
    const bodyMarker = "架空の本文の値：ログに出さない";
    const memoMarker = "架空の理由のメモ：ログに出さない";
    const output = captureOutput();

    // 変更：成功・警告の確認待ち・不可・できない状態・入力の誤り・混み合っている・認証なし
    await change(a, changeBody(id, "2026-10-20T10:00", "2026-10-20T13:00"), now);
    await change(a, changeBody(id, "2026-10-20T03:00", "2026-10-20T05:00"), now);
    await change(a, changeBody(id, "2026-10-20T10:00", "2026-10-20T11:00"), now);
    await change(k, changeBody(id, "2026-10-21T14:30", "2026-10-21T17:30"), now);
    await change(
      a,
      { ...changeBody(id, "2026-10-20T10:00", "2026-10-20T13:00"), memo: bodyMarker },
      now,
    );
    await change(a, `{"memo":"${bodyMarker}"`, now);
    await change(a, changeBody(id, "2026-10-27T10:00", "2026-10-27T12:00"), now, {
      save: { maxAttempts: 1, beforeWrite: () => bumpDay("2026-10-27") },
    });
    await change(a, changeBody(id, "2026-10-20T10:00", "2026-10-20T13:00"), now, {
      adminUserId: () => undefined,
    });

    // 直接入力：成功・警告の確認待ち・不可・入力の誤り・混み合っている・認証なし
    const full = entryBody(id, "firm", "2026-10-22T10:00", "2026-10-22T12:00", {
      customer: { ...fullCustomer },
      shooting: { ...fullShooting, types: [...fullShooting.types] },
    });
    await enter(full, now);
    await enter(
      { ...full, start: iso(id, "2026-10-23T03:00"), end: iso(id, "2026-10-23T05:00") },
      now,
    );
    await enter(
      { ...full, start: iso(id, "2026-10-22T10:00"), end: iso(id, "2026-10-22T12:00") },
      now,
    );
    await enter({ ...full, customer: { ...fullCustomer, email: "not-an-email" } }, now);
    await enter({ ...full, memo: bodyMarker }, now);
    await enter(
      { ...full, start: iso(id, "2026-10-25T10:00"), end: iso(id, "2026-10-25T12:00") },
      now,
      {
        save: { maxAttempts: 1, beforeWrite: () => bumpDay("2026-10-25") },
      },
    );
    await enter(full, now, { adminUserId: () => undefined });

    // ブロック枠：入れる・直す・消す・不可・Googleカレンダーのもの・入力の誤り・混み合っている・認証なし
    const block = await createBlock(
      blockBody(id, "2026-10-26T15:00", "2026-10-26T16:00", 0, memoMarker),
      now,
    );
    const blockId =
      block.status === 201 ? AdminBlockCreated.parse(await block.json()).blockId : "x";
    await updateBlock(
      blockId,
      blockBody(id, "2026-10-26T15:00", "2026-10-26T17:00", 30, memoMarker),
      now,
    );
    await createBlock(blockBody(id, "2026-10-26T15:15", "2026-10-26T16:00", 0, memoMarker), now);
    await updateBlock(
      "gcal-kaku-event-3",
      blockBody(id, "2026-10-24T10:00", "2026-10-24T11:00", 0, memoMarker),
      now,
    );
    await deleteBlock("gcal-kaku-event-3", now);
    await createBlock(
      { ...blockBody(id, "2026-10-26T18:00", "2026-10-26T19:00", 0), extra: bodyMarker },
      now,
    );
    await createBlock(blockBody(id, "2026-10-28T15:00", "2026-10-28T16:00", 0, memoMarker), now, {
      save: { maxAttempts: 1, beforeWrite: () => bumpDay("2026-10-28") },
    });
    await createBlock(blockBody(id, "2026-10-29T15:00", "2026-10-29T16:00", 0, memoMarker), now, {
      adminUserId: () => undefined,
    });
    await deleteBlock(blockId, now);

    const text = output();
    for (const value of [...personalValues, bodyMarker, memoMarker]) {
      expect(text).not.toContain(value);
    }
  });
});

describe("管理 API：直接入力・変更・ブロック枠を続けても、占有区間は重ならない（INV-1。プロパティベーステスト）", () => {
  /** 10/20 00:00 から30分ごとの枠（2日分） */
  const slotStart = (slot: number): string =>
    jst("2026-10-20T00:00")
      .plus({ minutes: 30 * slot })
      .toFormat("yyyy-MM-dd'T'HH:mm");
  const slotEnd = (slot: number, length: number): string => slotStart(slot + length);

  const operation = fc.oneof(
    fc.record({
      type: fc.constant("enter" as const),
      kind: fc.constantFrom("firm" as const, "provisional" as const),
      slot: fc.integer({ min: 0, max: 90 }),
      length: fc.integer({ min: 4, max: 10 }),
    }),
    fc.record({
      type: fc.constant("change" as const),
      target: fc.nat(),
      slot: fc.integer({ min: 0, max: 90 }),
      length: fc.integer({ min: 4, max: 10 }),
    }),
    fc.record({
      type: fc.constant("block" as const),
      slot: fc.integer({ min: 0, max: 90 }),
      length: fc.integer({ min: 1, max: 6 }),
      buffer: fc.constantFrom(0 as const, 30 as const, 60 as const),
    }),
    fc.record({
      type: fc.constant("update-block" as const),
      target: fc.nat(),
      slot: fc.integer({ min: 0, max: 90 }),
      length: fc.integer({ min: 1, max: 6 }),
      buffer: fc.constantFrom(0 as const, 30 as const, 60 as const),
    }),
    fc.record({ type: fc.constant("delete-block" as const), target: fc.nat() }),
  );

  it("どの順に操作しても（警告はすべて確認して送る）、返事は 200・201・422 のどれかで、日ごとのアイテムの占有区間は互いに重ならない", async () => {
    const now = jst(operatedAt);
    await fc.assert(
      fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 6 }), async (operations) => {
        await deleteTable(store);
        store = await createTable();
        const reservations: string[] = [];
        const blocks: string[] = [];
        const pick = (ids: readonly string[], target: number) =>
          ids.length === 0 ? "no-such-id" : (ids[target % ids.length] ?? "no-such-id");

        for (const op of operations) {
          const ack = { acknowledgedWarnings: [...allWarnings] };
          if (op.type === "enter") {
            const res = await enter(
              entryBody((d) => d, op.kind, slotStart(op.slot), slotEnd(op.slot, op.length), ack),
              now,
            );
            expect([201, 422]).toContain(res.status);
            if (res.status === 201) {
              reservations.push(AdminDirectEntryAccepted.parse(await res.json()).reservationId);
            }
          } else if (op.type === "change") {
            if (reservations.length === 0) continue;
            const res = await change(
              pick(reservations, op.target),
              changeBody((d) => d, slotStart(op.slot), slotEnd(op.slot, op.length), ack),
              now,
            );
            expect([200, 422]).toContain(res.status);
          } else if (op.type === "block") {
            const res = await createBlock(
              blockBody((d) => d, slotStart(op.slot), slotEnd(op.slot, op.length), op.buffer),
              now,
            );
            expect([201, 422]).toContain(res.status);
            if (res.status === 201) {
              blocks.push(AdminBlockCreated.parse(await res.json()).blockId);
            }
          } else if (op.type === "update-block") {
            if (blocks.length === 0) continue;
            const res = await updateBlock(
              pick(blocks, op.target),
              blockBody((d) => d, slotStart(op.slot), slotEnd(op.slot, op.length), op.buffer),
              now,
            );
            expect([200, 422]).toContain(res.status);
          } else {
            if (blocks.length === 0) continue;
            const target = pick(blocks, op.target);
            const res = await deleteBlock(target, now);
            expect(res.status).toBe(200);
            blocks.splice(blocks.indexOf(target), 1);
          }
        }

        for (const item of await scanAll()) {
          if (!String(item["pk"]).startsWith("DAY#")) continue;
          const intervals = (item["intervals"] as PlainItem[]).map((i) => ({
            id: String(i["id"]),
            start: DateTime.fromISO(String(i["start"])).toMillis(),
            end: DateTime.fromISO(String(i["end"])).toMillis(),
          }));
          for (const [i, x] of intervals.entries()) {
            for (const y of intervals.slice(i + 1)) {
              expect(
                x.start < y.end && y.start < x.end,
                `${String(item["pk"])} ${x.id} ${y.id}`,
              ).toBe(false);
            }
          }
        }
      }),
      { numRuns: 15 },
    );
  }, 120_000);
});
