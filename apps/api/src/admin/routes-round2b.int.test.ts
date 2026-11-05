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
  AdminCustomerField,
  AdminOperationAccepted,
  AdminRejected,
  AdminReservationDetail,
  AdminReservationList,
  PriceTable,
  Yen,
} from "@zebra/contracts";
import { DateTime } from "luxon";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveBufferChange } from "../db/buffer-change.ts";
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

// 管理 API の2回目b（バッファの切り替え・お客様の情報と撮影の内容の変更）のルートの統合テスト（DynamoDB Local）。
// 根拠：docs/design-docs/admin-api.md「バッファの切り替え・お客様の情報の変更（2回目b）」「返すときの決まり」「認証」、
// docs/product-specs/booking.md「お客様の情報・撮影の内容を直す」（例の表のすべての行）、「バッファを30分に縮める」、
// reservation-model.md（状態と操作、第二キープと仮予約、履歴）、core-beliefs.md（INV-1、INV-2、INV-4、INV-7、INV-10）、
// packages/contracts の admin.ts（AdminBufferRequest、AdminCustomerInfoRequest、AdminCustomerField、AdminOperationAccepted、
// AdminRejected、AdminReservationDetail。返す本文は契約でパースできること）。
// 判定の細かい決まりは booking-core（applyBufferChange）と保存の層（saveBufferChange・saveCustomerInfo）のテストで
// 確かめているので、ここでは例の行と代表的な場合が、API の返事（ステータス・本文）と DB に正しく現れることを確かめる。
// - バッファの切り替えの成功は 200 と AdminOperationAccepted（作った下書きの一覧。なければ空）。今と同じバッファなら、
//   何も書かずに 200 と空の一覧
// - お客様の情報の変更の成功は 200 で本文なし（admin-api.md「成功したら 200（本文なし。ブロック枠を直すのと同じ）」）。
//   本文が空であることを確かめる
// - 「空にする」は、その欄を送らないこと（全部を送って置き換え、送らなかった欄は消える。契約では、入れた欄は1文字以上）
// - 「不可（連絡先が1つもない）」「不可（氏名は必須）」は、本文が契約（AdminCustomerInfoRequest）を通らないので
//   400 invalid-input（admin-api.md「返すときの決まり」の「入力の形が正しくない」）
// - 例の表には日付がないので 2026/10/20 とする。API の現在時刻は 2026/10/05 09:00 とする
// - 下書きの並び順は決めていないので、件数と中身で比べる

const client = createLocalDynamoClient();
let store: ReservationStore;

// テーブルはキー設計どおり（pk・sk、GSI の gsi1pk・gsi1sk）にテストごとに作り、終わったら消す
async function createTable(): Promise<ReservationStore> {
  const tableName = `int-test-admin-2b-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
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
/** テストの準備でする承認・取消・昇格・切り替えの時刻（固定） */
const preparedAt = jst("2026-10-02T12:00");
/** API の現在時刻（固定） */
const now = jst("2026-10-05T09:00");

/** API を呼ぶ管理者（架空のユーザー id） */
const adminUserId = "admin-user-kaku-2b";
/** 準備の操作をした管理者（架空のユーザー id。API を呼ぶ管理者と見分けるため別にする） */
const preparingAdminUserId = "admin-user-kaku-2b-prep";

/** 保存された日時（UTC）を、比べやすい JST の "yyyy-MM-ddTHH:mm" にする */
function storedLocal(value: unknown): string {
  const parsed = DateTime.fromISO(String(value), { setZone: true });
  expect(parsed.isValid, String(value)).toBe(true);
  return parsed.setZone("Asia/Tokyo").toFormat("yyyy-MM-dd'T'HH:mm");
}

/** 返した日時の文字列が ISO 8601 で JST のオフセット（+09:00）付きであること（admin-api.md「返すときの決まり」） */
function expectJstOffset(value: string): void {
  expect(value, value).toMatch(/\+09:00$/);
  expect(DateTime.fromISO(value, { setZone: true }).isValid, value).toBe(true);
}

// ---- 料金表（booking.md「料金」から作る。ウィジェットの申込に使う） ----

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

/** フォームから申込んだお客様（氏名・メールアドレス・電話番号・住所あり。フォームではカメラマン氏名も必須なので入れる。会社名なし） */
const formCustomer = {
  name: "架空 二回目花子",
  email: "nikaime.hanako.kaku@example.com",
  phone: "090-0000-8024",
  address: "架空県架空市二回目町8-0-2",
  photographerName: "仮名 二回目写真",
} as const;

const formShooting = {
  types: ["still"],
  details: "架空の撮影詳細：2回目bの確認用（直す前）",
  notes: "架空の補足事項：2回目bの確認用（直す前）",
} as const;

/** 直したあとの値（架空） */
const newPhone = "080-0000-4680";
const newEmail = "nikaime.new.kaku@example.com";
const newName = "架空 二回目花江";
const newCompanyName = "架空二回目合同会社";
const newPhotographerName = "仮名 二回目撮影";
const newDetails = "架空の撮影詳細：2回目bの確認用（直したあと）";
const newNotes = "架空の補足事項：2回目bの確認用（直したあと）";

const personalValues: readonly string[] = [
  ...Object.values(formCustomer),
  formShooting.details,
  formShooting.notes,
  newPhone,
  newEmail,
  newName,
  newCompanyName,
  newPhotographerName,
  newDetails,
  newNotes,
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
    customer: formCustomer,
    shooting: formShooting,
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

/** 申込して承認する（準備）。確定金額は 22,000円 */
async function applyApproved(kind: ApplicationKind, start: string, end: string): Promise<string> {
  const id = await apply(kind, start, end);
  await prepareOperation({ kind: "approve", reservationId: id, confirmedPrice: Yen.parse(22_000) });
  return id;
}

/** 準備として、バッファを切り替えておく（保存の層の関数で） */
async function prepareBuffer(reservationId: string, bufferMinutes: 30 | 60): Promise<void> {
  const result = await saveBufferChange(
    store,
    { reservationId, bufferMinutes },
    { now: preparedAt, adminUserId: preparingAdminUserId },
  );
  if (!result.ok) {
    throw new Error(`準備の切り替えが不可になった（${reservationId}、${result.reason}）`);
  }
}

/** フォームから申込んだ本予約 A 10/20 09:00–12:00（承認済み、バッファ1時間） */
async function prepareA(): Promise<string> {
  return applyApproved("firm", "2026-10-20T09:00", "2026-10-20T12:00");
}

/** お客様がウィジェット（公開API の申込）から本予約を申込む。受け付けられたかを返す */
async function applyViaWidget(start: string, end: string): Promise<boolean> {
  const iso = (local: string) => jst(local).toISO({ suppressMilliseconds: true }) ?? "";
  const result = await submitApplication(
    { store, now: () => appliedAt, priceTable: specPriceTable },
    {
      kind: "firm",
      start: iso(start),
      end: iso(end),
      partySize: 4,
      cycloramaFloorProtection: false,
      equipmentInsurance: false,
      optionIds: [],
      customer: { ...formCustomer },
      shooting: { ...formShooting, types: [...formShooting.types] },
      agreedToCycloramaRules: true,
      agreedToTerms: true,
    },
  );
  return result.ok;
}

// ---- API を呼ぶ道具 ----

function deps(at: DateTime, overrides: Partial<AdminDeps> = {}): AdminDeps {
  return {
    store,
    now: () => at,
    priceTable: specPriceTable,
    adminUserId: () => adminUserId,
    ...overrides,
  };
}

/** 本文を付けて呼ぶ。body が文字列ならそのまま本文にし、undefined なら本文を付けず、それ以外は JSON にする */
async function send(
  method: "GET" | "POST" | "PUT",
  path: string,
  body: unknown,
  at: DateTime = now,
  overrides: Partial<AdminDeps> = {},
): Promise<Response> {
  const route = createAdminRoute(deps(at, overrides));
  if (body === undefined) {
    return route.request(path, { method });
  }
  return route.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** バッファの切り替え（POST /admin/reservations/{id}/buffer） */
async function buffer(
  id: string,
  body: unknown,
  overrides: Partial<AdminDeps> = {},
  at: DateTime = now,
): Promise<Response> {
  return send("POST", `/admin/reservations/${id}/buffer`, body, at, overrides);
}

/** お客様の情報・撮影の内容の変更（PUT /admin/reservations/{id}/customer） */
async function putCustomer(
  id: string,
  body: unknown,
  overrides: Partial<AdminDeps> = {},
  at: DateTime = now,
): Promise<Response> {
  return send("PUT", `/admin/reservations/${id}/customer`, body, at, overrides);
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

/** バッファの切り替えの成功が 200 と AdminOperationAccepted であることを確かめ、下書きを返す */
async function acceptedDrafts(res: Response): Promise<AdminOperationAccepted["drafts"]> {
  const json = await okJson(res, 200);
  const parsed = AdminOperationAccepted.safeParse(json);
  expect(parsed.success, JSON.stringify(json)).toBe(true);
  return parsed.success ? parsed.data.drafts : [];
}

/** お客様の情報の変更の成功：200 で本文なし */
async function expectSavedWithoutBody(res: Response): Promise<void> {
  const text = await res.text();
  expect(res.status, text).toBe(200);
  expect(text).toBe("");
}

/** 下書きの並び順は決めていないので、件数と中身で比べる */
function expectDrafts(actual: readonly unknown[], expected: readonly unknown[]): void {
  expect(actual).toHaveLength(expected.length);
  expect(actual).toEqual(expect.arrayContaining([...expected]));
}

async function detailJson(id: string): Promise<AdminReservationDetail> {
  const json = await okJson(await send("GET", `/admin/reservations/${id}`, undefined), 200);
  const parsed = AdminReservationDetail.safeParse(json);
  expect(parsed.success, JSON.stringify(json)).toBe(true);
  if (!parsed.success) throw new Error("AdminReservationDetail を通らない");
  return parsed.data;
}

async function listJson(query: string): Promise<AdminReservationList> {
  const json = await okJson(await send("GET", `/admin/reservations?${query}`, undefined), 200);
  const parsed = AdminReservationList.safeParse(json);
  expect(parsed.success, JSON.stringify(json)).toBe(true);
  if (!parsed.success) throw new Error("AdminReservationList を通らない");
  return parsed.data;
}

/** 履歴の最後の1件 */
function lastHistory(detail: AdminReservationDetail): AdminReservationDetail["history"][number] {
  const entry = detail.history.at(-1);
  if (entry === undefined) throw new Error("履歴がない");
  return entry;
}

// ---- 本文を作る道具 ----

/** お客様の情報の変更の本文。指定がなければ、今と同じ内容 */
function customerBody(
  overrides: { customer?: Record<string, unknown>; shooting?: Record<string, unknown> } = {},
): Record<string, unknown> {
  return {
    customer: overrides.customer ?? { ...formCustomer },
    shooting: overrides.shooting ?? { ...formShooting, types: [...formShooting.types] },
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

/** できない操作・何もしない操作で、テーブルの中身が何も変わっていないことを確かめる */
async function expectNothingWritten(before: readonly PlainItem[]): Promise<void> {
  expect(sortedItems(await scanAll())).toEqual(sortedItems(before));
}

/**
 * お客様の情報の変更のあと、変わったのがその予約の PII と、増えた履歴1件だけであることを確かめる
 * （日ごとのアイテム・META・下書きは書かない。admin-api.md「お客様の情報・撮影の内容の変更」）
 */
async function expectOnlyPiiAndOneHistoryWritten(
  before: readonly PlainItem[],
  id: string,
): Promise<void> {
  const after = await scanAll();
  const beforeKeys = new Set(before.map(itemKey));
  const added = after.filter((item) => !beforeKeys.has(itemKey(item)));
  expect(added.map(itemKey)).toHaveLength(1);
  expect(added[0]?.["pk"]).toBe(`RES#${id}`);
  expect(String(added[0]?.["sk"])).toMatch(/^HIST#/);
  const untouched = (items: readonly PlainItem[]) =>
    sortedItems(
      items.filter(
        (item) =>
          !(item["pk"] === `RES#${id}` && item["sk"] === "PII") &&
          !added.some((a) => itemKey(a) === itemKey(item)),
      ),
    );
  expect(untouched(after)).toEqual(untouched(before));
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

/** その日のアイテムにある、その id の占有区間（バッファ込み）を JST の [開始, 終わり] で返す。なければ undefined */
async function occupancy(day: string, id: string): Promise<[string, string] | undefined> {
  const found = (await dayIntervals(day)).filter((i) => i["id"] === id);
  if (found.length === 0) return undefined;
  expect(found).toHaveLength(1);
  return [storedLocal(found[0]?.["start"]), storedLocal(found[0]?.["end"])];
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

/** 返した履歴の1件に、お客様の情報と撮影の内容の値（前も後も）が入っていないこと（INV-10 の考え方。reservation-model.md「履歴」） */
function expectNoPersonalValuesIn(value: unknown): void {
  const text = JSON.stringify(value);
  for (const personal of personalValues) {
    expect(text).not.toContain(personal);
  }
}

// ---- テスト ----

describe("お客様の情報・撮影の内容を直す", () => {
  it("フォームから申込んだ本予約（氏名・メールアドレス・電話番号・住所あり）、管理者が電話番号を直す：直る。履歴には「電話番号」とだけ残る", async () => {
    const a = await prepareA();
    const before = await scanAll();
    const historyBefore = (await detailJson(a)).history.length;

    await expectSavedWithoutBody(
      await putCustomer(a, customerBody({ customer: { ...formCustomer, phone: newPhone } })),
    );

    const detail = await detailJson(a);
    expect(detail.customer).toEqual({ ...formCustomer, phone: newPhone });
    expect(detail.shooting).toEqual(formShooting);
    expect(detail.history).toHaveLength(historyBefore + 1);
    const entry = lastHistory(detail);
    expect(entry.operation).toBe("customer-info-change");
    expect(entry.actor).toEqual({ kind: "admin", userId: adminUserId });
    expect(DateTime.fromISO(entry.at, { setZone: true }).toMillis()).toBe(now.toMillis());
    expectJstOffset(entry.at);
    expect(entry.changedFields).toEqual(["phone"]);
    expectNoPersonalValuesIn(entry);
    await expectOnlyPiiAndOneHistoryWritten(before, a);
  });

  // 「空にする」：住所の欄を送らない（全部を送って置き換え、送らなかった欄は空になる）
  it("フォームから申込んだ本予約（氏名・メールアドレス・電話番号・住所あり）、管理者が住所を空にする：直る（住所は任意）", async () => {
    const a = await prepareA();

    await expectSavedWithoutBody(
      await putCustomer(
        a,
        customerBody({
          customer: {
            name: formCustomer.name,
            email: formCustomer.email,
            phone: formCustomer.phone,
            photographerName: formCustomer.photographerName,
          },
        }),
      ),
    );

    const detail = await detailJson(a);
    expect(detail.customer).toEqual({
      name: formCustomer.name,
      email: formCustomer.email,
      phone: formCustomer.phone,
      photographerName: formCustomer.photographerName,
    });
    expect(detail.customer.address).toBeUndefined();
    expect(lastHistory(detail).changedFields).toEqual(["address"]);
  });

  it("フォームから申込んだ本予約（氏名・メールアドレス・電話番号・住所あり）、管理者がメールアドレスと電話番号の両方を空にする：不可（連絡先が1つもない）", async () => {
    const a = await prepareA();
    const before = await scanAll();

    await expectError(
      await putCustomer(
        a,
        customerBody({
          customer: {
            name: formCustomer.name,
            address: formCustomer.address,
            photographerName: formCustomer.photographerName,
          },
        }),
      ),
      400,
      "invalid-input",
    );
    await expectNothingWritten(before);
    expect((await detailJson(a)).customer).toEqual(formCustomer);
  });

  // 「空にする」：氏名の欄を送らない場合と、空の文字列・空白だけを送る場合のどれも不可
  it("フォームから申込んだ本予約（氏名・メールアドレス・電話番号・住所あり）、管理者が氏名を空にする：不可（氏名は必須）", async () => {
    const a = await prepareA();
    const before = await scanAll();
    const { email, phone, address, photographerName } = formCustomer;

    for (const customer of [
      { email, phone, address, photographerName },
      { name: "", email, phone, address, photographerName },
      { name: "  ", email, phone, address, photographerName },
    ]) {
      await expectError(await putCustomer(a, customerBody({ customer })), 400, "invalid-input");
      await expectNothingWritten(before);
    }
  });

  it("取消した本予約、管理者がメールアドレスを直す：直る（どの状態でも直せる）", async () => {
    const a = await prepareA();
    await prepareOperation({ kind: "cancel", reservationId: a });
    const before = await scanAll();

    await expectSavedWithoutBody(
      await putCustomer(a, customerBody({ customer: { ...formCustomer, email: newEmail } })),
    );

    const detail = await detailJson(a);
    expect(detail.status).toBe("cancelled");
    expect(detail.customer.email).toBe(newEmail);
    expect(lastHistory(detail).changedFields).toEqual(["email"]);
    await expectOnlyPiiAndOneHistoryWritten(before, a);
  });

  it("本予約、管理者が撮影詳細を直す：直る。履歴には「撮影詳細」とだけ残る", async () => {
    const a = await prepareA();

    await expectSavedWithoutBody(
      await putCustomer(
        a,
        customerBody({
          shooting: { ...formShooting, types: [...formShooting.types], details: newDetails },
        }),
      ),
    );

    const detail = await detailJson(a);
    expect(detail.shooting).toEqual({ ...formShooting, details: newDetails });
    const entry = lastHistory(detail);
    expect(entry.operation).toBe("customer-info-change");
    expect(entry.changedFields).toEqual(["shootingDetails"]);
    expectNoPersonalValuesIn(entry);
  });

  it("本予約、管理者が今と同じ内容を送る：何もしない（履歴を残さない）", async () => {
    const a = await prepareA();
    const before = await scanAll();

    await expectSavedWithoutBody(await putCustomer(a, customerBody()));
    await expectNothingWritten(before);
  });
});

describe("管理 API：お客様の情報・撮影の内容の変更（PUT /admin/reservations/{id}/customer）", () => {
  // booking.md「どの状態の予約でも直せる（承認待ち・取消・終了も）」
  it("承認待ち（本）・仮予約・第二キープ・承認待ち（第二キープ）・終了の予約の電話番号を直す：どれも 200。状態は変わらず、日ごとのアイテム・META・下書きは書かない", async () => {
    const pendingFirm = await apply("firm", "2026-10-21T09:00", "2026-10-21T12:00");
    const p = await applyApproved("provisional", "2026-10-22T13:00", "2026-10-22T15:00");
    const k = await applyApproved("second-hold", "2026-10-22T14:00", "2026-10-22T17:00");
    const pendingK = await apply("second-hold", "2026-10-22T11:00", "2026-10-22T13:00");
    const q = await applyApproved("provisional", "2026-10-23T13:00", "2026-10-23T15:00");
    const ended = await applyApproved("second-hold", "2026-10-23T14:00", "2026-10-23T17:00");
    await prepareOperation({ kind: "promote", reservationId: q });

    for (const [id, status] of [
      [pendingFirm, "pending-firm"],
      [p, "provisional"],
      [k, "second-hold"],
      [pendingK, "pending-second-hold"],
      [ended, "ended"],
    ] as const) {
      expect((await detailJson(id)).status, status).toBe(status);
      const before = await scanAll();
      const drafts = await unsentDraftCount();

      await expectSavedWithoutBody(
        await putCustomer(id, customerBody({ customer: { ...formCustomer, phone: newPhone } })),
      );

      const detail = await detailJson(id);
      expect(detail.status, status).toBe(status);
      expect(detail.customer.phone, status).toBe(newPhone);
      expect(lastHistory(detail).changedFields, status).toEqual(["phone"]);
      await expectOnlyPiiAndOneHistoryWritten(before, id);
      expect(await unsentDraftCount(), status).toBe(drafts);
    }
  });

  it("全部を送って置き換える：氏名・会社名・メールアドレス・カメラマン氏名を直し、撮影内容と補足事項を送らない：200。詳細は送ったとおりで、送らなかった欄はない。履歴の changedFields は AdminCustomerField の順", async () => {
    const a = await prepareA();
    const customer = {
      name: newName,
      companyName: newCompanyName,
      email: newEmail,
      phone: formCustomer.phone,
      address: formCustomer.address,
      photographerName: newPhotographerName,
    };

    await expectSavedWithoutBody(
      await putCustomer(a, customerBody({ customer, shooting: { details: newDetails } })),
    );

    const detail = await detailJson(a);
    expect(detail.customer).toEqual(customer);
    expect(detail.shooting).toEqual({ details: newDetails });
    const changed = lastHistory(detail).changedFields;
    expect(changed).toEqual([
      "name",
      "companyName",
      "email",
      "photographerName",
      "shootingTypes",
      "shootingDetails",
      "shootingNotes",
    ]);
    // 並びは契約の AdminCustomerField の順
    const order = AdminCustomerField.options;
    expect([...(changed ?? [])].sort((x, y) => order.indexOf(x) - order.indexOf(y))).toEqual(
      changed,
    );
    expectNoPersonalValuesIn(lastHistory(detail));
  });

  it("撮影内容を「スチール」から「スチールと動画」に、補足事項を直す：200。履歴の changedFields は shootingTypes・shootingNotes", async () => {
    const a = await prepareA();

    await expectSavedWithoutBody(
      await putCustomer(
        a,
        customerBody({
          shooting: { types: ["still", "movie"], details: formShooting.details, notes: newNotes },
        }),
      ),
    );

    const detail = await detailJson(a);
    expect(detail.shooting).toEqual({
      types: ["still", "movie"],
      details: formShooting.details,
      notes: newNotes,
    });
    expect(lastHistory(detail).changedFields).toEqual(["shootingTypes", "shootingNotes"]);
  });

  it("ない予約の id：404 と { error: not-found }。何も書かない", async () => {
    await prepareA();
    const before = await scanAll();

    await expectError(await putCustomer("no-such-reservation", customerBody()), 404, "not-found");
    await expectNothingWritten(before);
  });

  it("API の現在時刻を UTC で表して渡す：履歴の日時は同じ時点で、JST のオフセット付きで返る（INV-7）", async () => {
    const a = await prepareA();

    await expectSavedWithoutBody(
      await putCustomer(
        a,
        customerBody({ customer: { ...formCustomer, phone: newPhone } }),
        {},
        now.toUTC(),
      ),
    );

    const entry = lastHistory(await detailJson(a));
    expectJstOffset(entry.at);
    expect(DateTime.fromISO(entry.at, { setZone: true }).toMillis()).toBe(now.toMillis());
  });
});

describe("管理 API：バッファの切り替え（POST /admin/reservations/{id}/buffer）", () => {
  it("本予約 A 09:00–12:00、バッファ1時間（占有区間 09:00–13:00）、管理者が A のバッファを30分にする：200 と空の下書きの一覧。占有区間は 09:00–12:30 になる。詳細・一覧のバッファは30分、履歴は管理者の buffer-change（前後のバッファ 60 → 30）", async () => {
    const a = await prepareA();
    expect(await occupancy("2026-10-20", a)).toEqual(["2026-10-20T09:00", "2026-10-20T13:00"]);
    const drafts = await unsentDraftCount();

    expect(await acceptedDrafts(await buffer(a, { bufferMinutes: 30 }))).toEqual([]);

    expect(await occupancy("2026-10-20", a)).toEqual(["2026-10-20T09:00", "2026-10-20T12:30"]);
    const detail = await detailJson(a);
    expect(detail.bufferMinutes).toBe(30);
    expect(detail.status).toBe("firm");
    const entry = lastHistory(detail);
    expect(entry.operation).toBe("buffer-change");
    expect(entry.actor).toEqual({ kind: "admin", userId: adminUserId });
    expect(DateTime.fromISO(entry.at, { setZone: true }).toMillis()).toBe(now.toMillis());
    expect(entry.before?.bufferMinutes).toBe(60);
    expect(entry.after?.bufferMinutes).toBe(30);
    const list = await listJson("from=2026-10-20&to=2026-10-20");
    expect(list.reservations.find((r) => r.id === a)?.bufferMinutes).toBe(30);
    expect(await unsentDraftCount()).toBe(drafts);
  });

  it("A のバッファ30分（占有区間 09:00–12:30）にしたあと、ウィジェットから 12:30–14:30 を申込む：予約可（12:30で接するだけ）", async () => {
    const a = await prepareA();
    expect(await applyViaWidget("2026-10-20T12:30", "2026-10-20T14:30")).toBe(false);

    await acceptedDrafts(await buffer(a, { bufferMinutes: 30 }));

    expect(await applyViaWidget("2026-10-20T12:30", "2026-10-20T14:30")).toBe(true);
  });

  it("A のバッファ30分、本予約 B 12:30–14:30 あり、管理者が A のバッファを1時間に戻す：422 と { error: overlaps-existing }（12:30–13:00が B と重なる）。何も書かない", async () => {
    const a = await prepareA();
    await prepareBuffer(a, 30);
    await applyApproved("firm", "2026-10-20T12:30", "2026-10-20T14:30");
    const before = await scanAll();

    await expectError(await buffer(a, { bufferMinutes: 60 }), 422, "overlaps-existing");
    await expectNothingWritten(before);
  });

  it("本予約 A 09:00–12:00、バッファ1時間、管理者が A のバッファを1時間にする：200 と空の下書きの一覧。何も書かない（今と同じ）", async () => {
    const a = await prepareA();
    const before = await scanAll();

    expect(await acceptedDrafts(await buffer(a, { bufferMinutes: 60 }))).toEqual([]);
    await expectNothingWritten(before);
  });

  it("切り替えられない状態（承認待ち（本）・承認待ち（仮）・第二キープ・承認待ち（第二キープ）・取消・終了）：409 と { error: not-changeable }。何も書かない", async () => {
    const pendingFirm = await apply("firm", "2026-10-20T09:00", "2026-10-20T12:00");
    const pendingProvisional = await apply("provisional", "2026-10-21T09:00", "2026-10-21T12:00");
    await applyApproved("provisional", "2026-10-22T13:00", "2026-10-22T15:00");
    const k = await applyApproved("second-hold", "2026-10-22T14:00", "2026-10-22T17:00");
    const pendingK = await apply("second-hold", "2026-10-22T11:00", "2026-10-22T13:00");
    const cancelled = await applyApproved("firm", "2026-10-23T09:00", "2026-10-23T12:00");
    await prepareOperation({ kind: "cancel", reservationId: cancelled });
    const q = await applyApproved("provisional", "2026-10-24T13:00", "2026-10-24T15:00");
    const ended = await applyApproved("second-hold", "2026-10-24T14:00", "2026-10-24T17:00");
    await prepareOperation({ kind: "promote", reservationId: q });
    const before = await scanAll();

    for (const id of [pendingFirm, pendingProvisional, k, pendingK, cancelled, ended]) {
      await expectError(await buffer(id, { bufferMinutes: 30 }), 409, "not-changeable");
      await expectNothingWritten(before);
    }
  });

  it("ない予約の id：404 と { error: not-found }。何も書かない", async () => {
    await prepareA();
    const before = await scanAll();

    await expectError(await buffer("no-such-reservation", { bufferMinutes: 30 }), 404, "not-found");
    await expectNothingWritten(before);
  });

  it("仮予約 P 13:00–15:00、バッファ30分（占有区間 13:00–15:30）。P に付く第二キープ K 15:00–17:00（占有区間 15:00–18:00）、管理者が P のバッファを1時間にする：200 と空の下書きの一覧（K の枠と重なる部分は P が使ってよい）。P の占有区間は 13:00–16:00。K は P に付いたまま", async () => {
    const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    await prepareBuffer(p, 30);
    const k = await applyApproved("second-hold", "2026-10-20T15:00", "2026-10-20T17:00");

    expect(await acceptedDrafts(await buffer(p, { bufferMinutes: 60 }))).toEqual([]);

    expect(await occupancy("2026-10-20", p)).toEqual(["2026-10-20T13:00", "2026-10-20T16:00"]);
    expect(await occupancy("2026-10-20", k)).toEqual(["2026-10-20T15:00", "2026-10-20T18:00"]);
    const kDetail = await detailJson(k);
    expect(kDetail.status).toBe("second-hold");
    expect(kDetail.provisionalIds).toEqual([p]);
  });

  it("仮予約 P 13:00–15:00（占有区間 13:00–16:00）。P に付く第二キープ K 15:30–17:30（占有区間 15:30–18:30）、管理者が P のバッファを30分にする：200 と、K への繰り上げ案内の下書き（残っている仮予約なし）。P の占有区間は 13:00–15:30 で、K は P に付かなくなる（枠は確保したまま）", async () => {
    const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    const k = await applyApproved("second-hold", "2026-10-20T15:30", "2026-10-20T17:30");
    const drafts = await unsentDraftCount();

    expectDrafts(await acceptedDrafts(await buffer(p, { bufferMinutes: 30 })), [
      { kind: "move-up-notice", reservationId: k, remainingProvisionalIds: [] },
    ]);

    expect(await occupancy("2026-10-20", p)).toEqual(["2026-10-20T13:00", "2026-10-20T15:30"]);
    expect(await occupancy("2026-10-20", k)).toEqual(["2026-10-20T15:30", "2026-10-20T18:30"]);
    const kDetail = await detailJson(k);
    expect(kDetail.status).toBe("second-hold");
    expect(kDetail.provisionalIds ?? []).toEqual([]);
    expect(await unsentDraftCount()).toBe(drafts + 1);
  });

  it("混み合っている（A のバッファを30分にするとき、書く直前に毎回ほかの書き込みで 10/20 の版番号が進み、やり直しの上限を超える）：503 と { error: busy }。A のバッファは1時間のまま、履歴は増えない（INV-2）", async () => {
    const a = await prepareA();
    const historyBefore = (await getReservation(store, a))?.history.length;

    await expectError(
      await buffer(
        a,
        { bufferMinutes: 30 },
        { save: { maxAttempts: 2, beforeWrite: () => bumpDay("2026-10-20") } },
      ),
      503,
      "busy",
    );

    const stored = await getReservation(store, a);
    expect(stored?.bufferMinutes).toBe(60);
    expect(stored?.history.length).toBe(historyBefore);
    expect(await occupancy("2026-10-20", a)).toEqual(["2026-10-20T09:00", "2026-10-20T13:00"]);
  });
});

describe("管理 API：2回目bのルートの認証と本文のパース（INV-4）", () => {
  const validBuffer = (): unknown => ({ bufferMinutes: 30 });
  const validCustomer = (): unknown =>
    customerBody({ customer: { ...formCustomer, phone: newPhone } });

  /** どのルートも、管理者の id が取れなければ 401（本文の誤りや、ないものでも） */
  const routes: [label: string, method: "POST" | "PUT", path: string, body: () => unknown][] = [
    ["バッファの切り替え", "POST", "/admin/reservations/{a}/buffer", validBuffer],
    [
      "バッファの切り替え（本文の誤り）",
      "POST",
      "/admin/reservations/{a}/buffer",
      () => ({ bufferMinutes: 45 }),
    ],
    [
      "バッファの切り替え（ない予約）",
      "POST",
      "/admin/reservations/no-such-reservation/buffer",
      validBuffer,
    ],
    ["お客様の情報の変更", "PUT", "/admin/reservations/{a}/customer", validCustomer],
    [
      "お客様の情報の変更（本文の誤り）",
      "PUT",
      "/admin/reservations/{a}/customer",
      () => ({ customer: { name: "架空 連絡先なし" } }),
    ],
    [
      "お客様の情報の変更（ない予約）",
      "PUT",
      "/admin/reservations/no-such-reservation/customer",
      validCustomer,
    ],
  ];

  it.each(routes)(
    "管理者の id が取れない：%s（%s）は 401 と { error: unauthorized }。何も書かない",
    async (_, method, template, body) => {
      const a = await prepareA();
      const path = template.replace("{a}", a);
      const before = await scanAll();

      await expectError(
        await send(method, path, body(), now, { adminUserId: () => undefined }),
        401,
        "unauthorized",
      );
      await expectNothingWritten(before);
    },
  );

  const bufferBodies: [label: string, body: unknown][] = [
    ["空のオブジェクト", {}],
    ["バッファ45分（30分か1時間から選ぶ）", { bufferMinutes: 45 }],
    ["バッファなし（0分。予約のバッファは30分か1時間）", { bufferMinutes: 0 }],
    ["バッファ90分", { bufferMinutes: 90 }],
    ["バッファが文字列", { bufferMinutes: "30" }],
    ["余計なキー（予約の id）", { bufferMinutes: 30, reservationId: "x" }],
    ["null", null],
    ["配列", [{ bufferMinutes: 30 }]],
    ["JSON でない本文", "bufferMinutes=30"],
    ["空の本文", ""],
  ];

  it.each(bufferBodies)(
    "バッファの切り替えの本文が %s：400 と { error: invalid-input }。何も書かない",
    async (_, body) => {
      const a = await prepareA();
      const before = await scanAll();

      await expectError(await buffer(a, body), 400, "invalid-input");
      await expectNothingWritten(before);
    },
  );

  const customerBodies: [label: string, body: unknown][] = [
    ["空のオブジェクト", {}],
    ["お客様の情報がない", { shooting: { ...formShooting } }],
    ["撮影の内容がない（全部を送る）", { customer: { ...formCustomer } }],
    [
      "氏名が101文字（申込フォームの上限を超える）",
      customerBody({ customer: { ...formCustomer, name: "架".repeat(101) } }),
    ],
    [
      "メールアドレスの形が不正",
      customerBody({ customer: { ...formCustomer, email: "katachigai.kaku" } }),
    ],
    [
      "電話番号が +81 で始まる",
      customerBody({ customer: { ...formCustomer, phone: "+81-90-0000-8024" } }),
    ],
    ["住所が201文字", customerBody({ customer: { ...formCustomer, address: "架".repeat(201) } })],
    [
      "住所が空の文字列（空にするときは欄を送らない）",
      customerBody({ customer: { ...formCustomer, address: "" } }),
    ],
    [
      "会社名が101文字",
      customerBody({ customer: { ...formCustomer, companyName: "架".repeat(101) } }),
    ],
    [
      "カメラマン氏名が101文字",
      customerBody({ customer: { ...formCustomer, photographerName: "架".repeat(101) } }),
    ],
    ["撮影詳細が2001文字", customerBody({ shooting: { details: "架".repeat(2001) } })],
    ["撮影内容が選択肢にない", customerBody({ shooting: { types: ["drone"] } })],
    [
      "撮影内容が空の一覧（なしにするときは欄を送らない）",
      customerBody({ shooting: { types: [] } }),
    ],
    ["同じ撮影内容が2回ある", customerBody({ shooting: { types: ["still", "still"] } })],
    [
      "お客様の情報に余計なキー（受付番号）",
      customerBody({ customer: { ...formCustomer, receiptNumber: "ABCD2345" } }),
    ],
    ["余計なキー（状態）", { ...customerBody(), status: "firm" }],
    ["null", null],
    ["配列", [customerBody()]],
    ["JSON でない本文", "customer=x"],
    ["空の本文", ""],
  ];

  it.each(customerBodies)(
    "お客様の情報の変更の本文が %s：400 と { error: invalid-input }。何も書かない",
    async (_, body) => {
      const a = await prepareA();
      const before = await scanAll();

      await expectError(await putCustomer(a, body), 400, "invalid-input");
      await expectNothingWritten(before);
    },
  );
});

describe("管理 API：2回目bのルートのログに本文や個人情報を出さない（INV-10）", () => {
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

  it("バッファの切り替え・お客様の情報の変更（成功・何もしない・不可・できない状態・ないもの・入力の誤り・混み合っている・認証なし）の処理中のログ（console、標準出力、標準エラー）に、お客様の情報と自由記述の値、本文の値が出ない", async () => {
    const a = await prepareA();
    // B 10/21 09:00–12:00 はバッファ30分にしておき、後ろに本予約 12:30–14:30 を入れる（B を1時間に戻すと重なる）
    const b = await applyApproved("firm", "2026-10-21T09:00", "2026-10-21T12:00");
    await prepareBuffer(b, 30);
    await applyApproved("firm", "2026-10-21T12:30", "2026-10-21T14:30");
    const pending = await apply("firm", "2026-10-22T09:00", "2026-10-22T12:00");
    /** 本文に入れる、ログに出てはいけない値（架空） */
    const bodyMarker = "架空の本文の値：ログに出さない";
    const output = captureOutput();

    // バッファの切り替え：成功・何もしない・不可・できない状態・ないもの・入力の誤り・混み合っている・認証なし
    await buffer(a, { bufferMinutes: 30 });
    await buffer(a, { bufferMinutes: 30 });
    await buffer(b, { bufferMinutes: 60 });
    await buffer(pending, { bufferMinutes: 30 });
    await buffer("no-such-reservation", { bufferMinutes: 30 });
    await buffer(a, { bufferMinutes: 60, memo: bodyMarker });
    await buffer(a, `{"memo":"${bodyMarker}"`);
    await buffer(
      a,
      { bufferMinutes: 60 },
      { save: { maxAttempts: 1, beforeWrite: () => bumpDay("2026-10-20") } },
    );
    await buffer(a, { bufferMinutes: 60 }, { adminUserId: () => undefined });

    // お客様の情報の変更：成功・何もしない・入力の誤り・ないもの・認証なし
    const full = customerBody({
      customer: {
        name: newName,
        companyName: newCompanyName,
        email: newEmail,
        phone: newPhone,
        photographerName: newPhotographerName,
      },
      shooting: { types: ["movie"], details: newDetails, notes: newNotes },
    });
    await putCustomer(a, full);
    await putCustomer(a, full);
    await putCustomer(
      pending,
      customerBody({ customer: { ...formCustomer, email: "not-an-email" } }),
    );
    await putCustomer(pending, customerBody({ customer: { name: formCustomer.name } }));
    await putCustomer(pending, { ...customerBody(), memo: bodyMarker });
    await putCustomer(pending, `{"customer":{"name":"${formCustomer.name}"`);
    await putCustomer("no-such-reservation", full);
    await putCustomer(b, full, { adminUserId: () => undefined });

    const text = output();
    for (const value of [...personalValues, bodyMarker]) {
      expect(text).not.toContain(value);
    }
  });
});
