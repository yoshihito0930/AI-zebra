import {
  type AttributeValue,
  CreateTableCommand,
  DeleteTableCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";
import { Yen } from "@zebra/contracts";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalDynamoClient } from "./client.ts";
import {
  type CustomerInfoChange,
  type SaveCustomerInfoOptions,
  type SaveCustomerInfoResult,
  saveCustomerInfo,
} from "./customer-info.ts";
import { type ReservationOperationInput, saveReservationOperation } from "./operations.ts";
import {
  type ApplicationKind,
  type ReservationApplication,
  type ReservationStore,
  type StoredCustomerInfo,
  type StoredShootingInfo,
  getReservation,
  saveApplication,
} from "./reservations.ts";

// お客様の情報・撮影の内容の変更の保存（saveCustomerInfo）の統合テスト（DynamoDB Local）。
// 根拠：docs/product-specs/booking.md「お客様の情報・撮影の内容を直す」、reservation-model.md（状態と操作、履歴）、
// dynamodb-keys.md（アイテム：個人情報は PII のアイテム、履歴は個人情報の項目名だけ）、
// admin-api.md「お客様の情報・撮影の内容の変更」、core-beliefs.md（INV-2、INV-7、INV-10）。
// - 入力の形の確かめ（氏名と連絡先が1つあること、欄の形と長さの上限）は API の層の仕事なので、ここでは扱わない
//   （例の表の「不可」の行は、管理 API のテスト routes-round2b.int.test.ts で確かめる）
// - 予約は、テストから直接入れずに申込の保存（saveApplication）と承認などの保存（saveReservationOperation）で作る
// - お客様の情報と撮影の内容は予約の詳細（getReservation）で確かめる。履歴の属性名は資料にないので、予約の詳細の履歴と、
//   アイテムの中の値で確かめる。直接見るのは、資料にある pk・sk と、アイテムの中の文字列の値だけ
// - changedFields の名前と並びは、契約の AdminCustomerField（name、companyName、email、phone、address、photographerName、
//   shootingTypes、shootingDetails、shootingNotes の順）

const client = createLocalDynamoClient();
let store: ReservationStore;

// テーブルはキー設計どおり（pk・sk、GSI の gsi1pk・gsi1sk）にテストごとに作り、終わったら消す
async function createTable(): Promise<ReservationStore> {
  const tableName = `int-test-customer-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
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
/** テストの準備でする承認・取消・昇格の時刻（固定） */
const preparedAt = jst("2026-10-02T12:00");
/** 確かめる操作の時刻（固定） */
const operatedAt = jst("2026-10-05T09:00");

/** 操作した管理者（架空のユーザー id） */
const adminUserId = "admin-user-kaku-customer-1";

// ---- 架空のお客様の情報（INV-10 の確認に使うので、ほかの値と紛れない文字列にする） ----

/** フォームから申込んだお客様（氏名・メールアドレス・電話番号・住所・カメラマン氏名あり。会社名なし。フォームではカメラマン氏名も必須） */
const formCustomer = {
  name: "架空 直子",
  email: "naoko.kaku@example.com",
  phone: "090-0000-1357",
  address: "架空県架空市修正町1-3-5",
  photographerName: "仮名 修正写真",
} as const satisfies StoredCustomerInfo;

const formShooting = {
  types: ["still"],
  details: "架空の撮影詳細：お客様の情報の変更の確認用（直す前）",
  notes: "架空の補足事項：お客様の情報の変更の確認用（直す前）",
} as const satisfies StoredShootingInfo;

/** 直したあとの値（架空） */
const newPhone = "080-0000-2468";
const newEmail = "naoko.new.kaku@example.com";
const newName = "架空 直子（旧姓 仮名）";
const newCompanyName = "架空修正株式会社";
const newPhotographerName = "仮名 修正撮影";
const newDetails = "架空の撮影詳細：お客様の情報の変更の確認用（直したあと）";
const newNotes = "架空の補足事項：お客様の情報の変更の確認用（直したあと）";

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

// ---- 準備の道具 ----

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
    adminUserId,
  });
  if (!result.ok) {
    throw new Error(`準備の操作が不可になった（${operation.kind}、${result.reason}）`);
  }
}

async function applyApproved(kind: ApplicationKind, start: string, end: string): Promise<string> {
  const id = await apply(kind, start, end);
  await prepareOperation({ kind: "approve", reservationId: id, confirmedPrice: Yen.parse(22_000) });
  return id;
}

/** フォームから申込んだ本予約 10/20 10:00–12:00（承認済み） */
async function prepareFirm(): Promise<string> {
  return applyApproved("firm", "2026-10-20T10:00", "2026-10-20T12:00");
}

async function saveInfo(
  reservationId: string,
  value: Omit<CustomerInfoChange, "reservationId">,
  options: Partial<SaveCustomerInfoOptions> = {},
): Promise<SaveCustomerInfoResult> {
  return saveCustomerInfo(
    store,
    { reservationId, ...value },
    { now: operatedAt, adminUserId, ...options },
  );
}

// ---- テーブルを直接読む道具（DynamoDB の属性の形を、普通の値に直す） ----

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

async function expectNothingWritten(before: readonly PlainItem[]): Promise<void> {
  expect(sortedItems(await scanAll())).toEqual(sortedItems(before));
}

function isPii(item: PlainItem): boolean {
  return item["sk"] === "PII";
}
function isHistory(item: PlainItem): boolean {
  return String(item["sk"]).startsWith("HIST#");
}

/**
 * 変更のあと、増えた・変わったアイテムが、その予約の PII と、その予約の履歴1件だけであることを確かめる
 * （日ごとのアイテム・META・下書き・ほかの予約は書かない。admin-api.md「保存は、PII の置き換えと履歴を、1トランザクションで書く」）。
 * 増えた履歴のアイテムを返す
 */
async function expectOnlyPiiAndOneHistoryWritten(
  before: readonly PlainItem[],
  id: string,
): Promise<PlainItem> {
  const after = await scanAll();
  const untouched = (items: readonly PlainItem[]) =>
    sortedItems(items.filter((item) => !(item["pk"] === `RES#${id}` && isPii(item))));
  const beforeKeys = new Set(before.map(itemKey));
  const added = after.filter((item) => !beforeKeys.has(itemKey(item)));
  expect(added.map(itemKey)).toHaveLength(1);
  const history = added[0];
  if (history === undefined) throw new Error("履歴のアイテムが増えていない");
  expect(history["pk"]).toBe(`RES#${id}`);
  expect(isHistory(history), itemKey(history)).toBe(true);
  expect(untouched(after.filter((item) => item !== history))).toEqual(untouched(before));
  return history;
}

function expectNoPersonalInfo(item: PlainItem): void {
  const strings = stringsIn(item);
  for (const personal of personalValues) {
    for (const s of strings) {
      expect(s, itemKey(item)).not.toContain(personal);
    }
  }
}

async function piiItem(id: string): Promise<PlainItem | undefined> {
  return (await scanAll()).find((item) => item["pk"] === `RES#${id}` && isPii(item));
}

async function historyItems(id: string): Promise<PlainItem[]> {
  const res = await client.send(
    new QueryCommand({
      TableName: store.tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :hist)",
      ExpressionAttributeValues: { ":pk": { S: `RES#${id}` }, ":hist": { S: "HIST#" } },
      ConsistentRead: true,
    }),
  );
  return (res.Items ?? []).map(plainItem);
}

async function lastHistory(id: string) {
  const detail = await getReservation(store, id);
  expect(detail).not.toBeNull();
  const entry = detail?.history.at(-1);
  expect(entry).toBeDefined();
  return entry;
}

// ---- テスト ----

describe("お客様の情報・撮影の内容の変更の保存", () => {
  it("フォームから申込んだ本予約の電話番号を直す：成功（changedFields は phone だけ）。詳細の電話番号が新しくなり、ほかの欄は変わらない。履歴（管理者・customer-info-change・changedFields は phone だけ）が1件増え、履歴のアイテムには電話番号の中身（前も後も）がない。PII と履歴のほかは何も書かない", async () => {
    const a = await prepareFirm();
    const before = await scanAll();
    const histories = (await getReservation(store, a))?.history.length ?? 0;

    expect(
      await saveInfo(a, { customer: { ...formCustomer, phone: newPhone }, shooting: formShooting }),
    ).toEqual({ ok: true, changedFields: ["phone"] });

    const detail = await getReservation(store, a);
    expect(detail?.customer).toEqual({ ...formCustomer, phone: newPhone });
    expect(detail?.shooting).toEqual(formShooting);
    expect(detail?.status).toBe("firm");
    expect(detail?.history).toHaveLength(histories + 1);
    const entry = detail?.history.at(-1);
    expect(entry?.at.toMillis()).toBe(operatedAt.toMillis());
    expect(entry?.actor).toEqual({ kind: "admin", userId: adminUserId });
    expect(entry?.operation).toBe("customer-info-change");
    expect(entry?.changedFields).toEqual(["phone"]);

    const history = await expectOnlyPiiAndOneHistoryWritten(before, a);
    expect(stringsIn(history)).not.toContain(formCustomer.phone);
    expect(stringsIn(history)).not.toContain(newPhone);
    expectNoPersonalInfo(history);
  });

  it("同上の本予約の住所を空にする（住所の欄を渡さない）：成功（changedFields は address だけ）。詳細の住所はなくなり、PII のアイテムにも直す前の住所が残らない", async () => {
    const a = await prepareFirm();
    const before = await scanAll();
    const withoutAddress: StoredCustomerInfo = {
      name: formCustomer.name,
      email: formCustomer.email,
      phone: formCustomer.phone,
      photographerName: formCustomer.photographerName,
    };

    expect(await saveInfo(a, { customer: withoutAddress, shooting: formShooting })).toEqual({
      ok: true,
      changedFields: ["address"],
    });

    const detail = await getReservation(store, a);
    expect(detail?.customer).toEqual(withoutAddress);
    expect(detail?.customer.address).toBeUndefined();
    expect(stringsIn(await piiItem(a))).not.toContain(formCustomer.address);
    expect((await lastHistory(a))?.changedFields).toEqual(["address"]);
    await expectOnlyPiiAndOneHistoryWritten(before, a);
  });

  it("全部の欄を渡して置き換える：渡さなかった撮影の内容（撮影内容・補足事項）はなくなる。changedFields は変わった項目の名前を AdminCustomerField の順に並べたもの", async () => {
    const a = await prepareFirm();

    // 撮影詳細だけを渡す（撮影内容・補足事項は渡さない）。氏名・会社名・カメラマン氏名・メールアドレスも直す
    const result = await saveInfo(a, {
      customer: {
        name: newName,
        companyName: newCompanyName,
        email: newEmail,
        phone: formCustomer.phone,
        address: formCustomer.address,
        photographerName: newPhotographerName,
      },
      shooting: { details: newDetails },
    });

    expect(result).toEqual({
      ok: true,
      changedFields: [
        "name",
        "companyName",
        "email",
        "photographerName",
        "shootingTypes",
        "shootingDetails",
        "shootingNotes",
      ],
    });
    const detail = await getReservation(store, a);
    expect(detail?.customer).toEqual({
      name: newName,
      companyName: newCompanyName,
      email: newEmail,
      phone: formCustomer.phone,
      address: formCustomer.address,
      photographerName: newPhotographerName,
    });
    expect(detail?.shooting).toEqual({ details: newDetails });
    expect(detail?.shooting.types).toBeUndefined();
    expect(detail?.shooting.notes).toBeUndefined();
    expect((await lastHistory(a))?.changedFields).toEqual([
      "name",
      "companyName",
      "email",
      "photographerName",
      "shootingTypes",
      "shootingDetails",
      "shootingNotes",
    ]);
    const pii = stringsIn(await piiItem(a));
    expect(pii).not.toContain(formShooting.details);
    expect(pii).not.toContain(formShooting.notes);
  });

  it("本予約の撮影詳細を直す：成功（changedFields は shootingDetails だけ）。履歴のアイテムには撮影詳細の中身（前も後も）がない", async () => {
    const a = await prepareFirm();
    const before = await scanAll();

    expect(
      await saveInfo(a, {
        customer: formCustomer,
        shooting: { ...formShooting, details: newDetails },
      }),
    ).toEqual({ ok: true, changedFields: ["shootingDetails"] });

    expect((await getReservation(store, a))?.shooting).toEqual({
      ...formShooting,
      details: newDetails,
    });
    expect((await lastHistory(a))?.changedFields).toEqual(["shootingDetails"]);
    const history = await expectOnlyPiiAndOneHistoryWritten(before, a);
    expectNoPersonalInfo(history);
  });

  it("本予約に今と同じ内容を渡す：何もしない（成功。changedFields は空）。PII・履歴を含めて何も書かれない", async () => {
    const a = await prepareFirm();
    const before = await scanAll();

    expect(await saveInfo(a, { customer: formCustomer, shooting: formShooting })).toEqual({
      ok: true,
      changedFields: [],
    });
    await expectNothingWritten(before);
  });

  it("どの状態の予約でも直せる：承認待ち（本）・取消した本予約・終了した第二キープのメールアドレスを直す：どれも成功（changedFields は email だけ）。状態は変わらない", async () => {
    const pending = await apply("firm", "2026-10-21T10:00", "2026-10-21T12:00");
    const cancelled = await prepareFirm();
    await prepareOperation({ kind: "cancel", reservationId: cancelled });
    const p = await applyApproved("provisional", "2026-10-22T13:00", "2026-10-22T15:00");
    const ended = await applyApproved("second-hold", "2026-10-22T14:00", "2026-10-22T17:00");
    await prepareOperation({ kind: "promote", reservationId: p });

    for (const [id, status] of [
      [pending, "pending-firm"],
      [cancelled, "cancelled"],
      [ended, "ended"],
    ] as const) {
      expect((await getReservation(store, id))?.status).toBe(status);
      const before = await scanAll();

      expect(
        await saveInfo(id, {
          customer: { ...formCustomer, email: newEmail },
          shooting: formShooting,
        }),
        status,
      ).toEqual({ ok: true, changedFields: ["email"] });

      const detail = await getReservation(store, id);
      expect(detail?.status, status).toBe(status);
      expect(detail?.customer.email, status).toBe(newEmail);
      await expectOnlyPiiAndOneHistoryWritten(before, id);
    }
  });

  it("ない id の予約を直そうとする：不可（not-found）。何も書かれない（PII のアイテムも作らない）", async () => {
    await prepareFirm();
    const before = await scanAll();

    expect(
      await saveInfo("no-such-reservation", { customer: formCustomer, shooting: formShooting }),
    ).toEqual({ ok: false, reason: "not-found" });
    await expectNothingWritten(before);
  });

  it("UTC で表した現在時刻で直す：履歴の日時は同じ時点で、履歴の sk の日時は UTC（INV-7）", async () => {
    const a = await prepareFirm();

    await saveInfo(
      a,
      { customer: { ...formCustomer, phone: newPhone }, shooting: formShooting },
      { now: operatedAt.toUTC() },
    );

    expect((await lastHistory(a))?.at.toMillis()).toBe(operatedAt.toMillis());
    for (const item of await historyItems(a)) {
      const match = /^HIST#([^#]+)#\d+$/.exec(String(item["sk"]));
      expect(match).not.toBeNull();
      expect(DateTime.fromISO(match?.[1] ?? "", { setZone: true }).offset).toBe(0);
    }
  });

  it("直したあと：お客様の情報と撮影の内容（自由記述）の値は、前も後も PII のアイテムにだけあり、META・DAY#・HIST#・DRAFT# のどのアイテムにもない（INV-10）", async () => {
    const a = await prepareFirm();
    await saveInfo(a, {
      customer: {
        name: newName,
        companyName: newCompanyName,
        email: newEmail,
        phone: newPhone,
        photographerName: newPhotographerName,
      },
      shooting: { types: ["movie"], details: newDetails, notes: newNotes },
    });

    const notPii = (await scanAll()).filter((item) => !isPii(item));
    expect(notPii.some(isHistory)).toBe(true);
    for (const item of notPii) {
      expectNoPersonalInfo(item);
    }
  });
});
