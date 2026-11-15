import {
  type AttributeValue,
  CreateTableCommand,
  DeleteTableCommand,
  GetItemCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";
import { PriceTable, Yen } from "@zebra/contracts";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalDynamoClient } from "./client.ts";
import { saveCustomerInfo } from "./customer-info.ts";
import {
  type SaveDraftStatusOptions,
  type SaveDraftStatusResult,
  type StoredDraft,
  getDraft,
  listReservationDrafts,
  listUnsentDrafts,
  saveDraftStatus,
} from "./drafts.ts";
import {
  type ReservationOperationInput,
  type SavedDraft,
  saveReservationOperation,
} from "./operations.ts";
import {
  type ApplicationKind,
  type ReservationApplication,
  type ReservationStore,
  saveApplication,
} from "./reservations.ts";

// 下書きの読み出しと、送信済み・送らないの保存（listUnsentDrafts・listReservationDrafts・getDraft・saveDraftStatus）の
// 統合テスト（DynamoDB Local）。
// 根拠：docs/product-specs/mail.md「下書きの送り方」、docs/design-docs/dynamodb-keys.md（下書きのアイテム
// pk = RES#<あて先の予約の id>、sk = DRAFT#<日時（UTC）>#<連番>。未送信の下書きの GSI gsi1pk = DRAFT#UNSENT、
// gsi1sk = 作った日時。送信済み・送らないにしたら、状態と、その日時・管理者の id を書き、GSI の属性を消す）、
// admin-api.md「下書き（3回目）」（未送信の下書きだけを、未送信であることを条件に書く。ほかは draft-not-unsent、
// なければ not-found）、core-beliefs.md（INV-6、INV-7、INV-10）。
// - 下書きは、テストから直接入れずに、申込の保存（saveApplication）と承認などの保存（saveReservationOperation）で作る。
//   下書きの sk は、saveReservationOperation が返す下書き（SavedDraft）の sk を使う
// - 下書きの状態・日時・管理者の id の属性名は資料にないので、読み出しの関数の戻り値と、アイテムの中の値（文字列）で確かめる。
//   直接見るのは、資料にある pk・sk・gsi1pk・gsi1sk と、アイテムの中の文字列の値だけ
// - 「作った順」は、作った日時の早い順。同じ操作で作った下書き（同じ日時）どうしの並びは決めていないので、
//   並びを確かめるときは、作った日時が違う下書きだけを使う
// - 例の表の行（下書きの送り方）は、管理 API のテスト（apps/api/src/admin/routes-round3.int.test.ts）で it にする。
//   ここでは、その行を保存の層で支える振る舞いを確かめる

const client = createLocalDynamoClient();
let store: ReservationStore;

// テーブルはキー設計どおり（pk・sk、GSI の gsi1pk・gsi1sk）にテストごとに作り、終わったら消す
async function createTable(): Promise<ReservationStore> {
  const tableName = `int-test-drafts-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
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
/** 準備の操作の時刻（固定。下書きを作った日時を違えるため、いくつか使う） */
const preparedAt1 = jst("2026-10-02T12:00");
const preparedAt2 = jst("2026-10-03T12:00");
const preparedAt3 = jst("2026-10-04T12:00");
/** 確かめる操作（送信済み・送らない）の時刻（固定） */
const operatedAt = jst("2026-10-05T09:00");

/** 準備の操作をした管理者と、送信済み・送らないにした管理者（架空のユーザー id。見分けるため別にする） */
const preparingAdminUserId = "admin-user-kaku-drafts-prep";
const adminUserId = "admin-user-kaku-drafts-1";
const otherAdminUserId = "admin-user-kaku-drafts-2";

// ---- 料金表（booking.md「料金」から作る。変更の見積の再計算に使う） ----

const priceTable = PriceTable.parse({
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
  name: "架空 下書子",
  email: "shitagaki.kaku@example.com",
  phone: "090-0000-3303",
  address: "架空県架空市下書町3-0-3",
  photographerName: "仮名 下書写真",
} as const;

const shooting = {
  types: ["still"],
  details: "架空の撮影詳細：下書きの保存の確認用",
  notes: "架空の補足事項：下書きの保存の確認用",
} as const;

const personalValues: readonly string[] = [
  ...Object.values(customer),
  shooting.details,
  shooting.notes,
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

/** 準備の操作をして、作った下書きを返す */
async function prepare(
  operation: ReservationOperationInput,
  at: DateTime,
): Promise<readonly SavedDraft[]> {
  const result = await saveReservationOperation(store, operation, {
    now: at,
    adminUserId: preparingAdminUserId,
  });
  if (!result.ok) {
    throw new Error(`準備の操作が不可になった（${operation.kind}、${result.reason}）`);
  }
  return result.drafts;
}

/** 準備の操作で作った下書きのうち、その予約あての1件 */
function draftFor(drafts: readonly SavedDraft[], reservationId: string): SavedDraft {
  const found = drafts.filter((d) => d.draft.reservationId === reservationId);
  expect(found).toHaveLength(1);
  const draft = found[0];
  if (draft === undefined) throw new Error("下書きがない");
  return draft;
}

/** 本予約を申込んで、承認する（確定金額 22,000円）。承認の下書きを返す */
async function approvedFirm(
  start: string,
  end: string,
  at: DateTime = preparedAt1,
): Promise<{ id: string; approval: SavedDraft }> {
  const id = await apply("firm", start, end);
  const drafts = await prepare(
    { kind: "approve", reservationId: id, confirmedPrice: Yen.parse(22_000) },
    at,
  );
  return { id, approval: draftFor(drafts, id) };
}

function changeOf(reservationId: string, start: string, end: string): ReservationOperationInput {
  return {
    kind: "change",
    reservationId,
    start: jst(start),
    end: jst(end),
    content: {
      partySize: 4,
      cycloramaFloorProtection: false,
      equipmentInsurance: false,
      optionIds: [],
    },
    confirmedPrice: Yen.parse(22_000),
    priceTable,
  };
}

async function mark(
  reservationId: string,
  sk: string,
  status: "sent" | "skipped",
  options: Partial<SaveDraftStatusOptions> = {},
): Promise<SaveDraftStatusResult> {
  return saveDraftStatus(
    store,
    { reservationId, sk, status },
    { now: operatedAt, adminUserId, ...options },
  );
}

async function markOk(
  reservationId: string,
  sk: string,
  status: "sent" | "skipped",
  options: Partial<SaveDraftStatusOptions> = {},
): Promise<void> {
  expect(await mark(reservationId, sk, status, options)).toEqual({ ok: true });
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

async function getItem(pk: string, sk: string): Promise<PlainItem | undefined> {
  const res = await client.send(
    new GetItemCommand({
      TableName: store.tableName,
      Key: { pk: { S: pk }, sk: { S: sk } },
      ConsistentRead: true,
    }),
  );
  return res.Item === undefined ? undefined : plainItem(res.Item);
}

/** 未送信の下書きの GSI に入っているアイテムのキー（pk sk） */
async function unsentGsiKeys(): Promise<string[]> {
  const res = await client.send(
    new QueryCommand({
      TableName: store.tableName,
      IndexName: "gsi1",
      KeyConditionExpression: "gsi1pk = :pk",
      ExpressionAttributeValues: { ":pk": { S: "DRAFT#UNSENT" } },
    }),
  );
  return (res.Items ?? []).map((item) => itemKey(plainItem(item)));
}

/** アイテムの中の文字列のうち、指定の時点を UTC で表した ISO 8601 のもの（INV-7） */
function utcInstantsIn(item: PlainItem | undefined, at: DateTime): string[] {
  return stringsIn(item).filter((value) => {
    const parsed = DateTime.fromISO(value, { setZone: true });
    return parsed.isValid && parsed.offset === 0 && parsed.toMillis() === at.toMillis();
  });
}

/**
 * 送信済み・送らないにしたあと、変わったアイテムがその下書き1件だけで、その下書きは GSI の属性（gsi1pk・gsi1sk）を
 * 持たず、操作の日時（UTC）と管理者の id を持つことを確かめる
 */
async function expectOnlyDraftMarked(
  before: readonly PlainItem[],
  reservationId: string,
  sk: string,
  at: DateTime = operatedAt,
  by: string = adminUserId,
): Promise<void> {
  const isTarget = (item: PlainItem) => item["pk"] === `RES#${reservationId}` && item["sk"] === sk;
  const after = await scanAll();
  expect(after.map(itemKey).sort()).toEqual(before.map(itemKey).sort());
  expect(sortedItems(after.filter((i) => !isTarget(i)))).toEqual(
    sortedItems(before.filter((i) => !isTarget(i))),
  );
  const item = await getItem(`RES#${reservationId}`, sk);
  expect(item).toBeDefined();
  expect(item).not.toHaveProperty("gsi1pk");
  expect(item).not.toHaveProperty("gsi1sk");
  expect(stringsIn(item)).toContain(by);
  expect(utcInstantsIn(item, at).length, JSON.stringify(item)).toBeGreaterThanOrEqual(1);
}

/** 読み出した下書きが、準備の操作で作った下書きと同じもの（種類・あて先・差し込む値）で、指定の状態であること */
function expectStored(
  actual: StoredDraft | undefined | null,
  expected: SavedDraft,
  createdAt: DateTime,
  status: StoredDraft["status"],
): void {
  expect(actual).toBeDefined();
  expect(actual).not.toBeNull();
  if (actual === undefined || actual === null) return;
  expect(actual.sk).toBe(expected.sk);
  expect(actual.draft).toEqual(expected.draft);
  expect(actual.status).toBe(status);
  expect(actual.createdAt.toMillis()).toBe(createdAt.toMillis());
  if (status === "unsent") {
    expect(actual.statusChange).toBeUndefined();
  }
}

// ---- テスト ----

describe("下書きの読み出し（保存の層）", () => {
  it("未送信の下書きの一覧：作った順（古い順）に、種類・あて先の予約の id・差し込む値・未送信・作った日時を返す（予約をまたいで GSI の作った日時の順）", async () => {
    // B を先に承認し、A をあとで承認し、最後に B を取消す。予約の id の順ではなく、作った順に並ぶ
    const a = await apply("firm", "2026-10-20T10:00", "2026-10-20T12:00");
    const b = await apply("firm", "2026-10-21T10:00", "2026-10-21T12:00");
    const approvalB = draftFor(
      await prepare(
        { kind: "approve", reservationId: b, confirmedPrice: Yen.parse(22_000) },
        preparedAt1,
      ),
      b,
    );
    const approvalA = draftFor(
      await prepare(
        { kind: "approve", reservationId: a, confirmedPrice: Yen.parse(22_000) },
        preparedAt2,
      ),
      a,
    );
    const cancellationB = draftFor(
      await prepare({ kind: "cancel", reservationId: b }, preparedAt3),
      b,
    );
    // 10/04 に、利用日 10/21 の本予約を取消：4日以上前なので 50%（booking.md「取消とキャンセル料」）
    expect(cancellationB.draft).toEqual({
      kind: "cancellation",
      reservationId: b,
      cancellationFee: { ratePercent: 50, fee: Yen.parse(11_000) },
    });

    const unsent = await listUnsentDrafts(store);

    expect(unsent).toHaveLength(3);
    expectStored(unsent[0], approvalB, preparedAt1, "unsent");
    expectStored(unsent[1], approvalA, preparedAt2, "unsent");
    expectStored(unsent[2], cancellationB, preparedAt3, "unsent");
  });

  it("未送信の下書きがない：空", async () => {
    await apply("firm", "2026-10-20T10:00", "2026-10-20T12:00");

    expect(await listUnsentDrafts(store)).toEqual([]);
  });

  it("予約ごとの下書きの一覧：その予約の下書きすべて（送信済み・送らないも）を作った順に返す。ほかの予約の下書きは出ない", async () => {
    const { id: a, approval } = await approvedFirm(
      "2026-10-20T10:00",
      "2026-10-20T12:00",
      preparedAt1,
    );
    const change = draftFor(
      await prepare(changeOf(a, "2026-10-27T10:00", "2026-10-27T12:00"), preparedAt2),
      a,
    );
    const cancellation = draftFor(
      await prepare({ kind: "cancel", reservationId: a }, preparedAt3),
      a,
    );
    const { id: b } = await approvedFirm("2026-10-21T10:00", "2026-10-21T12:00", preparedAt2);
    await markOk(a, approval.sk, "sent");
    await markOk(a, change.sk, "skipped", { adminUserId: otherAdminUserId });

    const drafts = await listReservationDrafts(store, a);

    expect(drafts).toHaveLength(3);
    expectStored(drafts[0], approval, preparedAt1, "sent");
    expect(drafts[0]?.statusChange?.at.toMillis()).toBe(operatedAt.toMillis());
    expect(drafts[0]?.statusChange?.adminUserId).toBe(adminUserId);
    expectStored(drafts[1], change, preparedAt2, "skipped");
    expect(drafts[1]?.statusChange?.at.toMillis()).toBe(operatedAt.toMillis());
    expect(drafts[1]?.statusChange?.adminUserId).toBe(otherAdminUserId);
    expectStored(drafts[2], cancellation, preparedAt3, "unsent");
    expect(drafts.every((d) => d.draft.reservationId === a)).toBe(true);
    expect((await listReservationDrafts(store, b)).map((d) => d.draft.reservationId)).toEqual([b]);
  });

  it("下書きのない予約（承認待ち）の、予約ごとの下書きの一覧：空", async () => {
    const pending = await apply("firm", "2026-10-20T10:00", "2026-10-20T12:00");

    expect(await listReservationDrafts(store, pending)).toEqual([]);
  });

  it("1件を読む：予約の id と sk で、種類・差し込む値・状態・作った日時を返す", async () => {
    const { id: a, approval } = await approvedFirm("2026-10-20T10:00", "2026-10-20T12:00");
    expect(approval.draft).toEqual({
      kind: "approval",
      reservationId: a,
      confirmedPrice: Yen.parse(22_000),
    });

    expectStored(await getDraft(store, a, approval.sk), approval, preparedAt1, "unsent");
  });

  it("1件を読む：ない sk、ほかの予約の下書きの sk、ない予約は、どれも null", async () => {
    const { id: a } = await approvedFirm("2026-10-20T10:00", "2026-10-20T12:00");
    const { id: b, approval: approvalB } = await approvedFirm(
      "2026-10-21T10:00",
      "2026-10-21T12:00",
      preparedAt2,
    );

    expect(await getDraft(store, a, "DRAFT#2026-10-02T03:00:00.000Z#9")).toBeNull();
    expect(await getDraft(store, a, approvalB.sk)).toBeNull();
    expect(await getDraft(store, "no-such-reservation", approvalB.sk)).toBeNull();
    // 下書きでないアイテムの sk（予約の META・個人情報）も、下書きとしては読めない
    expect(await getDraft(store, b, "META")).toBeNull();
    expect(await getDraft(store, b, "PII")).toBeNull();
  });
});

describe("下書きを送信済み・送らないにする（保存の層）", () => {
  it("未送信の下書きを送信済みにする：成功。状態は送信済みになり、その日時と管理者の id を書き、未送信の一覧の GSI の属性を消す。ほかのアイテムは変わらない", async () => {
    const { id: a, approval } = await approvedFirm("2026-10-20T10:00", "2026-10-20T12:00");
    expect(await unsentGsiKeys()).toEqual([`RES#${a} ${approval.sk}`]);
    const before = await scanAll();

    await markOk(a, approval.sk, "sent");

    await expectOnlyDraftMarked(before, a, approval.sk);
    expect(await unsentGsiKeys()).toEqual([]);
    expect(await listUnsentDrafts(store)).toEqual([]);
    const stored = await getDraft(store, a, approval.sk);
    expectStored(stored, approval, preparedAt1, "sent");
    expect(stored?.statusChange?.at.toMillis()).toBe(operatedAt.toMillis());
    expect(stored?.statusChange?.adminUserId).toBe(adminUserId);
  });

  it("未送信の下書きを送らないにする：成功。状態は送らないになり、その日時と管理者の id を書き、未送信の一覧の GSI の属性を消す。ほかのアイテムは変わらない", async () => {
    const { id: a, approval } = await approvedFirm("2026-10-20T10:00", "2026-10-20T12:00");
    const before = await scanAll();

    await markOk(a, approval.sk, "skipped");

    await expectOnlyDraftMarked(before, a, approval.sk);
    expect(await unsentGsiKeys()).toEqual([]);
    const stored = await getDraft(store, a, approval.sk);
    expectStored(stored, approval, preparedAt1, "skipped");
    expect(stored?.statusChange?.at.toMillis()).toBe(operatedAt.toMillis());
    expect(stored?.statusChange?.adminUserId).toBe(adminUserId);
  });

  it("同じ操作で作った2件の下書きの片方を送信済みにする：もう片方は未送信のまま、未送信の一覧に残る", async () => {
    // 仮予約 P に第二キープ K が付いているときに P を取消すと、P の取消と K への繰り上げ案内の2件ができる
    const p = await apply("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    await prepare(
      { kind: "approve", reservationId: p, confirmedPrice: Yen.parse(22_000) },
      preparedAt1,
    );
    const k = await apply("second-hold", "2026-10-20T14:00", "2026-10-20T17:00");
    await prepare(
      { kind: "approve", reservationId: k, confirmedPrice: Yen.parse(22_000) },
      preparedAt1,
    );
    const drafts = await prepare({ kind: "cancel", reservationId: p }, preparedAt2);
    const cancellation = draftFor(drafts, p);
    const notice = draftFor(drafts, k);
    const before = await scanAll();

    await markOk(p, cancellation.sk, "sent");

    await expectOnlyDraftMarked(before, p, cancellation.sk);
    expect(await unsentGsiKeys()).not.toContain(`RES#${p} ${cancellation.sk}`);
    expect(await unsentGsiKeys()).toContain(`RES#${k} ${notice.sk}`);
    expectStored(await getDraft(store, k, notice.sk), notice, preparedAt2, "unsent");
  });

  it.each([
    ["送信済みの下書きを送らないにする", "sent", "skipped"],
    ["送らないにした下書きを送信済みにする", "skipped", "sent"],
    ["送信済みの下書きをもう一度送信済みにする", "sent", "sent"],
    ["送らないにした下書きをもう一度送らないにする", "skipped", "skipped"],
  ] as const)(
    "%s：不可（draft-not-unsent。未送信の下書きだけ変えられる）。何も書かれない（日時と管理者の id は最初のまま）",
    async (_, first, second) => {
      const { id: a, approval } = await approvedFirm("2026-10-20T10:00", "2026-10-20T12:00");
      await markOk(a, approval.sk, first);
      const before = await scanAll();

      expect(
        await mark(a, approval.sk, second, {
          now: operatedAt.plus({ hours: 1 }),
          adminUserId: otherAdminUserId,
        }),
      ).toEqual({ ok: false, reason: "draft-not-unsent" });

      await expectNothingWritten(before);
      const stored = await getDraft(store, a, approval.sk);
      expect(stored?.status).toBe(first);
      expect(stored?.statusChange?.at.toMillis()).toBe(operatedAt.toMillis());
      expect(stored?.statusChange?.adminUserId).toBe(adminUserId);
    },
  );

  it("同じ未送信の下書きを、同時に送信済みと送らないにする：片方だけが成功し、もう片方は draft-not-unsent（未送信であることを条件に書く）", async () => {
    const { id: a, approval } = await approvedFirm("2026-10-20T10:00", "2026-10-20T12:00");

    const results = await Promise.all([
      mark(a, approval.sk, "sent"),
      mark(a, approval.sk, "skipped", { adminUserId: otherAdminUserId }),
    ]);

    const succeeded = results.filter((r) => r.ok);
    expect(succeeded).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "draft-not-unsent" }]);
    const stored = await getDraft(store, a, approval.sk);
    const winner = results[0]?.ok === true ? "sent" : "skipped";
    expect(stored?.status).toBe(winner);
    expect(stored?.statusChange?.adminUserId).toBe(
      winner === "sent" ? adminUserId : otherAdminUserId,
    );
    expect(await unsentGsiKeys()).toEqual([]);
  });

  it("ない下書き（ない sk、ほかの予約の下書きの sk、ない予約、下書きでないアイテムの sk）を送信済み・送らないにする：不可（not-found）。何も書かれない（アイテムを作らない）", async () => {
    const { id: a } = await approvedFirm("2026-10-20T10:00", "2026-10-20T12:00");
    const { approval: approvalB } = await approvedFirm(
      "2026-10-21T10:00",
      "2026-10-21T12:00",
      preparedAt2,
    );
    const before = await scanAll();

    for (const status of ["sent", "skipped"] as const) {
      for (const [reservationId, sk] of [
        [a, "DRAFT#2026-10-02T03:00:00.000Z#9"],
        [a, approvalB.sk],
        ["no-such-reservation", approvalB.sk],
        [a, "META"],
        [a, "PII"],
      ] as const) {
        expect(await mark(reservationId, sk, status), `${status} ${reservationId} ${sk}`).toEqual({
          ok: false,
          reason: "not-found",
        });
        await expectNothingWritten(before);
      }
    }
  });

  it("UTC で表した現在時刻で送信済みにする：書いた日時は UTC で、同じ時点（INV-7）", async () => {
    const { id: a, approval } = await approvedFirm("2026-10-20T10:00", "2026-10-20T12:00");
    const before = await scanAll();

    await markOk(a, approval.sk, "sent", { now: operatedAt.toUTC() });

    await expectOnlyDraftMarked(before, a, approval.sk, operatedAt);
    expect((await getDraft(store, a, approval.sk))?.statusChange?.at.toMillis()).toBe(
      operatedAt.toMillis(),
    );
  });

  it("送信済み・送らないにしたあとも、下書きのアイテムには文面とお客様の情報（自由記述を含む）がない（INV-10）", async () => {
    const { id: a, approval } = await approvedFirm("2026-10-20T10:00", "2026-10-20T12:00");
    const cancellation = draftFor(
      await prepare({ kind: "cancel", reservationId: a }, preparedAt2),
      a,
    );
    await markOk(a, approval.sk, "sent");
    await markOk(a, cancellation.sk, "skipped");

    const items = (await scanAll()).filter((item) => String(item["sk"]).startsWith("DRAFT#"));
    expect(items).toHaveLength(2);
    for (const item of items) {
      for (const value of stringsIn(item)) {
        for (const personal of personalValues) {
          expect(value, itemKey(item)).not.toContain(personal);
        }
        expect(value, itemKey(item)).not.toContain("スタジオゼブラ");
      }
    }
  });

  it("メールアドレスを消した予約の下書きも、送信済みにできる（電話で伝えたとき。mail.md「下書きの送り方」）", async () => {
    const { id: a, approval } = await approvedFirm("2026-10-20T10:00", "2026-10-20T12:00");
    const withoutEmail = {
      name: customer.name,
      phone: customer.phone,
      address: customer.address,
      photographerName: customer.photographerName,
    };
    const saved = await saveCustomerInfo(
      store,
      { reservationId: a, customer: withoutEmail, shooting },
      { now: preparedAt2, adminUserId: preparingAdminUserId },
    );
    expect(saved.ok).toBe(true);
    const before = await scanAll();

    await markOk(a, approval.sk, "sent");

    await expectOnlyDraftMarked(before, a, approval.sk);
  });
});
