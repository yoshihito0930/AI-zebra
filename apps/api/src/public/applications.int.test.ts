import {
  type AttributeValue,
  CreateTableCommand,
  DeleteTableCommand,
  GetItemCommand,
  ScanCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  ApplicationAccepted,
  ApplicationRejected,
  type ApplicationRejection,
  PriceTable,
  ReceiptNumber,
  Yen,
} from "@zebra/contracts";
import fc from "fast-check";
import { DateTime } from "luxon";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalDynamoClient } from "../db/client.ts";
import { saveReservationOperation } from "../db/operations.ts";
import {
  type ApplicationKind,
  type ReservationApplication,
  type ReservationStore,
  getReservation,
  saveApplication,
} from "../db/reservations.ts";
import {
  type ApplicationDeps,
  type ApplicationResult,
  createPublicApplicationRoute,
  submitApplication,
} from "./applications.ts";

// 公開API（認証なし）の申込の統合テスト（DynamoDB Local）。
// 根拠：docs/product-specs/booking.md の「申込フォーム」（例の表のすべての行）、「時間の単位と利用時間」「申込の締め切り」
// 「料金」「空き判定」「第二キープ」、docs/design-docs/dynamodb-keys.md（受付番号 RCPT#<受付番号>、書き込みの手順）、
// reservation-model.md（予約が持つもの、状態と操作）、core-beliefs.md（INV-1、INV-2、INV-3、INV-4、INV-7、INV-9、INV-10）、
// packages/contracts の ApplicationRequest・ApplicationAccepted・ApplicationRejected・ReceiptNumber。
// 時間の単位・締め切り・料金・空き判定の細かい決まりは booking-core と db の単体・統合テストで確かめているので、
// ここでは代表的な行と、それが API の返事と DB に正しく現れること（不可なら何も残らないこと）を確かめる。
// 第二キープ申込の締め切りは未決事項（booking.md）なのでテストしない。受付通知（確認メール）は次の PR で扱う。
// 予約の META と受付番号のアイテムの属性名は資料にないので、予約の詳細（getReservation）とアイテムの中の値で確かめる。
// 申込の回数の制限、CAPTCHA、CORS などは資料にないのでテストしない。

const client = createLocalDynamoClient();
let store: ReservationStore;

// テーブルはキー設計どおり（pk・sk、GSI の gsi1pk・gsi1sk）にテストごとに作り、終わったら消す
async function createTable(): Promise<ReservationStore> {
  const tableName = `int-test-app-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
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

/** JST で書いた日時を、申込の本文の形（ISO 8601、+09:00 のオフセット付き）にする */
function isoJst(local: string): string {
  return jst(local).toISO({ suppressMilliseconds: true }) ?? "";
}

/** JST で書いた日時と同じ時点を、UTC で表した ISO 8601 にする（INV-7 の確認に使う） */
function isoUtc(local: string): string {
  return jst(local).toUTC().toISO({ suppressMilliseconds: true }) ?? "";
}

/** 申込の時刻（固定）。締め切りにかからないよう、利用日（10/20 ごろ）より十分前に置く */
const appliedAt = jst("2026-10-01T12:00");
/** テストの準備でする承認の時刻（固定） */
const preparedAt = jst("2026-10-02T12:00");

/** 承認した管理者（架空のユーザー id） */
const adminUserId = "admin-user-kaku-app";

// ---- 料金表（booking.md「料金」の単価・追加・プランの決め方から作る） ----

const specPriceTable = PriceTable.parse({
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
});

// ---- 架空のお客様の情報（INV-10 の確認に使うので、ほかの値と紛れない文字列にする） ----

const customer = {
  name: "架空 四郎",
  companyName: "架空撮影株式会社",
  email: "shiro.kaku@example.com",
  phone: "090-0000-3456",
  address: "架空県架空市架空通10-11-12",
  photographerName: "仮名 撮影三郎",
} as const;

const shooting = {
  types: ["still", "movie"],
  details: "架空の撮影詳細：靴の商品写真の撮影",
  notes: "架空の補足事項：機材車を1台停めたい",
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

/** 予約の状態の値（INV-3。返事に出ないことの確認に使う） */
const statusValues: readonly string[] = [
  "pending-provisional",
  "pending-firm",
  "pending-second-hold",
  "provisional",
  "second-hold",
  "cancelled",
  "ended",
];

// ---- 申込の本文 ----

type Body = Record<string, unknown>;

/**
 * 契約（ApplicationRequest）どおりの申込の本文。日時は JST で書き、+09:00 のオフセット付きで渡す。
 * 人数4人・養生なし（プランA）、機材保険なし、オプションなし
 */
function body(kind: ApplicationKind, start: string, end: string, overrides: Body = {}): Body {
  return {
    kind,
    start: isoJst(start),
    end: isoJst(end),
    partySize: 4,
    cycloramaFloorProtection: false,
    equipmentInsurance: false,
    optionIds: [],
    customer: { ...customer },
    shooting: { ...shooting, types: [...shooting.types] },
    agreedToCycloramaRules: true,
    agreedToTerms: true,
    ...overrides,
  };
}

/** body と同じ申込の、日時を UTC で表したもの（INV-7） */
function utcBody(kind: ApplicationKind, start: string, end: string, overrides: Body = {}): Body {
  return { ...body(kind, start, end, overrides), start: isoUtc(start), end: isoUtc(end) };
}

/** 正しい申込の本文（入力のパースの確認のもとにする） */
const valid = body("firm", "2026-10-20T10:00", "2026-10-20T12:00");

// ---- 申込を送る道具 ----

function deps(overrides: Partial<ApplicationDeps> = {}): ApplicationDeps {
  return { store, now: () => appliedAt, priceTable: specPriceTable, ...overrides };
}

async function submit(
  value: unknown,
  overrides: Partial<ApplicationDeps> = {},
): Promise<ApplicationResult> {
  return submitApplication(deps(overrides), value);
}

async function submitOk(
  value: unknown,
  overrides: Partial<ApplicationDeps> = {},
): Promise<ApplicationAccepted> {
  const result = await submit(value, overrides);
  if (!result.ok) {
    throw new Error(`受付になるはずが不可になった（${result.reason}）`);
  }
  return result.accepted;
}

/** POST /applications に送る。value が文字列ならそのまま本文にし、それ以外は JSON にする */
async function post(value: unknown, overrides: Partial<ApplicationDeps> = {}): Promise<Response> {
  const route = createPublicApplicationRoute(deps(overrides));
  return route.request("/applications", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof value === "string" ? value : JSON.stringify(value),
  });
}

// ---- テーブルを直接読み書きする道具（DynamoDB の属性の形を、普通の値に直す） ----

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

/** アイテムの中の文字列の値を、入れ子も含めてすべて集める */
function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(stringsIn);
  return [];
}

async function scanAll(target: ReservationStore = store): Promise<PlainItem[]> {
  const items: PlainItem[] = [];
  let startKey: Record<string, AttributeValue> | undefined;
  do {
    const res = await client.send(
      new ScanCommand({
        TableName: target.tableName,
        ConsistentRead: true,
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...(res.Items ?? []).map(plainItem));
    startKey = res.LastEvaluatedKey;
  } while (startKey !== undefined);
  return items;
}

async function getItem(
  pk: string,
  sk: string,
  target: ReservationStore = store,
): Promise<PlainItem | undefined> {
  const res = await client.send(
    new GetItemCommand({
      TableName: target.tableName,
      Key: { pk: { S: pk }, sk: { S: sk } },
      ConsistentRead: true,
    }),
  );
  return res.Item === undefined ? undefined : plainItem(res.Item);
}

/** 保存された予約の id（RES#<id> / META のアイテムから） */
async function reservationIds(target: ReservationStore = store): Promise<string[]> {
  return (await scanAll(target))
    .filter((item) => String(item["pk"]).startsWith("RES#") && item["sk"] === "META")
    .map((item) => String(item["pk"]).slice("RES#".length));
}

/** 受付番号のアイテム（RCPT#<受付番号> / META） */
async function receiptItems(target: ReservationStore = store): Promise<PlainItem[]> {
  return (await scanAll(target)).filter((item) => String(item["pk"]).startsWith("RCPT#"));
}

/** テーブルの中身がそのままか（不可のときに何も書かれていないこと）を確かめる */
async function expectNothingWritten(
  before: PlainItem[],
  target: ReservationStore = store,
): Promise<void> {
  const after = await scanAll(target);
  const key = (item: PlainItem) => `${String(item["pk"])} ${String(item["sk"])}`;
  expect([...after].sort((x, y) => key(x).localeCompare(key(y)))).toEqual(
    [...before].sort((x, y) => key(x).localeCompare(key(y))),
  );
}

/** 申込が受付になり、ちょうど1件増えた予約の id を返す */
async function newReservationId(before: readonly string[]): Promise<string> {
  const added = (await reservationIds()).filter((id) => !before.includes(id));
  expect(added).toHaveLength(1);
  return added[0] ?? "";
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

/** 2件の申込がどちらも「読んで判定した」ところで待ち合わせ、それから書かせる（必ず衝突させる） */
function meetBeforeFirstWrite(parties: number): (attempt: number) => Promise<void> {
  let arrived = 0;
  let release: () => void = () => {};
  const allArrived = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async (attempt) => {
    if (attempt !== 1) return;
    arrived += 1;
    if (arrived === parties) release();
    await allArrived;
  };
}

// ---- 準備の道具（すでにある予約は、保存の関数と承認の保存で作る） ----

/** 準備の予約のお客様（架空） */
const otherCustomer = {
  name: "架空 準備五郎",
  email: "goro.kaku@example.com",
  phone: "090-0000-7890",
  address: "架空県架空市準備町1-1-1",
  photographerName: "仮名 準備写真",
} as const;

function preparedApplication(
  kind: ApplicationKind,
  start: string,
  end: string,
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
    customer: otherCustomer,
    shooting: { types: ["still"], details: "架空の準備の撮影" },
  };
}

/** 申込む（準備）。承認待ちになる */
async function prepare(kind: ApplicationKind, start: string, end: string): Promise<string> {
  const result = await saveApplication(store, preparedApplication(kind, start, end), {
    now: appliedAt,
  });
  if (!result.ok) {
    throw new Error(`準備の申込が不可になった（${kind} ${start}–${end}、${result.reason}）`);
  }
  return result.id;
}

/** 申込んで承認する（準備）。仮予約・本予約・第二キープになる */
async function prepareApproved(kind: ApplicationKind, start: string, end: string): Promise<string> {
  const id = await prepare(kind, start, end);
  const result = await saveReservationOperation(
    store,
    { kind: "approve", reservationId: id, confirmedPrice: Yen.parse(11_000) },
    { now: preparedAt, adminUserId },
  );
  if (!result.ok) {
    throw new Error(`準備の承認が不可になった（${id}、${result.reason}）`);
  }
  return id;
}

/** オブジェクトから、指定のキーを除いたもの（項目を送らない申込を作るのに使う） */
function without(value: object, key: string): Body {
  return Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));
}

// ---- 比べる道具 ----

function rejected(reason: ApplicationRejection): ApplicationResult {
  return { ok: false, reason };
}

/** 受け付けたときの返事が、契約どおり受付番号と見積額だけであることを確かめる */
function expectAcceptedShape(value: unknown): ApplicationAccepted {
  expect(ApplicationAccepted.safeParse(value).success).toBe(true);
  expect(Object.keys(value as object).sort()).toEqual(["estimateIncludingTax", "receiptNumber"]);
  return ApplicationAccepted.parse(value);
}

/** 返事（JSON の文字列）に、予約の id・状態（INV-3）・お客様の情報（INV-10）が入らないことを確かめる */
function expectNothingPrivateIn(text: string, ids: readonly string[]): void {
  for (const value of [...ids, ...statusValues, ...personalValues]) {
    expect(text).not.toContain(value);
  }
}

// ---- テスト ----

describe("申込フォーム", () => {
  it("人数 10：プランA", async () => {
    const accepted = await submitOk(
      body("firm", "2026-10-20T10:00", "2026-10-20T12:00", {
        partySize: 10,
        cycloramaFloorProtection: false,
      }),
    );

    // プランA 通常 2,500 × 4 = 10,000 → 税込 11,000（プランB なら 12,100）
    expect(accepted.estimateIncludingTax).toBe(11_000);
    const [id] = await reservationIds();
    expect((await getReservation(store, id ?? ""))?.planId).toBe("A");
  });

  it("人数 11：プランB", async () => {
    const accepted = await submitOk(
      body("firm", "2026-10-20T10:00", "2026-10-20T12:00", {
        partySize: 11,
        cycloramaFloorProtection: false,
      }),
    );

    // プランB 通常 2,750 × 4 = 11,000 → 税込 12,100
    expect(accepted.estimateIncludingTax).toBe(12_100);
    const [id] = await reservationIds();
    expect((await getReservation(store, id ?? ""))?.planId).toBe("B");
  });

  it("人数 15：選べない（問い合わせに案内）", async () => {
    const before = await scanAll();

    expect(await submit({ ...valid, partySize: 15 })).toEqual(rejected("invalid-input"));
    await expectNothingWritten(before);
  });

  it("利用規約への同意なし：送信できない", async () => {
    const before = await scanAll();
    expect(await submit({ ...valid, agreedToTerms: false })).toEqual(rejected("invalid-input"));
    expect(await submit(without(valid, "agreedToTerms"))).toEqual(rejected("invalid-input"));
    await expectNothingWritten(before);
  });

  it("会社名・補足事項が空：送信できる", async () => {
    // 空の文字列で送る
    const empty = await submit(
      body("firm", "2026-10-20T10:00", "2026-10-20T12:00", {
        customer: { ...customer, companyName: "" },
        shooting: { ...shooting, types: [...shooting.types], notes: "" },
      }),
    );
    expect(empty.ok).toBe(true);

    // 項目ごと送らない
    const omitted = await submit(
      body("firm", "2026-10-21T10:00", "2026-10-21T12:00", {
        customer: without(customer, "companyName"),
        shooting: { ...without(shooting, "notes"), types: [...shooting.types] },
      }),
    );
    expect(omitted.ok).toBe(true);
    expect(await reservationIds()).toHaveLength(2);
  });

  it("開始 10/20 15:00、送信 10/13 18:00、予約の種類＝仮予約：不可（仮予約の期限を過ぎた。本予約なら受付）", async () => {
    const now = () => jst("2026-10-13T18:00");
    const before = await scanAll();

    expect(
      await submit(body("provisional", "2026-10-20T15:00", "2026-10-20T17:00"), { now }),
    ).toEqual(rejected("past-provisional-deadline"));
    await expectNothingWritten(before);

    expect((await submit(body("firm", "2026-10-20T15:00", "2026-10-20T17:00"), { now })).ok).toBe(
      true,
    );
  });

  it("希望日時が承認済みの仮予約 P と重なり、P に第二キープがない：第二キープとして申込める", async () => {
    // 仮予約 P 13:00–15:00（占有区間 13:00–16:00）。第二キープの希望 14:00–17:00
    const p = await prepareApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    const before = await reservationIds();

    const result = await submit(body("second-hold", "2026-10-20T14:00", "2026-10-20T17:00"));

    expect(result.ok).toBe(true);
    const detail = await getReservation(store, await newReservationId(before));
    expect(detail?.status).toBe("pending-second-hold");
    expect(detail?.provisionalIds).toEqual([p]);
  });

  it("希望日時が本予約と重なる：申込めない（空き判定で不可）", async () => {
    // 本予約 10:00–12:00（占有区間 10:00–13:00）。希望 11:00–13:00
    await prepareApproved("firm", "2026-10-20T10:00", "2026-10-20T12:00");
    const before = await scanAll();

    expect(await submit(body("firm", "2026-10-20T11:00", "2026-10-20T13:00"))).toEqual(
      rejected("overlaps-existing"),
    );
    expect(await submit(body("provisional", "2026-10-20T11:00", "2026-10-20T13:00"))).toEqual(
      rejected("overlaps-existing"),
    );
    await expectNothingWritten(before);
  });

  describe("UTC で渡しても同じ結果（INV-7）", () => {
    it("開始 10/20 15:00、送信 10/13 18:00、予約の種類＝仮予約：不可（仮予約の期限を過ぎた。本予約なら受付）", async () => {
      const now = () => jst("2026-10-13T18:00").toUTC();
      const before = await scanAll();

      expect(
        await submit(utcBody("provisional", "2026-10-20T15:00", "2026-10-20T17:00"), { now }),
      ).toEqual(rejected("past-provisional-deadline"));
      await expectNothingWritten(before);

      expect(
        (await submit(utcBody("firm", "2026-10-20T15:00", "2026-10-20T17:00"), { now })).ok,
      ).toBe(true);
    });
  });
});

describe("申込の API：入力のパース（INV-4）", () => {
  const customerWithoutName = without(customer, "name");
  const invalidBodies: [string, unknown][] = [
    ["空のオブジェクト", {}],
    ["null", null],
    ["配列", [valid]],
    ["文字列", "申込"],
    ["予約の種類が不正（pending-firm）", { ...valid, kind: "pending-firm" }],
    ["予約の種類がない", { ...valid, kind: undefined }],
    ["日時にオフセットがない", { ...valid, start: "2026-10-20T10:00:00" }],
    ["日時が日時の形でない", { ...valid, end: "10/20 12:00" }],
    ["人数 0", { ...valid, partySize: 0 }],
    ["人数が整数でない（4.5）", { ...valid, partySize: 4.5 }],
    ["人数が文字列", { ...valid, partySize: "4" }],
    ["ホリゾントの養生がない", { ...valid, cycloramaFloorProtection: undefined }],
    ["ホリゾントルールの確認なし", { ...valid, agreedToCycloramaRules: false }],
    ["メールアドレスの形が不正", { ...valid, customer: { ...customer, email: "shiro@example" } }],
    ["電話番号が +81 から", { ...valid, customer: { ...customer, phone: "+81-90-0000-3456" } }],
    ["電話番号の桁が足りない", { ...valid, customer: { ...customer, phone: "090-000-000" } }],
    ["氏名がない", { ...valid, customer: customerWithoutName }],
    ["住所が空", { ...valid, customer: { ...customer, address: " " } }],
    ["氏名が長すぎる（101文字）", { ...valid, customer: { ...customer, name: "架".repeat(101) } }],
    ["撮影内容がない", { ...valid, shooting: { ...shooting, types: [] } }],
    ["撮影内容が選択肢にない", { ...valid, shooting: { ...shooting, types: ["drone"] } }],
    ["撮影詳細が空", { ...valid, shooting: { ...shooting, details: "" } }],
    [
      "撮影詳細が長すぎる（2001文字）",
      { ...valid, shooting: { ...shooting, details: "架".repeat(2001) } },
    ],
    ["同じオプションが2回", { ...valid, optionIds: ["workshop", "workshop"] }],
    ["余計なキー（状態）", { ...valid, status: "firm" }],
    ["余計なキー（予約の id）", { ...valid, id: "r-1" }],
    ["余計なキー（プラン。プランはお客様に選ばせない）", { ...valid, planId: "A" }],
    ["余計なキー（金額）", { ...valid, estimateIncludingTax: 1 }],
    ["お客様の情報に余計なキー", { ...valid, customer: { ...customer, memberId: "m-1" } }],
  ];

  it.each(invalidBodies)("%s：invalid-input。何も保存しない", async (_, value) => {
    const before = await scanAll();

    expect(await submit(value)).toEqual(rejected("invalid-input"));
    await expectNothingWritten(before);
  });

  it.each(invalidBodies)(
    "%s を JSON にして POST /applications に送る：400 と { error: invalid-input }。何も保存しない",
    async (_, value) => {
      const before = await scanAll();

      const res = await post(JSON.stringify(value));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid-input" });
      await expectNothingWritten(before);
    },
  );

  it.each([
    ["JSON でない本文", "kind=firm&start=2026-10-20T10:00"],
    ["途中で切れた JSON", JSON.stringify(valid).slice(0, 40)],
    ["空の本文", ""],
  ])(
    "%s を POST /applications に送る：400 と { error: invalid-input }。何も保存しない",
    async (_, text) => {
      const before = await scanAll();

      const res = await post(text);

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid-input" });
      await expectNothingWritten(before);
    },
  );
});

describe("申込の API：時間の単位と利用時間", () => {
  const cases: [string, string, string, ApplicationRejection][] = [
    [
      "10/20 10:15–12:15：予約不可（30分単位でない）",
      "2026-10-20T10:15",
      "2026-10-20T12:15",
      "not-on-30-minute-boundary",
    ],
    [
      "10/20 10:00–11:30：予約不可（2時間未満）",
      "2026-10-20T10:00",
      "2026-10-20T11:30",
      "shorter-than-2-hours",
    ],
    [
      "10/20 03:00–05:00：予約不可（深夜帯にかかり、4時間未満）",
      "2026-10-20T03:00",
      "2026-10-20T05:00",
      "late-night-shorter-than-4-hours",
    ],
    [
      "10/20 10:00–10/21 10:30：予約不可（24時間を超える）",
      "2026-10-20T10:00",
      "2026-10-21T10:30",
      "longer-than-24-hours",
    ],
  ];

  it.each(cases)("%s。何も保存しない", async (_, start, end, reason) => {
    const before = await scanAll();

    expect(await submit(body("firm", start, end))).toEqual(rejected(reason));
    await expectNothingWritten(before);
  });

  it.each([
    [
      "10/20 03:00–07:00：予約可（深夜帯にかかり、ちょうど4時間）",
      "2026-10-20T03:00",
      "2026-10-20T07:00",
    ],
    ["10/20 10:00–10/21 10:00：予約可（ちょうど24時間）", "2026-10-20T10:00", "2026-10-21T10:00"],
  ])("%s", async (_, start, end) => {
    expect((await submit(body("firm", start, end))).ok).toBe(true);
  });

  it("10/20 03:00–05:00 を UTC（10/19 18:00–20:00）で渡す：予約不可（深夜帯にかかり、4時間未満。UTCの時刻では深夜帯にかからないが、判定はJST）", async () => {
    const before = await scanAll();

    expect(await submit(utcBody("firm", "2026-10-20T03:00", "2026-10-20T05:00"))).toEqual(
      rejected("late-night-shorter-than-4-hours"),
    );
    await expectNothingWritten(before);
  });

  it("10/20 10:00–12:00 を UTC（10/20 01:00–03:00）で渡す：予約可（UTCの時刻では深夜帯にかかるが、判定はJST）", async () => {
    expect((await submit(utcBody("firm", "2026-10-20T10:00", "2026-10-20T12:00"))).ok).toBe(true);
  });
});

describe("申込の API：申込の締め切り", () => {
  // 開始が 10/20 15:00 の場合、仮予約の期限は 10/13 18:00、24時間前は 10/19 15:00。
  // 本予約申込と仮予約申込は同じ時間を申込むので、それぞれ別のテーブルで確かめる
  type Expectation = "accepted" | ApplicationRejection;
  type Zone = "jst" | "utc";

  async function check(
    kind: "firm" | "provisional",
    appliedLocal: string,
    expected: Expectation,
    zone: Zone,
  ): Promise<void> {
    const own = await createTable();
    try {
      const make = zone === "jst" ? body : utcBody;
      const now = zone === "jst" ? jst(appliedLocal) : jst(appliedLocal).toUTC();
      const result = await submitApplication(
        { store: own, now: () => now, priceTable: specPriceTable },
        make(kind, "2026-10-20T15:00", "2026-10-20T17:00"),
      );
      if (expected === "accepted") {
        expect(result.ok, `${kind} ${appliedLocal}`).toBe(true);
        expect(await reservationIds(own)).toHaveLength(1);
      } else {
        expect(result, `${kind} ${appliedLocal}`).toEqual(rejected(expected));
        expect(await scanAll(own)).toEqual([]);
      }
    } finally {
      await deleteTable(own);
    }
  }

  const rows: [string, string, Expectation, Expectation][] = [
    [
      "開始 10/20 15:00、申込 10/13 17:59：本予約申込は受付、仮予約申込は受付",
      "2026-10-13T17:59",
      "accepted",
      "accepted",
    ],
    [
      "開始 10/20 15:00、申込 10/13 18:00：本予約申込は受付、仮予約申込は不可（期限を過ぎた）",
      "2026-10-13T18:00",
      "accepted",
      "past-provisional-deadline",
    ],
    [
      "開始 10/20 15:00、申込 10/19 14:59：本予約申込は受付、仮予約申込は不可",
      "2026-10-19T14:59",
      "accepted",
      "past-provisional-deadline",
    ],
    [
      "開始 10/20 15:00、申込 10/19 15:00：本予約申込は不可（ちょうど24時間前）、仮予約申込は不可",
      "2026-10-19T15:00",
      "past-24-hours-before-start",
      "past-provisional-deadline",
    ],
  ];

  it.each(rows)("%s", async (_, appliedLocal, firm, provisional) => {
    await check("firm", appliedLocal, firm, "jst");
    await check("provisional", appliedLocal, provisional, "jst");
  });

  describe("UTC で渡しても同じ結果（INV-7）", () => {
    it.each(rows)("%s", async (_, appliedLocal, firm, provisional) => {
      await check("firm", appliedLocal, firm, "utc");
      await check("provisional", appliedLocal, provisional, "utc");
    });
  });
});

describe("申込の API：空き判定", () => {
  it("既存の本予約 09:00–12:00（占有区間 09:00–13:00）があるときの申込 13:00–15:00：予約可（13:00で接するだけ。間は1時間）", async () => {
    await prepareApproved("firm", "2026-10-20T09:00", "2026-10-20T12:00");

    expect((await submit(body("firm", "2026-10-20T13:00", "2026-10-20T15:00"))).ok).toBe(true);
  });

  it("既存の本予約 09:00–12:00（占有区間 09:00–13:00）があるときの申込 12:30–14:30：予約不可（12:30–13:00が重なる）。何も保存しない", async () => {
    await prepareApproved("firm", "2026-10-20T09:00", "2026-10-20T12:00");
    const before = await scanAll();

    expect(await submit(body("firm", "2026-10-20T12:30", "2026-10-20T14:30"))).toEqual(
      rejected("overlaps-existing"),
    );
    await expectNothingWritten(before);
  });

  it("API で受け付けた本予約申込 10:00–12:00 があるときの、仮予約申込 12:00–14:00：予約不可（承認待ちでも枠を確保する）。何も保存しない", async () => {
    await submitOk(body("firm", "2026-10-20T10:00", "2026-10-20T12:00"));
    const before = await scanAll();

    expect(await submit(body("provisional", "2026-10-20T12:00", "2026-10-20T14:00"))).toEqual(
      rejected("overlaps-existing"),
    );
    await expectNothingWritten(before);
  });

  it("仮予約 P 13:00–15:00（占有区間 13:00–16:00）があるときの第二キープ 18:00–20:00：第二キープとしては不可（どの仮予約とも重ならない）。何も保存しない", async () => {
    await prepareApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    const before = await scanAll();

    expect(await submit(body("second-hold", "2026-10-20T18:00", "2026-10-20T20:00"))).toEqual(
      rejected("no-provisional-to-hold"),
    );
    await expectNothingWritten(before);
  });

  it("仮予約 P に API で第二キープ 14:00–17:00 を申込んだあとの、第二キープ 13:00–15:00：不可（すでにある第二キープと重なる。承認待ちでも同じ）。何も保存しない", async () => {
    await prepareApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    await submitOk(body("second-hold", "2026-10-20T14:00", "2026-10-20T17:00"));
    const before = await scanAll();

    expect(await submit(body("second-hold", "2026-10-20T13:00", "2026-10-20T15:00"))).toEqual(
      rejected("overlaps-existing"),
    );
    await expectNothingWritten(before);
  });

  it("第二キープ 12:00–16:00。ただし重なる仮予約 P2 15:00–17:00 が承認待ち（仮）（P1 10:00–12:00 は承認済み）：不可（承認待ちの仮予約とは重なれない）。何も保存しない", async () => {
    await prepareApproved("provisional", "2026-10-20T10:00", "2026-10-20T12:00");
    await prepare("provisional", "2026-10-20T15:00", "2026-10-20T17:00");
    const before = await scanAll();

    const result = await submit(body("second-hold", "2026-10-20T12:00", "2026-10-20T16:00"));

    expect(result.ok).toBe(false);
    await expectNothingWritten(before);
  });

  it("第二キープ K 14:00–17:00（占有区間 14:00–18:00）が入っているときの本予約申込 16:00–18:00：不可（Pとは重ならないが、Kと重なる）。本予約申込 18:00–20:00 は受付（18:00で接するだけ）", async () => {
    await prepareApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    await submitOk(body("second-hold", "2026-10-20T14:00", "2026-10-20T17:00"));
    const before = await scanAll();

    expect(await submit(body("firm", "2026-10-20T16:00", "2026-10-20T18:00"))).toEqual(
      rejected("overlaps-existing"),
    );
    await expectNothingWritten(before);
    expect((await submit(body("firm", "2026-10-20T18:00", "2026-10-20T20:00"))).ok).toBe(true);
  });
});

describe("申込の API：受け付けたとき", () => {
  it("返事は ApplicationAccepted の形（受付番号と見積額だけ）。予約の id や状態は返事に出さない（INV-3）", async () => {
    const result = await submit(body("firm", "2026-10-20T10:00", "2026-10-20T12:00"));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const accepted = expectAcceptedShape(result.accepted);
    const ids = await reservationIds();
    expect(ids).toHaveLength(1);
    expect(accepted.receiptNumber).not.toBe(ids[0]);
    expectNothingPrivateIn(JSON.stringify(result.accepted), ids);
  });

  it("本予約申込 10/20 10:00–12:00（人数4・養生なし・機材保険・グリッター）を受け付ける：承認待ち（本）で保存され、申込の内容・プラン・見積（税抜・税込）・経路（フォーム）・作成日時（現在時刻）を持つ", async () => {
    const accepted = await submitOk(
      body("firm", "2026-10-20T10:00", "2026-10-20T12:00", {
        equipmentInsurance: true,
        optionIds: ["glitter"],
      }),
    );

    // 10,000 + 1,000 + 2,000 = 13,000 → 税込 14,300
    expect(accepted.estimateIncludingTax).toBe(14_300);
    const [id] = await reservationIds();
    const detail = await getReservation(store, id ?? "");
    expect(detail).not.toBeNull();
    if (detail === null) return;
    expect(detail.status).toBe("pending-firm");
    expect(detail.start.toMillis()).toBe(jst("2026-10-20T10:00").toMillis());
    expect(detail.end.toMillis()).toBe(jst("2026-10-20T12:00").toMillis());
    expect(detail.bufferMinutes).toBe(60);
    expect(detail.route).toBe("form");
    expect(detail.partySize).toBe(4);
    expect(detail.cycloramaFloorProtection).toBe(false);
    expect(detail.planId).toBe("A");
    expect(detail.equipmentInsurance).toBe(true);
    expect(detail.optionIds).toEqual(["glitter"]);
    expect(detail.estimate).toEqual({
      subtotalExcludingTax: Yen.parse(13_000),
      estimateIncludingTax: Yen.parse(14_300),
    });
    expect(detail.confirmedPrice).toBeUndefined();
    expect(detail.provisionalIds).toBeUndefined();
    expect(detail.createdAt.toMillis()).toBe(appliedAt.toMillis());
    expect(detail.customer).toEqual(customer);
    expect(detail.shooting).toEqual(shooting);
  });

  it("仮予約申込 10/20 10:00–12:00 を受け付ける：承認待ち（仮）で保存される", async () => {
    await submitOk(body("provisional", "2026-10-20T10:00", "2026-10-20T12:00"));

    const [id] = await reservationIds();
    expect((await getReservation(store, id ?? ""))?.status).toBe("pending-provisional");
  });

  it("受け付けると、受付番号のアイテム RCPT#<受付番号> / META ができ、予約の id を指す。予約の META にも受付番号がある", async () => {
    const accepted = await submitOk(body("firm", "2026-10-20T10:00", "2026-10-20T12:00"));

    const [id] = await reservationIds();
    const receipt = await getItem(`RCPT#${accepted.receiptNumber}`, "META");
    expect(receipt).toBeDefined();
    expect(stringsIn(receipt)).toContain(id);
    expect(await receiptItems()).toHaveLength(1);
    const meta = await getItem(`RES#${id ?? ""}`, "META");
    expect(stringsIn(meta)).toContain(accepted.receiptNumber);
  });

  // booking.md「料金」の例の行を、申込の API で。人数と養生からプランが決まる（申込フォームではプランを選ばない）
  const estimateRows: [string, Body, string, string, string, number, number][] = [
    [
      "A（4人）、10:00–12:00：見積額 11,000円（税抜 10,000）",
      { partySize: 4 },
      "2026-10-20T10:00",
      "2026-10-20T12:00",
      "A",
      10_000,
      11_000,
    ],
    [
      "A（4人）、21:00–翌1:00：見積額 27,500円（税抜 25,000）",
      { partySize: 4 },
      "2026-10-20T21:00",
      "2026-10-21T01:00",
      "A",
      25_000,
      27_500,
    ],
    [
      "B（11人・養生なし）、20:30–翌0:30：見積額 28,737円（28,737.5 を切り捨て。税抜 26,125）",
      { partySize: 11 },
      "2026-10-20T20:30",
      "2026-10-21T00:30",
      "B",
      26_125,
      28_737,
    ],
    [
      "B（11人・養生なし）、00:00–04:00：見積額 36,300円（税抜 33,000）",
      { partySize: 11 },
      "2026-10-20T00:00",
      "2026-10-20T04:00",
      "B",
      33_000,
      36_300,
    ],
    [
      "A（4人）、10:00–12:00、機材保険、オプション2つ：見積額 16,500円（税抜 15,000）",
      { partySize: 4, equipmentInsurance: true, optionIds: ["workshop", "glitter"] },
      "2026-10-20T10:00",
      "2026-10-20T12:00",
      "A",
      15_000,
      16_500,
    ],
    [
      "A（4人）、22:00–翌6:00、ワークショップ：見積額 65,450円（オプションは1回。税抜 59,500）",
      { partySize: 4, optionIds: ["workshop"] },
      "2026-10-20T22:00",
      "2026-10-21T06:00",
      "A",
      59_500,
      65_450,
    ],
    [
      "A（11人・養生あり。床面を全面養生）、10:00–12:00：見積額 11,000円（税抜 10,000）",
      { partySize: 11, cycloramaFloorProtection: true },
      "2026-10-20T10:00",
      "2026-10-20T12:00",
      "A",
      10_000,
      11_000,
    ],
  ];

  async function expectEstimate(
    make: typeof body,
    overrides: Body,
    start: string,
    end: string,
    planId: string,
    subtotal: number,
    including: number,
  ): Promise<void> {
    const accepted = await submitOk(make("firm", start, end, overrides));

    expect(accepted.estimateIncludingTax).toBe(including);
    expect(Number.isInteger(accepted.estimateIncludingTax)).toBe(true);
    const [id] = await reservationIds();
    const detail = await getReservation(store, id ?? "");
    expect(detail?.planId).toBe(planId);
    expect(detail?.estimate).toEqual({
      subtotalExcludingTax: Yen.parse(subtotal),
      estimateIncludingTax: Yen.parse(including),
    });
  }

  it.each(estimateRows)(
    "%s（INV-9。返事の見積額と、保存された見積）",
    async (_, overrides, start, end, planId, subtotal, including) => {
      await expectEstimate(body, overrides, start, end, planId, subtotal, including);
    },
  );

  describe("UTC で渡しても同じ見積額（INV-7）", () => {
    it.each(estimateRows)("%s", async (_, overrides, start, end, planId, subtotal, including) => {
      await expectEstimate(utcBody, overrides, start, end, planId, subtotal, including);
    });
  });

  it("渡した料金表で計算する：単価を2倍にした料金表（A 通常 5,000円/30分）なら、A（4人）10:00–12:00 の見積額は 22,000円", async () => {
    const doubled = PriceTable.parse({
      ...specPriceTable,
      plans: [
        { id: "A", name: "プランA", halfHourRates: { normal: 5_000, lateNight: 7_500 } },
        { id: "B", name: "プランB", halfHourRates: { normal: 5_500, lateNight: 8_250 } },
      ],
    });

    const accepted = await submitOk(body("firm", "2026-10-20T10:00", "2026-10-20T12:00"), {
      priceTable: doubled,
    });

    expect(accepted.estimateIncludingTax).toBe(22_000);
  });
});

describe("申込の API：受付番号", () => {
  it("日を変えて続けて30件申込む：受付番号はすべて ReceiptNumber の形（紛らわしい文字を除いた英大文字と数字の8文字）で、互いに重ならず、それぞれの RCPT# が自分の予約を指す", async () => {
    const numbers: string[] = [];
    for (let i = 0; i < 30; i++) {
      const day = jst("2026-11-01T10:00").plus({ days: i });
      const start = day.toISO({ suppressMilliseconds: true }) ?? "";
      const end = day.plus({ hours: 2 }).toISO({ suppressMilliseconds: true }) ?? "";
      numbers.push((await submitOk({ ...valid, start, end })).receiptNumber);
    }

    for (const n of numbers) {
      expect(ReceiptNumber.safeParse(n).success).toBe(true);
    }
    expect(new Set(numbers).size).toBe(30);
    await expectReceiptsPointToOwnReservations(numbers);
  });

  it("日を変えて10件を同時に申込む：受付番号は互いに重ならず、それぞれの RCPT# が自分の予約を指す", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => {
        const day = jst("2026-11-01T10:00").plus({ days: i });
        return submit({
          ...valid,
          start: day.toISO({ suppressMilliseconds: true }) ?? "",
          end: day.plus({ hours: 2 }).toISO({ suppressMilliseconds: true }) ?? "",
        });
      }),
    );

    const numbers = results.flatMap((r) => (r.ok ? [r.accepted.receiptNumber] : []));
    expect(numbers).toHaveLength(10);
    expect(new Set(numbers).size).toBe(10);
    await expectReceiptsPointToOwnReservations(numbers);
  });

  it("作った受付番号がすでに使われていた（generateReceiptNumber が先の申込と同じ番号を返す）：先の申込の RCPT# は書き換わらない。後の申込は、別の受付番号で受け付けるか、受け付けずに何も残さない", async () => {
    const duplicated = "ZB7K2M9Q";
    const queue = [duplicated, duplicated, "ZB7K2M9R", "ZB7K2M9S", "ZB7K2M9T", "ZB7K2M9U"];
    const generateReceiptNumber = () => queue.shift() ?? "ZB7K2M9V";

    const first = await submitOk(body("firm", "2026-10-20T10:00", "2026-10-20T12:00"), {
      generateReceiptNumber,
    });
    expect(first.receiptNumber).toBe(duplicated);
    const [firstId] = await reservationIds();
    const before = await scanAll();

    const second = await submit(body("firm", "2026-10-21T10:00", "2026-10-21T12:00"), {
      generateReceiptNumber,
    });

    // 先の申込の受付番号のアイテムは、先の予約を指したまま
    const firstReceipt = await getItem(`RCPT#${duplicated}`, "META");
    expect(stringsIn(firstReceipt)).toContain(firstId);
    if (second.ok) {
      expect(second.accepted.receiptNumber).not.toBe(duplicated);
      expect(ReceiptNumber.safeParse(second.accepted.receiptNumber).success).toBe(true);
      await expectReceiptsPointToOwnReservations([duplicated, second.accepted.receiptNumber]);
    } else {
      await expectNothingWritten(before);
    }
  });

  /** 受付番号ごとに RCPT# のアイテムがあり、それぞれ別の予約を指し、その予約の META が同じ受付番号を持つ */
  async function expectReceiptsPointToOwnReservations(numbers: readonly string[]): Promise<void> {
    const ids = await reservationIds();
    expect(ids).toHaveLength(numbers.length);
    expect(await receiptItems()).toHaveLength(numbers.length);
    const pointed: string[] = [];
    for (const n of numbers) {
      const item = await getItem(`RCPT#${n}`, "META");
      expect(item, `RCPT#${n}`).toBeDefined();
      const target = ids.filter((id) => stringsIn(item).includes(id));
      expect(target, `RCPT#${n} が指す予約`).toHaveLength(1);
      const id = target[0] ?? "";
      pointed.push(id);
      expect(stringsIn(await getItem(`RES#${id}`, "META"))).toContain(n);
    }
    expect(new Set(pointed).size).toBe(numbers.length);
  }
});

describe("同時の申込（INV-1）", () => {
  it("同じ時間 10/20 10:00–12:00 への本予約申込2件を POST /applications に同時に送る：片方だけ 201、もう片方は 422 と overlaps-existing。予約と受付番号のアイテムは1件ずつ", async () => {
    const save = { maxAttempts: 3 };
    const responses = await Promise.all([
      post(body("firm", "2026-10-20T10:00", "2026-10-20T12:00"), { save }),
      post(body("firm", "2026-10-20T10:00", "2026-10-20T12:00"), { save }),
    ]);

    expect(responses.map((r) => r.status).sort()).toEqual([201, 422]);
    const loser = responses.find((r) => r.status === 422);
    expect(await loser?.json()).toEqual({ error: "overlaps-existing" });
    expect(await reservationIds()).toHaveLength(1);
    expect(await receiptItems()).toHaveLength(1);
  });

  it("同じ時間への仮予約申込 10:00–12:00 と本予約申込 11:00–13:00 を、どちらも読んで判定してから書くように同時に送る：片方だけ受付、もう片方は読み直して不可（overlaps-existing）", async () => {
    const meet = meetBeforeFirstWrite(2);
    const save = { maxAttempts: 3, beforeWrite: meet };
    const results = await Promise.all([
      submit(body("provisional", "2026-10-20T10:00", "2026-10-20T12:00"), { save }),
      submit(body("firm", "2026-10-20T11:00", "2026-10-20T13:00"), { save }),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([rejected("overlaps-existing")]);
    expect(await reservationIds()).toHaveLength(1);
    expect(await receiptItems()).toHaveLength(1);
  });

  it("どの順に申込が来ても、受付になった予約の占有区間は互いに重ならず、不可の申込は受付の予約と重なっていて、予約・受付番号のアイテムの数が受付の数と合い、受付番号は重ならない（ランダムな申込を同時に送る）", async () => {
    // 申込の候補：10/20 08:00（JST）からの30分単位の開始（〜15:00）、長さ2〜8時間（通常帯に収まる）
    const base = jst("2026-10-20T08:00");
    const applicationShape = fc.record({
      kind: fc.constantFrom<"firm" | "provisional">("firm", "provisional"),
      startSlot: fc.integer({ min: 0, max: 14 }),
      lengthSlots: fc.integer({ min: 4, max: 16 }),
    });

    await fc.assert(
      fc.asyncProperty(
        fc.array(applicationShape, { minLength: 2, maxLength: 6 }),
        async (shapes) => {
          const own = await createTable();
          try {
            const intervals = shapes.map((shape) => {
              const start = base.plus({ minutes: shape.startSlot * 30 });
              return {
                kind: shape.kind,
                start,
                end: start.plus({ minutes: shape.lengthSlots * 30 }),
              };
            });
            const results = await Promise.all(
              intervals.map((interval) =>
                submitApplication(
                  {
                    store: own,
                    now: () => appliedAt,
                    priceTable: specPriceTable,
                    save: { maxAttempts: intervals.length + 1 },
                  },
                  {
                    ...valid,
                    kind: interval.kind,
                    start: interval.start.toISO({ suppressMilliseconds: true }),
                    end: interval.end.toISO({ suppressMilliseconds: true }),
                  },
                ),
              ),
            );

            // 占有区間はバッファ1時間込み
            const occupied = (i: (typeof intervals)[number]) => ({
              start: i.start.toMillis(),
              end: i.end.plus({ minutes: 60 }).toMillis(),
            });
            const overlaps = (
              a: { start: number; end: number },
              b: { start: number; end: number },
            ) => a.start < b.end && b.start < a.end;

            const accepted = intervals.filter((_, i) => results[i]?.ok === true);
            for (let i = 0; i < accepted.length; i++) {
              for (let j = i + 1; j < accepted.length; j++) {
                const a = accepted[i];
                const b = accepted[j];
                if (a !== undefined && b !== undefined) {
                  expect(overlaps(occupied(a), occupied(b))).toBe(false);
                }
              }
            }
            results.forEach((result, i) => {
              const interval = intervals[i];
              if (interval === undefined || result.ok) return;
              // 混み合っている（busy）ときは、何も残さないことだけを求める（下の数の確認）
              if (result.reason === "overlaps-existing") {
                expect(
                  accepted.some((other) => overlaps(occupied(interval), occupied(other))),
                ).toBe(true);
              } else {
                expect(result.reason).toBe("busy");
              }
            });

            const numbers = results.flatMap((r) => (r.ok ? [r.accepted.receiptNumber] : []));
            expect(new Set(numbers).size).toBe(numbers.length);
            expect(await reservationIds(own)).toHaveLength(accepted.length);
            const receipts = await receiptItems(own);
            expect(receipts.map((item) => String(item["pk"])).sort()).toEqual(
              numbers.map((n) => `RCPT#${n}`).sort(),
            );
          } finally {
            await deleteTable(own);
          }
        },
      ),
      { numRuns: 10 },
    );
  }, 120_000);
});

describe("申込の API：混み合っているとき（INV-2）", () => {
  it("書く直前に毎回ほかの書き込みで 10/20 の版番号が進み、やり直しの上限（2回）を超える：busy。予約・個人情報・履歴・受付番号のアイテムは残らない", async () => {
    const result = await submit(body("firm", "2026-10-20T10:00", "2026-10-20T12:00"), {
      save: { maxAttempts: 2, beforeWrite: () => bumpDay("2026-10-20") },
    });

    expect(result).toEqual(rejected("busy"));
    const items = await scanAll();
    expect(items.filter((item) => String(item["pk"]).startsWith("RES#"))).toEqual([]);
    expect(items.filter((item) => String(item["pk"]).startsWith("RCPT#"))).toEqual([]);
  });
});

describe("申込の API：HTTP（POST /applications）", () => {
  it("受付：201 と JSON（ApplicationAccepted。受付番号と見積額だけ）", async () => {
    const res = await post(body("firm", "2026-10-20T10:00", "2026-10-20T12:00"));

    expect(res.status).toBe(201);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    const text = await res.text();
    const accepted = expectAcceptedShape(JSON.parse(text));
    expect(accepted.estimateIncludingTax).toBe(11_000);
    expect(await getItem(`RCPT#${accepted.receiptNumber}`, "META")).toBeDefined();
    expectNothingPrivateIn(text, await reservationIds());
  });

  it("入力の誤り（人数 15）：400 と JSON { error: invalid-input }", async () => {
    const res = await post({ ...valid, partySize: 15 });

    expect(res.status).toBe(400);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    const json: unknown = await res.json();
    expect(ApplicationRejected.safeParse(json).success).toBe(true);
    expect(json).toEqual({ error: "invalid-input" });
  });

  it.each([
    [
      "30分単位でない（10:15–12:15）",
      body("firm", "2026-10-20T10:15", "2026-10-20T12:15"),
      "not-on-30-minute-boundary",
    ],
    [
      "2時間未満（10:00–11:30）",
      body("firm", "2026-10-20T10:00", "2026-10-20T11:30"),
      "shorter-than-2-hours",
    ],
    [
      "深夜帯にかかり4時間未満（03:00–05:00）",
      body("firm", "2026-10-20T03:00", "2026-10-20T05:00"),
      "late-night-shorter-than-4-hours",
    ],
    [
      "24時間を超える（10/20 10:00–10/21 10:30）",
      body("firm", "2026-10-20T10:00", "2026-10-21T10:30"),
      "longer-than-24-hours",
    ],
    [
      "開始の24時間前を過ぎた本予約申込（申込 10/01 12:00、開始 10/02 11:00）",
      body("firm", "2026-10-02T11:00", "2026-10-02T13:00"),
      "past-24-hours-before-start",
    ],
    [
      "仮予約の期限を過ぎた仮予約申込（申込 10/01 12:00、開始 10/05 10:00。期限は 9/28 18:00）",
      body("provisional", "2026-10-05T10:00", "2026-10-05T12:00"),
      "past-provisional-deadline",
    ],
  ] as [string, Body, ApplicationRejection][])(
    "ルールで不可（%s）：422 と JSON { error: <理由> }。何も保存しない",
    async (_, value, reason) => {
      const before = await scanAll();

      const res = await post(value);

      expect(res.status).toBe(422);
      expect(res.headers.get("content-type") ?? "").toContain("application/json");
      expect(await res.json()).toEqual({ error: reason });
      await expectNothingWritten(before);
    },
  );

  it("ルールで不可（空き判定。本予約 10:00–12:00 と重なる 11:00–13:00）：422 と JSON { error: overlaps-existing }", async () => {
    await prepareApproved("firm", "2026-10-20T10:00", "2026-10-20T12:00");

    const res = await post(body("firm", "2026-10-20T11:00", "2026-10-20T13:00"));

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "overlaps-existing" });
  });

  it("ルールで不可（第二キープがどの仮予約とも重ならない）：422 と JSON { error: no-provisional-to-hold }", async () => {
    const res = await post(body("second-hold", "2026-10-20T18:00", "2026-10-20T20:00"));

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "no-provisional-to-hold" });
  });

  it("混み合っている：503 と JSON { error: busy }。何も保存しない", async () => {
    const res = await post(body("firm", "2026-10-20T10:00", "2026-10-20T12:00"), {
      save: { maxAttempts: 2, beforeWrite: () => bumpDay("2026-10-20") },
    });

    expect(res.status).toBe(503);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    expect(await res.json()).toEqual({ error: "busy" });
    expect(await reservationIds()).toEqual([]);
    expect(await receiptItems()).toEqual([]);
  });
});

describe("申込の API：個人情報（INV-10）", () => {
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
    // 文字列以外（オブジェクト、Error、バイト列）も、中の値が見える文字列に直す
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

  it("受け付けたとき・ルールで不可のとき・入力の誤りのとき：返事（関数の戻り値と HTTP の本文）に、お客様の情報と自由記述の値が入らない", async () => {
    await prepareApproved("firm", "2026-10-21T10:00", "2026-10-21T12:00");
    const values: unknown[] = [
      body("firm", "2026-10-20T10:00", "2026-10-20T12:00"),
      body("firm", "2026-10-21T11:00", "2026-10-21T13:00"),
      { ...valid, partySize: 15 },
    ];

    for (const value of values) {
      expectNothingPrivateIn(JSON.stringify(await submit(value)), []);
    }
    for (const value of values) {
      expectNothingPrivateIn(await (await post(value)).text(), []);
    }
  });

  it("申込の処理中のログ（console、標準出力、標準エラー）に、お客様の情報と自由記述の値が出ない（受付・ルールで不可・入力の誤り・混み合っている）", async () => {
    await prepareApproved("firm", "2026-10-21T10:00", "2026-10-21T12:00");
    const output = captureOutput();

    await submit(body("firm", "2026-10-20T10:00", "2026-10-20T12:00"));
    await submit(body("firm", "2026-10-21T11:00", "2026-10-21T13:00"));
    await submit({ ...valid, partySize: 15, customer: { ...customer, email: "shiro@example" } });
    await submit(body("firm", "2026-10-22T10:00", "2026-10-22T12:00"), {
      save: { maxAttempts: 1, beforeWrite: () => bumpDay("2026-10-22") },
    });
    await post(body("firm", "2026-10-23T10:00", "2026-10-23T12:00"));

    const text = output();
    for (const personal of personalValues) {
      expect(text).not.toContain(personal);
    }
  });

  it("受付番号のアイテムに、お客様の情報と自由記述の値が入らない", async () => {
    const accepted = await submitOk(body("firm", "2026-10-20T10:00", "2026-10-20T12:00"));

    const strings = stringsIn(await getItem(`RCPT#${accepted.receiptNumber}`, "META"));
    for (const personal of personalValues) {
      for (const s of strings) {
        expect(s).not.toContain(personal);
      }
    }
  });
});
