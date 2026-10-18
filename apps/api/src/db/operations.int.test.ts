import {
  type AttributeValue,
  CreateTableCommand,
  DeleteTableCommand,
  GetItemCommand,
  QueryCommand,
  ScanCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { PriceTable, Yen } from "@zebra/contracts";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalDynamoClient } from "./client.ts";
import {
  type OperationDraft,
  type ReservationChangeContent,
  type ReservationOperationInput,
  type SaveOperationOptions,
  type SaveOperationResult,
  type SavedDraft,
  saveReservationOperation,
} from "./operations.ts";
import {
  type ApplicationKind,
  type ReservationApplication,
  type ReservationStore,
  getReservation,
  saveApplication,
} from "./reservations.ts";

// 予約への操作（承認・却下・昇格・取消・繰り上げ・変更）の保存の統合テスト（DynamoDB Local）。
// 根拠：docs/design-docs/dynamodb-keys.md（日ごとのアイテムの属性、書き込みの手順、下書きのアイテム）、
// reservation-model.md（状態と操作、第二キープと仮予約、金額、履歴）、core-beliefs.md（INV-1、INV-2、INV-6、INV-7、INV-9、INV-10）。
// 状態・枠・下書きの細かい決まりは booking-core の単体テストで確かめているので、ここでは代表的な場合と、
// それが1回の書き込みで DB に残ること（残らないこと）を確かめる。
// 予約は、テストから直接入れずに申込の保存（saveApplication）と承認の保存で作る（META の属性名は資料にないため）。
// META・履歴・下書きの属性名は資料にないので、予約の詳細（getReservation）・関数の戻り値・アイテムの中の値で確かめる。
// 直接見る属性は、資料にある pk・sk・gsi1pk・gsi1sk・version・intervals だけ。
// バッファの切り替え・直接入力・ブロック枠の保存は、この PR では扱わない。

const client = createLocalDynamoClient();
let store: ReservationStore;

// テーブルはキー設計どおり（pk・sk、GSI の gsi1pk・gsi1sk）にテストごとに作り、終わったら消す
async function createTable(): Promise<ReservationStore> {
  const tableName = `int-test-ops-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
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
/** テストの準備でする承認・取消の時刻（固定） */
const preparedAt = jst("2026-10-02T12:00");
/** 確かめる操作の時刻（固定） */
const operatedAt = jst("2026-10-05T09:00");

/** 操作した管理者（架空のユーザー id） */
const adminUserId = "admin-user-kaku-1";
const otherAdminUserId = "admin-user-kaku-2";

/** 保存された日時の文字列が、UTC で表されていて（INV-7）、指定の時点と同じかを確かめる */
function expectUtcInstant(value: unknown, expected: DateTime): void {
  expect(typeof value).toBe("string");
  const parsed = DateTime.fromISO(value as string, { setZone: true });
  expect(parsed.isValid).toBe(true);
  expect(parsed.offset).toBe(0);
  expect(parsed.toMillis()).toBe(expected.toMillis());
}

// ---- 料金表（booking.md「料金」の単価・追加・プランの決め方から作る。変更の見積の再計算に使う） ----

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
  name: "架空 次郎",
  companyName: "架空映像合同会社",
  email: "jiro.kaku@example.com",
  phone: "090-0000-5678",
  address: "架空県架空市架空台4-5-6",
  photographerName: "仮名 写真花子",
} as const;

const shooting = {
  types: ["still"],
  details: "架空の撮影詳細：雑誌の表紙の撮影",
  notes: "架空の補足事項：駐車場を1台使う",
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

/** 変更後の申込の内容。どのテストも日時だけを変えるので、申込と同じ内容にする */
const sameContent: ReservationChangeContent = {
  partySize: 4,
  cycloramaFloorProtection: false,
  equipmentInsurance: false,
  optionIds: [],
};

// ---- 準備の道具 ----

async function apply(kind: ApplicationKind, start: string, end: string): Promise<string> {
  const result = await saveApplication(store, application(kind, start, end), { now: appliedAt });
  if (!result.ok) {
    throw new Error(`準備の申込が不可になった（${kind} ${start}–${end}、${result.reason}）`);
  }
  return result.id;
}

async function operate(
  operation: ReservationOperationInput,
  options: Partial<SaveOperationOptions> = {},
): Promise<SaveOperationResult> {
  return saveReservationOperation(store, operation, {
    now: operatedAt,
    adminUserId,
    ...options,
  });
}

async function operateOk(
  operation: ReservationOperationInput,
  options: Partial<SaveOperationOptions> = {},
): Promise<readonly SavedDraft[]> {
  const result = await operate(operation, options);
  if (!result.ok) {
    throw new Error(`成功するはずが不可になった（${operation.kind}、${result.reason}）`);
  }
  return result.drafts;
}

/** 申込して承認する（準備）。確定金額は、指定がなければ 22,000円 */
async function applyApproved(
  kind: ApplicationKind,
  start: string,
  end: string,
  confirmedPrice = 22_000,
): Promise<string> {
  const id = await apply(kind, start, end);
  await operateOk(
    { kind: "approve", reservationId: id, confirmedPrice: Yen.parse(confirmedPrice) },
    { now: preparedAt },
  );
  return id;
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

/** アイテムの中の数の値を、入れ子も含めてすべて集める */
function numbersIn(value: unknown): number[] {
  if (typeof value === "number") return [value];
  if (Array.isArray(value)) return value.flatMap(numbersIn);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(numbersIn);
  return [];
}

function expectNoPersonalInfo(item: PlainItem): void {
  const strings = stringsIn(item);
  for (const personal of personalValues) {
    for (const s of strings) {
      expect(s, `${String(item["pk"])} ${String(item["sk"])}`).not.toContain(personal);
    }
  }
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

/** できない操作・途中で失敗した操作で、テーブルの中身が何も変わっていないことを確かめる */
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

async function meta(id: string): Promise<PlainItem | undefined> {
  return getItem(`RES#${id}`, "META");
}

async function dayItem(day: string): Promise<PlainItem | undefined> {
  return getItem(`DAY#${day}`, "META");
}

async function dayVersion(day: string): Promise<unknown> {
  return (await dayItem(day))?.["version"];
}

async function draftItems(): Promise<PlainItem[]> {
  return (await scanAll()).filter((item) => String(item["sk"]).startsWith("DRAFT#"));
}

async function unsentDraftKeys(): Promise<string[]> {
  const res = await client.send(
    new QueryCommand({
      TableName: store.tableName,
      IndexName: "gsi1",
      KeyConditionExpression: "gsi1pk = :pk",
      ExpressionAttributeValues: { ":pk": { S: "DRAFT#UNSENT" } },
    }),
  );
  return (res.Items ?? []).map((item) => itemKey(plainItem(item))).sort();
}

/** 日ごとのアイテムの占有区間の1件を、比べやすい形にする（開始・終わりは UTC で保存されていることも確かめる） */
interface NormalizedInterval {
  kind: unknown;
  id: unknown;
  status: unknown;
  provisionalIds: unknown;
  start: number;
  end: number;
}

function normalizeStored(entry: unknown): NormalizedInterval {
  const map = entry as Record<string, unknown>;
  const start = DateTime.fromISO(String(map["start"]), { setZone: true });
  const end = DateTime.fromISO(String(map["end"]), { setZone: true });
  expect(start.isValid && end.isValid).toBe(true);
  expect(start.offset).toBe(0);
  expect(end.offset).toBe(0);
  return {
    kind: map["kind"],
    id: map["id"],
    status: map["status"],
    provisionalIds: map["provisionalIds"],
    start: start.toMillis(),
    end: end.toMillis(),
  };
}

async function storedIntervals(day: string): Promise<NormalizedInterval[]> {
  const item = await dayItem(day);
  if (item === undefined) return [];
  return (item["intervals"] as unknown[]).map(normalizeStored).sort(byStart);
}

function interval(fields: {
  id: string;
  status: string;
  provisionalIds?: string[];
  start: string;
  end: string;
}): NormalizedInterval {
  return {
    kind: "reservation",
    id: fields.id,
    status: fields.status,
    provisionalIds: fields.provisionalIds,
    start: jst(fields.start).toMillis(),
    end: jst(fields.end).toMillis(),
  };
}

function byStart(a: NormalizedInterval, b: NormalizedInterval): number {
  return a.start - b.start || String(a.id).localeCompare(String(b.id));
}

/**
 * 付く仮予約の id がない第二キープの占有区間。資料は「第二キープなら、付く仮予約の id のリスト」としか書いていないので、
 * 空のリストか、属性がないかは問わない
 */
function withoutProvisionalIds(
  entry: NormalizedInterval | undefined,
): NormalizedInterval | undefined {
  if (entry === undefined) return undefined;
  expect(entry.provisionalIds ?? []).toEqual([]);
  return { ...entry, provisionalIds: undefined };
}

/** ほかの書き込みがあったことにする：版番号を1増やす（アイテムがなければ版番号1で作る） */
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

/** 2つの書き込みがどちらも「読んで判定した」ところで待ち合わせ、それから書かせる（必ず衝突させる） */
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

// ---- 下書き・履歴を確かめる道具 ----

/** 下書きの並び順は決めていないので、件数と中身で比べる */
function expectDrafts(saved: readonly SavedDraft[], expected: readonly OperationDraft[]): void {
  const drafts = saved.map((s) => s.draft);
  expect(drafts).toHaveLength(expected.length);
  expect(drafts).toEqual(expect.arrayContaining([...expected]));
}

/**
 * 戻り値の下書きが、操作と同じ書き込みでテーブルに入っていることを確かめる：
 * pk は RES#<あて先の予約の id>、sk は DRAFT#<作った日時（UTC）>#<連番>、状態は未送信、
 * GSI は gsi1pk = DRAFT#UNSENT・gsi1sk = 作った日時。返した値を返す（中の値を確かめるため）
 */
async function expectDraftsStored(
  saved: readonly SavedDraft[],
  createdAt: DateTime,
): Promise<PlainItem[]> {
  const items: PlainItem[] = [];
  for (const s of saved) {
    expect(s.status).toBe("unsent");
    const match = /^DRAFT#([^#]+)#\d+$/.exec(s.sk);
    expect(match, s.sk).not.toBeNull();
    expectUtcInstant(match?.[1], createdAt);
    const item = await getItem(`RES#${s.draft.reservationId}`, s.sk);
    expect(item, `RES#${s.draft.reservationId} ${s.sk}`).toBeDefined();
    if (item === undefined) continue;
    expect(item["gsi1pk"]).toBe("DRAFT#UNSENT");
    expectUtcInstant(item["gsi1sk"], createdAt);
    items.push(item);
  }
  return items;
}

async function lastHistory(id: string) {
  const detail = await getReservation(store, id);
  expect(detail).not.toBeNull();
  const entry = detail?.history.at(-1);
  expect(entry).toBeDefined();
  return entry;
}

async function historyCount(id: string): Promise<number> {
  return (await getReservation(store, id))?.history.length ?? 0;
}

// ---- テスト ----

describe("承認・却下の保存", () => {
  it("承認待ち（本）A 10/20 10:00–12:00 を確定金額 11,000円で承認：META は本予約・確定金額 11,000円・更新日時は操作の時刻、DAY#2026-10-20 の状態は本予約で版番号が1増える、履歴（管理者・承認・前後）、承認の下書き（11,000円、未送信）が書かれる", async () => {
    const a = await apply("firm", "2026-10-20T10:00", "2026-10-20T12:00");
    expect(await dayVersion("2026-10-20")).toBe(1);

    const drafts = await operateOk({
      kind: "approve",
      reservationId: a,
      confirmedPrice: Yen.parse(11_000),
    });

    const detail = await getReservation(store, a);
    expect(detail?.status).toBe("firm");
    expect(detail?.confirmedPrice).toBe(11_000);
    // 承認は申込どおり（予約区間・バッファは変えない）
    expect(detail?.start.toMillis()).toBe(jst("2026-10-20T10:00").toMillis());
    expect(detail?.end.toMillis()).toBe(jst("2026-10-20T12:00").toMillis());
    expect(detail?.bufferMinutes).toBe(60);
    expect(detail?.createdAt.toMillis()).toBe(appliedAt.toMillis());
    expect(detail?.updatedAt.toMillis()).toBe(operatedAt.toMillis());
    const metaItem = await meta(a);
    expect(metaItem?.["gsi1pk"]).toBe("STATUS#firm");
    expectUtcInstant(metaItem?.["gsi1sk"], jst("2026-10-20T10:00"));

    expect(await dayVersion("2026-10-20")).toBe(2);
    expect(await storedIntervals("2026-10-20")).toEqual([
      interval({ id: a, status: "firm", start: "2026-10-20T10:00", end: "2026-10-20T13:00" }),
    ]);

    expect(detail?.history).toHaveLength(2);
    const entry = detail?.history.at(-1);
    expect(entry?.at.toMillis()).toBe(operatedAt.toMillis());
    expect(entry?.actor).toEqual({ kind: "admin", userId: adminUserId });
    expect(entry?.operation).toBe("approve");
    expect(entry?.before?.status).toBe("pending-firm");
    expect(entry?.before?.confirmedPrice).toBeUndefined();
    expect(entry?.after?.status).toBe("firm");
    expect(entry?.after?.confirmedPrice).toBe(11_000);

    expectDrafts(drafts, [
      { kind: "approval", reservationId: a, confirmedPrice: Yen.parse(11_000) },
    ]);
    const [draftItem] = await expectDraftsStored(drafts, operatedAt);
    expect(numbersIn(draftItem)).toContain(11_000);
    expect(await draftItems()).toHaveLength(1);
    expect(await unsentDraftKeys()).toEqual([`RES#${a} ${drafts[0]?.sk ?? ""}`]);
  });

  it("承認待ち（本）A を確定金額 10,000円に調整して承認：確定金額は 10,000円。承認の下書きにも 10,000円が入る", async () => {
    const a = await apply("firm", "2026-10-20T10:00", "2026-10-20T12:00");

    const drafts = await operateOk({
      kind: "approve",
      reservationId: a,
      confirmedPrice: Yen.parse(10_000),
    });

    expect((await getReservation(store, a))?.confirmedPrice).toBe(10_000);
    expectDrafts(drafts, [
      { kind: "approval", reservationId: a, confirmedPrice: Yen.parse(10_000) },
    ]);
    const [draftItem] = await expectDraftsStored(drafts, operatedAt);
    expect(numbersIn(draftItem)).toContain(10_000);
  });

  it("承認待ち（仮）P を承認：仮予約。DAY#2026-10-20 の状態も仮予約、META の GSI は STATUS#provisional", async () => {
    const p = await apply("provisional", "2026-10-20T10:00", "2026-10-20T12:00");

    await operateOk({ kind: "approve", reservationId: p, confirmedPrice: Yen.parse(11_000) });

    expect((await getReservation(store, p))?.status).toBe("provisional");
    expect((await meta(p))?.["gsi1pk"]).toBe("STATUS#provisional");
    expect(await storedIntervals("2026-10-20")).toEqual([
      interval({
        id: p,
        status: "provisional",
        start: "2026-10-20T10:00",
        end: "2026-10-20T13:00",
      }),
    ]);
  });

  it("仮予約 P 13:00–15:00 に付く承認待ち（第二キープ）K 14:00–17:00 を承認：第二キープ。P に付いたまま（META・DAY#2026-10-20）。P は変わらない", async () => {
    const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    const k = await apply("second-hold", "2026-10-20T14:00", "2026-10-20T17:00");
    const pBefore = await meta(p);

    const drafts = await operateOk({
      kind: "approve",
      reservationId: k,
      confirmedPrice: Yen.parse(11_000),
    });

    const detail = await getReservation(store, k);
    expect(detail?.status).toBe("second-hold");
    expect(detail?.provisionalIds).toEqual([p]);
    expect(await meta(p)).toEqual(pBefore);
    expect(await storedIntervals("2026-10-20")).toEqual([
      interval({
        id: p,
        status: "provisional",
        start: "2026-10-20T13:00",
        end: "2026-10-20T16:00",
      }),
      interval({
        id: k,
        status: "second-hold",
        provisionalIds: [p],
        start: "2026-10-20T14:00",
        end: "2026-10-20T18:00",
      }),
    ]);
    expectDrafts(drafts, [
      { kind: "approval", reservationId: k, confirmedPrice: Yen.parse(11_000) },
    ]);
  });

  it("承認待ち（本）A 10/20 10:00–12:00 を却下：取消。DAY#2026-10-20 から A の占有区間がなくなり版番号が1増える、META の GSI の属性が消える、履歴（管理者・却下）、却下の下書きが書かれる", async () => {
    const a = await apply("firm", "2026-10-20T10:00", "2026-10-20T12:00");

    const drafts = await operateOk({ kind: "reject", reservationId: a });

    const detail = await getReservation(store, a);
    expect(detail?.status).toBe("cancelled");
    expect(detail?.updatedAt.toMillis()).toBe(operatedAt.toMillis());
    const metaItem = await meta(a);
    expect(metaItem?.["gsi1pk"]).toBeUndefined();
    expect(metaItem?.["gsi1sk"]).toBeUndefined();

    expect(await dayVersion("2026-10-20")).toBe(2);
    expect(await storedIntervals("2026-10-20")).toEqual([]);

    const entry = detail?.history.at(-1);
    expect(entry?.at.toMillis()).toBe(operatedAt.toMillis());
    expect(entry?.actor).toEqual({ kind: "admin", userId: adminUserId });
    expect(entry?.operation).toBe("reject");
    expect(entry?.before?.status).toBe("pending-firm");
    expect(entry?.after?.status).toBe("cancelled");

    expectDrafts(drafts, [{ kind: "rejection", reservationId: a }]);
    await expectDraftsStored(drafts, operatedAt);
  });

  it("本予約を承認しようとする：不可（not-pending）。何も書かれない", async () => {
    const a = await applyApproved("firm", "2026-10-20T10:00", "2026-10-20T12:00");
    const before = await scanAll();

    expect(
      await operate({ kind: "approve", reservationId: a, confirmedPrice: Yen.parse(11_000) }),
    ).toEqual({ ok: false, reason: "not-pending" });
    await expectNothingWritten(before);
  });

  it("本予約を却下しようとする：不可（not-pending）。何も書かれない", async () => {
    const a = await applyApproved("firm", "2026-10-20T10:00", "2026-10-20T12:00");
    const before = await scanAll();

    expect(await operate({ kind: "reject", reservationId: a })).toEqual({
      ok: false,
      reason: "not-pending",
    });
    await expectNothingWritten(before);
  });

  it("ない id の予約を承認しようとする：不可（not-found）。何も書かれない", async () => {
    await apply("firm", "2026-10-20T10:00", "2026-10-20T12:00");
    const before = await scanAll();

    expect(
      await operate({
        kind: "approve",
        reservationId: "no-such-reservation",
        confirmedPrice: Yen.parse(11_000),
      }),
    ).toEqual({ ok: false, reason: "not-found" });
    await expectNothingWritten(before);
  });
});

describe("昇格の保存", () => {
  it("仮予約 P 13:00–15:00 に第二キープ K1 14:00–17:00 と承認待ちの第二キープ K2 10:30–12:30 が付いているときに P を昇格：P は本予約、K1・K2 は終了で DAY#2026-10-20 から消える（P だけが残る）。履歴は P が管理者の昇格、K1・K2 がシステムの終了。下書きは P の昇格と K1・K2 の終了", async () => {
    const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    const k1 = await applyApproved("second-hold", "2026-10-20T14:00", "2026-10-20T17:00");
    const k2 = await apply("second-hold", "2026-10-20T10:30", "2026-10-20T12:30");
    const version = (await dayVersion("2026-10-20")) as number;

    const drafts = await operateOk({ kind: "promote", reservationId: p });

    const pDetail = await getReservation(store, p);
    expect(pDetail?.status).toBe("firm");
    expect(pDetail?.confirmedPrice).toBe(22_000);
    expect(pDetail?.updatedAt.toMillis()).toBe(operatedAt.toMillis());
    expect((await meta(p))?.["gsi1pk"]).toBe("STATUS#firm");
    for (const k of [k1, k2]) {
      const detail = await getReservation(store, k);
      expect(detail?.status).toBe("ended");
      expect(detail?.updatedAt.toMillis()).toBe(operatedAt.toMillis());
      expect((await meta(k))?.["gsi1pk"]).toBeUndefined();
      const entry = detail?.history.at(-1);
      expect(entry?.at.toMillis()).toBe(operatedAt.toMillis());
      expect(entry?.actor).toEqual({ kind: "system" });
      expect(entry?.operation).toBe("end");
      expect(entry?.after?.status).toBe("ended");
    }
    expect((await getReservation(store, k2))?.history.at(-1)?.before?.status).toBe(
      "pending-second-hold",
    );
    expect((await getReservation(store, k1))?.history.at(-1)?.before?.status).toBe("second-hold");

    const pEntry = pDetail?.history.at(-1);
    expect(pEntry?.actor).toEqual({ kind: "admin", userId: adminUserId });
    expect(pEntry?.operation).toBe("promote");
    expect(pEntry?.before?.status).toBe("provisional");
    expect(pEntry?.after?.status).toBe("firm");

    expect(await dayVersion("2026-10-20")).toBe(version + 1);
    expect(await storedIntervals("2026-10-20")).toEqual([
      interval({ id: p, status: "firm", start: "2026-10-20T13:00", end: "2026-10-20T16:00" }),
    ]);

    expectDrafts(drafts, [
      { kind: "promotion", reservationId: p },
      { kind: "second-hold-ended", reservationId: k1 },
      { kind: "second-hold-ended", reservationId: k2 },
    ]);
    await expectDraftsStored(drafts, operatedAt);
  });

  it("本予約を昇格しようとする：不可（invalid-status）。何も書かれない", async () => {
    const a = await applyApproved("firm", "2026-10-20T10:00", "2026-10-20T12:00");
    const before = await scanAll();

    expect(await operate({ kind: "promote", reservationId: a })).toEqual({
      ok: false,
      reason: "invalid-status",
    });
    await expectNothingWritten(before);
  });
});

describe("取消の保存", () => {
  // booking.md「取消とキャンセル料」の例：利用日が 10/20 の本予約、金額 27,500円。10/17 00:00 の取消は 22,000円（80%）
  const cancelledAt = jst("2026-10-17T00:00");

  it("本予約 A 10/20 10:00–12:00（確定金額 27,500円）を 10/17 00:00 に取消：取消。DAY#2026-10-20 から A の占有区間がなくなる。キャンセル料 22,000円（80%）が確定金額から計算されて取消の下書きに入る。履歴の日時は取消を操作した時刻", async () => {
    const a = await applyApproved("firm", "2026-10-20T10:00", "2026-10-20T12:00", 27_500);
    const version = (await dayVersion("2026-10-20")) as number;

    const drafts = await operateOk({ kind: "cancel", reservationId: a }, { now: cancelledAt });

    const detail = await getReservation(store, a);
    expect(detail?.status).toBe("cancelled");
    expect(detail?.confirmedPrice).toBe(27_500);
    expect(detail?.updatedAt.toMillis()).toBe(cancelledAt.toMillis());
    expect((await meta(a))?.["gsi1pk"]).toBeUndefined();
    expect(await dayVersion("2026-10-20")).toBe(version + 1);
    expect(await storedIntervals("2026-10-20")).toEqual([]);

    const entry = detail?.history.at(-1);
    expect(entry?.at.toMillis()).toBe(cancelledAt.toMillis());
    expect(entry?.actor).toEqual({ kind: "admin", userId: adminUserId });
    expect(entry?.operation).toBe("cancel");
    expect(entry?.before?.status).toBe("firm");
    expect(entry?.after?.status).toBe("cancelled");

    expectDrafts(drafts, [
      {
        kind: "cancellation",
        reservationId: a,
        cancellationFee: { ratePercent: 80, fee: Yen.parse(22_000) },
      },
    ]);
    const [draftItem] = await expectDraftsStored(drafts, cancelledAt);
    expect(numbersIn(draftItem)).toContain(22_000);
  });

  it("同じ取消の時刻を UTC で表して（10/16 15:00Z）渡す：キャンセル料は 22,000円（80%）のまま（JST の日で数える）。下書きと履歴の日時は UTC", async () => {
    const a = await applyApproved("firm", "2026-10-20T10:00", "2026-10-20T12:00", 27_500);

    const drafts = await operateOk(
      { kind: "cancel", reservationId: a },
      { now: cancelledAt.toUTC() },
    );

    expectDrafts(drafts, [
      {
        kind: "cancellation",
        reservationId: a,
        cancellationFee: { ratePercent: 80, fee: Yen.parse(22_000) },
      },
    ]);
    await expectDraftsStored(drafts, cancelledAt);
    expect((await lastHistory(a))?.at.toMillis()).toBe(cancelledAt.toMillis());
    const hist = (await scanAll()).filter(
      (item) => item["pk"] === `RES#${a}` && String(item["sk"]).startsWith("HIST#"),
    );
    for (const item of hist) {
      const match = /^HIST#([^#]+)#\d+$/.exec(String(item["sk"]));
      expect(match).not.toBeNull();
      expect(DateTime.fromISO(match?.[1] ?? "", { setZone: true }).offset).toBe(0);
    }
  });

  it("仮予約 P 13:00–15:00 に第二キープ K 14:00–17:00 が付いているときに P を取消：P は取消で DAY#2026-10-20 から消え、K は第二キープのまま P の id を持つ。下書きは P の取消（キャンセル料なし）と、K への繰り上げ案内（残っている仮予約なし）", async () => {
    const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    const k = await applyApproved("second-hold", "2026-10-20T14:00", "2026-10-20T17:00");
    const kBefore = await meta(k);

    const drafts = await operateOk({ kind: "cancel", reservationId: p });

    expect((await getReservation(store, p))?.status).toBe("cancelled");
    expect(await meta(k)).toEqual(kBefore);
    expect(await storedIntervals("2026-10-20")).toEqual([
      interval({
        id: k,
        status: "second-hold",
        provisionalIds: [p],
        start: "2026-10-20T14:00",
        end: "2026-10-20T18:00",
      }),
    ]);
    expectDrafts(drafts, [
      {
        kind: "cancellation",
        reservationId: p,
        cancellationFee: { ratePercent: 0, fee: Yen.parse(0) },
      },
      { kind: "move-up-notice", reservationId: k, remainingProvisionalIds: [] },
    ]);
    await expectDraftsStored(drafts, operatedAt);
  });

  it("2件の仮予約 P1 10:00–12:00・P2 15:00–17:00 に付く第二キープ K 12:00–16:00 があるときに P1 を取消：K への繰り上げ案内に、残っている仮予約 P2 の id が入る", async () => {
    const p1 = await applyApproved("provisional", "2026-10-20T10:00", "2026-10-20T12:00");
    const p2 = await applyApproved("provisional", "2026-10-20T15:00", "2026-10-20T17:00");
    const k = await applyApproved("second-hold", "2026-10-20T12:00", "2026-10-20T16:00");

    const drafts = await operateOk({ kind: "cancel", reservationId: p1 });

    expectDrafts(drafts, [
      {
        kind: "cancellation",
        reservationId: p1,
        cancellationFee: { ratePercent: 0, fee: Yen.parse(0) },
      },
      { kind: "move-up-notice", reservationId: k, remainingProvisionalIds: [p2] },
    ]);
    const items = await expectDraftsStored(drafts, operatedAt);
    const notice = items.find((item) => item["pk"] === `RES#${k}`);
    expect(stringsIn(notice)).toContain(p2);
  });

  it("第二キープ K 14:00–17:00（占有区間 14:00–18:00）の後ろに本予約 B 18:00–20:00 があるときに K を取消：K の占有区間が消える。下書きは K の取消（キャンセル料なし）と B への前倒しの案内", async () => {
    const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    const k = await applyApproved("second-hold", "2026-10-20T14:00", "2026-10-20T17:00");
    const b = await applyApproved("firm", "2026-10-20T18:00", "2026-10-20T20:00");

    const drafts = await operateOk({ kind: "cancel", reservationId: k });

    expect((await getReservation(store, k))?.status).toBe("cancelled");
    expect((await storedIntervals("2026-10-20")).map((i) => i.id)).toEqual([p, b]);
    expectDrafts(drafts, [
      {
        kind: "cancellation",
        reservationId: k,
        cancellationFee: { ratePercent: 0, fee: Yen.parse(0) },
      },
      { kind: "bring-forward-notice", reservationId: b },
    ]);
    await expectDraftsStored(drafts, operatedAt);
  });

  it("取消済みの予約を取消しようとする：不可（invalid-status）。何も書かれない", async () => {
    const a = await applyApproved("firm", "2026-10-20T10:00", "2026-10-20T12:00");
    await operateOk({ kind: "cancel", reservationId: a }, { now: preparedAt });
    const before = await scanAll();

    expect(await operate({ kind: "cancel", reservationId: a })).toEqual({
      ok: false,
      reason: "invalid-status",
    });
    await expectNothingWritten(before);
  });
});

describe("繰り上げの保存", () => {
  it("仮予約 P が取消になったあと第二キープ K 14:00–17:00 を繰り上げ：K は仮予約になり、付く仮予約の id がなくなる（META・DAY#2026-10-20）。占有区間は同じで版番号が1増える。履歴（管理者・繰り上げ・前後）。下書きは作らない", async () => {
    const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    const k = await applyApproved("second-hold", "2026-10-20T14:00", "2026-10-20T17:00");
    await operateOk({ kind: "cancel", reservationId: p }, { now: preparedAt });
    const version = (await dayVersion("2026-10-20")) as number;
    const draftsBefore = (await draftItems()).length;

    const drafts = await operateOk({ kind: "move-up", reservationId: k });

    const detail = await getReservation(store, k);
    expect(detail?.status).toBe("provisional");
    expect(detail?.provisionalIds ?? []).toEqual([]);
    expect(detail?.start.toMillis()).toBe(jst("2026-10-20T14:00").toMillis());
    expect(detail?.end.toMillis()).toBe(jst("2026-10-20T17:00").toMillis());
    expect(detail?.updatedAt.toMillis()).toBe(operatedAt.toMillis());
    expect((await meta(k))?.["gsi1pk"]).toBe("STATUS#provisional");

    expect(await dayVersion("2026-10-20")).toBe(version + 1);
    expect(await storedIntervals("2026-10-20")).toEqual([
      interval({
        id: k,
        status: "provisional",
        start: "2026-10-20T14:00",
        end: "2026-10-20T18:00",
      }),
    ]);

    const entry = detail?.history.at(-1);
    expect(entry?.at.toMillis()).toBe(operatedAt.toMillis());
    expect(entry?.actor).toEqual({ kind: "admin", userId: adminUserId });
    expect(entry?.operation).toBe("move-up");
    expect(entry?.before?.status).toBe("second-hold");
    expect(entry?.before?.provisionalIds).toEqual([p]);
    expect(entry?.after?.status).toBe("provisional");
    expect(entry?.after?.provisionalIds ?? []).toEqual([]);

    expect(drafts).toEqual([]);
    expect(await draftItems()).toHaveLength(draftsBefore);
  });

  it("2件の仮予約 P1・P2 に付く第二キープ K があり、P1 だけが取消になったときに K を繰り上げ：不可（still-held）。何も書かれない", async () => {
    const p1 = await applyApproved("provisional", "2026-10-20T10:00", "2026-10-20T12:00");
    await applyApproved("provisional", "2026-10-20T15:00", "2026-10-20T17:00");
    const k = await applyApproved("second-hold", "2026-10-20T12:00", "2026-10-20T16:00");
    await operateOk({ kind: "cancel", reservationId: p1 }, { now: preparedAt });
    const before = await scanAll();

    expect(await operate({ kind: "move-up", reservationId: k })).toEqual({
      ok: false,
      reason: "still-held",
    });
    await expectNothingWritten(before);
  });
});

describe("変更の保存", () => {
  function changeOf(
    reservationId: string,
    start: string,
    end: string,
    confirmedPrice: number,
  ): ReservationOperationInput {
    return {
      kind: "change",
      reservationId,
      start: jst(start),
      end: jst(end),
      content: sameContent,
      confirmedPrice: Yen.parse(confirmedPrice),
      priceTable,
    };
  }

  it("本予約 A 10/20 10:00–12:00 を 10/27 10:00–12:00 に移動：DAY#2026-10-20 から A が消え（版番号が1増える）、DAY#2026-10-27 に入る（版番号1）。META の予約区間・確定金額・GSI の開始日時、履歴の前後、変更の下書きが書かれる", async () => {
    const a = await applyApproved("firm", "2026-10-20T10:00", "2026-10-20T12:00", 11_000);
    const version = (await dayVersion("2026-10-20")) as number;

    const drafts = await operateOk(changeOf(a, "2026-10-27T10:00", "2026-10-27T12:00", 11_000));

    const detail = await getReservation(store, a);
    expect(detail?.status).toBe("firm");
    expect(detail?.start.toMillis()).toBe(jst("2026-10-27T10:00").toMillis());
    expect(detail?.end.toMillis()).toBe(jst("2026-10-27T12:00").toMillis());
    expect(detail?.confirmedPrice).toBe(11_000);
    expect(detail?.updatedAt.toMillis()).toBe(operatedAt.toMillis());
    const metaItem = await meta(a);
    expect(metaItem?.["gsi1pk"]).toBe("STATUS#firm");
    expectUtcInstant(metaItem?.["gsi1sk"], jst("2026-10-27T10:00"));

    expect(await dayVersion("2026-10-20")).toBe(version + 1);
    expect(await storedIntervals("2026-10-20")).toEqual([]);
    expect(await dayVersion("2026-10-27")).toBe(1);
    expect(await storedIntervals("2026-10-27")).toEqual([
      interval({ id: a, status: "firm", start: "2026-10-27T10:00", end: "2026-10-27T13:00" }),
    ]);

    const entry = detail?.history.at(-1);
    expect(entry?.at.toMillis()).toBe(operatedAt.toMillis());
    expect(entry?.actor).toEqual({ kind: "admin", userId: adminUserId });
    expect(entry?.operation).toBe("change");
    expect(entry?.before?.start.toMillis()).toBe(jst("2026-10-20T10:00").toMillis());
    expect(entry?.before?.end.toMillis()).toBe(jst("2026-10-20T12:00").toMillis());
    expect(entry?.after?.start.toMillis()).toBe(jst("2026-10-27T10:00").toMillis());
    expect(entry?.after?.end.toMillis()).toBe(jst("2026-10-27T12:00").toMillis());
    expect(entry?.before?.status).toBe("firm");
    expect(entry?.after?.status).toBe("firm");

    expectDrafts(drafts, [{ kind: "change", reservationId: a }]);
    await expectDraftsStored(drafts, operatedAt);
  });

  it("本予約 A 10/20 10:00–12:00 を 10:00–13:00 に延長し、確定金額を 16,500円にする：DAY#2026-10-20 の占有区間は 10:00–14:00 で版番号が1増える。履歴の前後に確定金額 11,000円 → 16,500円", async () => {
    const a = await applyApproved("firm", "2026-10-20T10:00", "2026-10-20T12:00", 11_000);
    const version = (await dayVersion("2026-10-20")) as number;

    await operateOk(changeOf(a, "2026-10-20T10:00", "2026-10-20T13:00", 16_500));

    expect((await getReservation(store, a))?.confirmedPrice).toBe(16_500);
    expect(await dayVersion("2026-10-20")).toBe(version + 1);
    expect(await storedIntervals("2026-10-20")).toEqual([
      interval({ id: a, status: "firm", start: "2026-10-20T10:00", end: "2026-10-20T14:00" }),
    ]);
    const entry = await lastHistory(a);
    expect(entry?.before?.confirmedPrice).toBe(11_000);
    expect(entry?.after?.confirmedPrice).toBe(16_500);
  });

  it("本予約 B 14:00–16:00 があるときに、A 10:00–12:00 を 10:00–13:30 に延長：不可（overlaps-existing。占有区間 10:00–14:30 が B と重なる）。何も書かれない", async () => {
    const a = await applyApproved("firm", "2026-10-20T10:00", "2026-10-20T12:00", 11_000);
    await applyApproved("firm", "2026-10-20T14:00", "2026-10-20T16:00");
    const before = await scanAll();

    expect(await operate(changeOf(a, "2026-10-20T10:00", "2026-10-20T13:30", 19_250))).toEqual({
      ok: false,
      reason: "overlaps-existing",
    });
    await expectNothingWritten(before);
  });

  it("仮予約 P 13:00–15:00 に第二キープ K 14:00–17:00 が付いているときに、P を翌日 13:00–15:00 に移動：K は P に付かなくなる（META・DAY#2026-10-20）が、K の占有区間は残る。P は DAY#2026-10-21 に入る。下書きは P の変更と K への繰り上げ案内", async () => {
    const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    const k = await applyApproved("second-hold", "2026-10-20T14:00", "2026-10-20T17:00");

    const drafts = await operateOk(changeOf(p, "2026-10-21T13:00", "2026-10-21T15:00", 22_000));

    expect((await getReservation(store, p))?.status).toBe("provisional");
    const kDetail = await getReservation(store, k);
    expect(kDetail?.status).toBe("second-hold");
    expect(kDetail?.provisionalIds ?? []).toEqual([]);

    const day20 = await storedIntervals("2026-10-20");
    expect(day20.map((i) => i.id)).toEqual([k]);
    expect(withoutProvisionalIds(day20[0])).toEqual(
      interval({
        id: k,
        status: "second-hold",
        start: "2026-10-20T14:00",
        end: "2026-10-20T18:00",
      }),
    );
    expect(await storedIntervals("2026-10-21")).toEqual([
      interval({
        id: p,
        status: "provisional",
        start: "2026-10-21T13:00",
        end: "2026-10-21T16:00",
      }),
    ]);

    expectDrafts(drafts, [
      { kind: "change", reservationId: p },
      { kind: "move-up-notice", reservationId: k, remainingProvisionalIds: [] },
    ]);
    await expectDraftsStored(drafts, operatedAt);
  });

  it("仮予約 P 13:00–15:00 に第二キープ K 14:00–17:00 が付いているときに、P を 13:30–15:30 に移動：可。K は P に付いたまま、K の META は変わらない。下書きは P の変更だけ", async () => {
    const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    const k = await applyApproved("second-hold", "2026-10-20T14:00", "2026-10-20T17:00");
    const kBefore = await meta(k);

    const drafts = await operateOk(changeOf(p, "2026-10-20T13:30", "2026-10-20T15:30", 22_000));

    expect(await meta(k)).toEqual(kBefore);
    expect(await storedIntervals("2026-10-20")).toEqual([
      interval({
        id: p,
        status: "provisional",
        start: "2026-10-20T13:30",
        end: "2026-10-20T16:30",
      }),
      interval({
        id: k,
        status: "second-hold",
        provisionalIds: [p],
        start: "2026-10-20T14:00",
        end: "2026-10-20T18:00",
      }),
    ]);
    expectDrafts(drafts, [{ kind: "change", reservationId: p }]);
  });

  it("第二キープ K を変更しようとする：不可（not-changeable。booking.md の未決事項のとおり、決まるまでは変更できない）。何も書かれない", async () => {
    await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    const k = await applyApproved("second-hold", "2026-10-20T14:00", "2026-10-20T17:00");
    const before = await scanAll();

    expect(await operate(changeOf(k, "2026-10-20T14:30", "2026-10-20T17:30", 22_000))).toEqual({
      ok: false,
      reason: "not-changeable",
    });
    await expectNothingWritten(before);
  });

  it("本予約 A 10/20 10:00–12:00 を、UTC で表した日時（10/20 13:00–17:00Z。JST では 10/20 22:00–10/21 02:00）に移動：DAY#2026-10-20 と DAY#2026-10-21 の両方に、同じ占有区間 22:00–03:00 を切らずに入れる", async () => {
    const a = await applyApproved("firm", "2026-10-20T10:00", "2026-10-20T12:00", 11_000);

    await operateOk(
      {
        kind: "change",
        reservationId: a,
        start: jst("2026-10-20T22:00").toUTC(),
        end: jst("2026-10-21T02:00").toUTC(),
        content: sameContent,
        confirmedPrice: Yen.parse(27_500),
        priceTable,
      },
      { now: operatedAt.toUTC() },
    );

    const expected = interval({
      id: a,
      status: "firm",
      start: "2026-10-20T22:00",
      end: "2026-10-21T03:00",
    });
    expect(await storedIntervals("2026-10-20")).toEqual([expected]);
    expect(await storedIntervals("2026-10-21")).toEqual([expected]);
    expect(await dayItem("2026-10-19")).toBeUndefined();
    expect((await getReservation(store, a))?.updatedAt.toMillis()).toBe(operatedAt.toMillis());
  });

  // reservation-model.md「金額」：変更では、人数・ホリゾントの養生・プラン・機材保険・オプションと確定金額を予約の値に書き換え、
  // 申込のときの見積は残し、計算し直した見積はその変更の履歴に残す。
  // 申込は 4人・養生なし（プランA）・機材保険なし・オプションなし、見積は税抜 10,000円・税込 11,000円（application）。
  // 変更後の中身は 12人・養生なし（11人以上で養生なしなのでプランB）・機材保険あり・オプション glitter。
  // 計算し直した見積（booking.md「料金」）：10:00–13:00 は通常帯なので 2,750 × 6 + 1,000 + 2,000 = 19,500（税抜）、税込 21,450
  const changedContent: ReservationChangeContent = {
    partySize: 12,
    cycloramaFloorProtection: false,
    equipmentInsurance: true,
    optionIds: ["glitter"],
  };
  const recalculatedEstimate = {
    subtotalExcludingTax: Yen.parse(19_500),
    estimateIncludingTax: Yen.parse(21_450),
  };

  async function changeContentOfA(): Promise<string> {
    const a = await applyApproved("firm", "2026-10-20T10:00", "2026-10-20T12:00", 11_000);
    await operateOk({
      kind: "change",
      reservationId: a,
      start: jst("2026-10-20T10:00"),
      end: jst("2026-10-20T13:00"),
      content: changedContent,
      confirmedPrice: Yen.parse(21_450),
      priceTable,
    });
    return a;
  }

  it("本予約 A 10/20 10:00–12:00（4人・養生なし・プランA・機材保険なし・オプションなし、確定金額 11,000円）を、10:00–13:00・12人・養生なし・機材保険あり・オプション glitter・確定金額 21,450円に変更：予約の人数・養生・プラン（B）・機材保険・オプション・確定金額は新しい値になり、申込のときの見積（税抜 10,000円・税込 11,000円）は変わらない", async () => {
    const a = await changeContentOfA();

    const detail = await getReservation(store, a);
    expect(detail?.partySize).toBe(12);
    expect(detail?.cycloramaFloorProtection).toBe(false);
    expect(detail?.planId).toBe("B");
    expect(detail?.equipmentInsurance).toBe(true);
    expect(detail?.optionIds).toEqual(["glitter"]);
    expect(detail?.confirmedPrice).toBe(21_450);
    expect(detail?.estimate).toEqual({
      subtotalExcludingTax: Yen.parse(10_000),
      estimateIncludingTax: Yen.parse(11_000),
    });
  });

  it("同じ変更の履歴：計算し直した見積（税抜 19,500円・税込 21,450円）と、中身の前後（4人・養生なし・プランA・機材保険なし・オプションなし・確定金額 11,000円 → 12人・養生なし・プランB・機材保険あり・オプション glitter・確定金額 21,450円）が残る", async () => {
    const a = await changeContentOfA();

    const entry = await lastHistory(a);
    expect(entry?.operation).toBe("change");
    expect(entry).toMatchObject({
      estimate: recalculatedEstimate,
      before: {
        partySize: 4,
        cycloramaFloorProtection: false,
        planId: "A",
        equipmentInsurance: false,
        optionIds: [],
        confirmedPrice: 11_000,
      },
      after: {
        partySize: 12,
        cycloramaFloorProtection: false,
        planId: "B",
        equipmentInsurance: true,
        optionIds: ["glitter"],
        confirmedPrice: 21_450,
      },
    });
  });
});

describe("日をまたぐ予約と、JST の 0:00 で終わる占有区間", () => {
  // 第二キープ K 10/20 20:00–23:00 の占有区間は 20:00–10/21 00:00（JST の 0:00 で終わる）。
  // K の後ろの本予約 B 10/21 00:00–04:00 は K の占有区間の終わりに接して始まり、DAY#2026-10-21 にしかない
  async function prepare(): Promise<{ p: string; k: string; b: string }> {
    const p = await applyApproved("provisional", "2026-10-20T19:00", "2026-10-20T21:00");
    const k = await applyApproved("second-hold", "2026-10-20T20:00", "2026-10-20T23:00");
    const b = await applyApproved("firm", "2026-10-21T00:00", "2026-10-21T04:00");
    expect((await storedIntervals("2026-10-20")).map((i) => i.id)).not.toContain(b);
    expect((await storedIntervals("2026-10-21")).map((i) => i.id)).toContain(b);
    return { p, k, b };
  }

  it("K 10/20 20:00–23:00（占有区間は 10/21 00:00 まで）を取消し、後ろの本予約 B 10/21 00:00–04:00 が DAY#2026-10-21 にしかないとき：B への前倒しの案内の下書きが作られる", async () => {
    const { k, b } = await prepare();

    const drafts = await operateOk({ kind: "cancel", reservationId: k });

    expect((await storedIntervals("2026-10-20")).map((i) => i.id)).not.toContain(k);
    expect((await storedIntervals("2026-10-21")).map((i) => i.id)).toEqual([b]);
    expectDrafts(drafts, [
      {
        kind: "cancellation",
        reservationId: k,
        cancellationFee: { ratePercent: 0, fee: Yen.parse(0) },
      },
      { kind: "bring-forward-notice", reservationId: b },
    ]);
    await expectDraftsStored(drafts, operatedAt);
  });

  it("同じ状況で P 10/20 19:00–21:00 を昇格し、K が終了したとき：B への前倒しの案内の下書きが作られる", async () => {
    const { p, k, b } = await prepare();

    const drafts = await operateOk({ kind: "promote", reservationId: p });

    expect((await getReservation(store, k))?.status).toBe("ended");
    expect((await storedIntervals("2026-10-20")).map((i) => i.id)).toEqual([p]);
    expectDrafts(drafts, [
      { kind: "promotion", reservationId: p },
      { kind: "second-hold-ended", reservationId: k },
      { kind: "bring-forward-notice", reservationId: b },
    ]);
    await expectDraftsStored(drafts, operatedAt);
  });
});

describe("同時の書き込み（INV-1）", () => {
  function overlapping(intervals: readonly NormalizedInterval[]): boolean {
    return intervals.some((a, i) =>
      intervals.slice(i + 1).some((b) => a.start < b.end && b.start < a.end),
    );
  }

  it("本予約 A 10/20 10:00–12:00 の取消と、同じ日の 15:00–17:00 への申込を、どちらも読んで判定してから書くように同時に送る：両方とも成功（版番号の衝突は読み直してやり直す）。DAY#2026-10-20 には申込の占有区間だけが残り、版番号は2増える", async () => {
    const a = await applyApproved("firm", "2026-10-20T10:00", "2026-10-20T12:00");
    const version = (await dayVersion("2026-10-20")) as number;
    const meet = meetBeforeFirstWrite(2);

    const [cancelled, applied] = await Promise.all([
      operate({ kind: "cancel", reservationId: a }, { maxAttempts: 3, beforeWrite: meet }),
      saveApplication(store, application("firm", "2026-10-20T15:00", "2026-10-20T17:00"), {
        now: appliedAt,
        maxAttempts: 3,
        beforeWrite: meet,
      }),
    ]);

    expect(cancelled.ok).toBe(true);
    expect(applied.ok).toBe(true);
    expect((await getReservation(store, a))?.status).toBe("cancelled");
    expect(await dayVersion("2026-10-20")).toBe(version + 2);
    expect((await storedIntervals("2026-10-20")).map((i) => i.id)).toEqual([
      applied.ok ? applied.id : "?",
    ]);
    expect(await draftItems()).toHaveLength(2); // A の承認（準備）と取消
  });

  it("本予約 A 10/20 10:00–12:00 の取消を判定したあと書く前に、A の枠 10:00–12:00 への申込が来る：申込は不可（まだ取消が書かれていない）、取消は成功。そのあとの同じ枠への申込は受付", async () => {
    const a = await applyApproved("firm", "2026-10-20T10:00", "2026-10-20T12:00");
    let during: Awaited<ReturnType<typeof saveApplication>> | undefined;
    let calls = 0;

    const cancelled = await operate(
      { kind: "cancel", reservationId: a },
      {
        maxAttempts: 3,
        beforeWrite: async (attempt) => {
          calls += 1;
          if (attempt === 1) {
            during = await saveApplication(
              store,
              application("firm", "2026-10-20T10:00", "2026-10-20T12:00"),
              { now: appliedAt },
            );
          }
        },
      },
    );

    expect(during).toEqual({ ok: false, reason: "overlaps-existing" });
    expect(cancelled.ok).toBe(true);
    expect(calls).toBe(1);
    const after = await saveApplication(
      store,
      application("firm", "2026-10-20T10:00", "2026-10-20T12:00"),
      { now: appliedAt },
    );
    expect(after.ok).toBe(true);
    expect((await storedIntervals("2026-10-20")).map((i) => i.id)).toEqual([
      after.ok ? after.id : "?",
    ]);
  });

  it("本予約 A 10/20 10:00–12:00 の 14:00–16:00 への変更と、14:00–16:00 への申込を、どちらも読んで判定してから書くように同時に送る：片方だけ成功、もう片方は読み直して不可（overlaps-existing）。占有区間は重ならない", async () => {
    const a = await applyApproved("firm", "2026-10-20T10:00", "2026-10-20T12:00", 11_000);
    const meet = meetBeforeFirstWrite(2);

    const [changed, applied] = await Promise.all([
      operate(
        {
          kind: "change",
          reservationId: a,
          start: jst("2026-10-20T14:00"),
          end: jst("2026-10-20T16:00"),
          content: sameContent,
          confirmedPrice: Yen.parse(11_000),
          priceTable,
        },
        { maxAttempts: 3, beforeWrite: meet },
      ),
      saveApplication(store, application("firm", "2026-10-20T14:00", "2026-10-20T16:00"), {
        now: appliedAt,
        maxAttempts: 3,
        beforeWrite: meet,
      }),
    ]);

    expect([changed.ok, applied.ok].filter(Boolean)).toHaveLength(1);
    const intervals = await storedIntervals("2026-10-20");
    expect(overlapping(intervals)).toBe(false);
    const detail = await getReservation(store, a);
    if (changed.ok) {
      expect(applied).toEqual({ ok: false, reason: "overlaps-existing" });
      expect(detail?.start.toMillis()).toBe(jst("2026-10-20T14:00").toMillis());
      expect(intervals).toEqual([
        interval({ id: a, status: "firm", start: "2026-10-20T14:00", end: "2026-10-20T17:00" }),
      ]);
    } else {
      expect(changed).toEqual({ ok: false, reason: "overlaps-existing" });
      expect(detail?.start.toMillis()).toBe(jst("2026-10-20T10:00").toMillis());
      expect(intervals.map((i) => i.id)).toEqual([a, applied.ok ? applied.id : "?"]);
      expect(await historyCount(a)).toBe(2); // 申込と承認だけ
    }
  });

  it("仮予約 P 13:00–15:00 の昇格と、P への第二キープ申込 14:00–17:00 を、どちらも読んで判定してから書くように同時に送る：昇格は成功し、本予約と重なる第二キープは残らない（申込が先に書かれたら、その第二キープは終了する）", async () => {
    const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    const meet = meetBeforeFirstWrite(2);

    const [promoted, applied] = await Promise.all([
      operate({ kind: "promote", reservationId: p }, { maxAttempts: 3, beforeWrite: meet }),
      saveApplication(store, application("second-hold", "2026-10-20T14:00", "2026-10-20T17:00"), {
        now: appliedAt,
        maxAttempts: 3,
        beforeWrite: meet,
      }),
    ]);

    expect(promoted.ok).toBe(true);
    expect(await storedIntervals("2026-10-20")).toEqual([
      interval({ id: p, status: "firm", start: "2026-10-20T13:00", end: "2026-10-20T16:00" }),
    ]);
    if (applied.ok) {
      expect((await getReservation(store, applied.id))?.status).toBe("ended");
      expect(promoted.ok ? promoted.drafts.map((d) => d.draft) : []).toContainEqual({
        kind: "second-hold-ended",
        reservationId: applied.id,
      });
    } else {
      const metas = (await scanAll()).filter(
        (item) => String(item["pk"]).startsWith("RES#") && item["sk"] === "META",
      );
      expect(metas.map((item) => item["pk"])).toEqual([`RES#${p}`]);
    }
  });

  it("承認待ち（本）A の承認を判定したあと書く前に、ほかの管理者が A を却下する：承認は読み直して不可（not-pending）。A は取消のまま、履歴は申込と却下、下書きは却下だけ", async () => {
    const a = await apply("firm", "2026-10-20T10:00", "2026-10-20T12:00");
    let calls = 0;

    const approved = await operate(
      { kind: "approve", reservationId: a, confirmedPrice: Yen.parse(11_000) },
      {
        maxAttempts: 3,
        beforeWrite: async (attempt) => {
          calls += 1;
          if (attempt === 1) {
            await operateOk(
              { kind: "reject", reservationId: a },
              { now: preparedAt, adminUserId: otherAdminUserId },
            );
          }
        },
      },
    );

    expect(approved).toEqual({ ok: false, reason: "not-pending" });
    expect(calls).toBe(1);
    const detail = await getReservation(store, a);
    expect(detail?.status).toBe("cancelled");
    expect(detail?.confirmedPrice).toBeUndefined();
    expect(detail?.history.map((h) => h.operation)).toEqual(["apply", "reject"]);
    expect(detail?.history.at(-1)?.actor).toEqual({ kind: "admin", userId: otherAdminUserId });
    expect(await draftItems()).toHaveLength(1);
    expect(await storedIntervals("2026-10-20")).toEqual([]);
  });
});

describe("途中で失敗したら何も残らない（INV-2）", () => {
  it("本予約 A 10/20 10:00–12:00 を 10/27 に移動するとき、書く直前に毎回ほかの書き込みで DAY#2026-10-27 の版番号が進み、やり直しの上限（3回）を超える：混み合っている（busy）。META・履歴・下書き・DAY#2026-10-20 は変わらず、DAY#2026-10-27 は版番号だけが進む", async () => {
    const a = await applyApproved("firm", "2026-10-20T10:00", "2026-10-20T12:00", 11_000);
    const before = await scanAll();
    const unsentBefore = await unsentDraftKeys();
    let calls = 0;

    const result = await operate(
      {
        kind: "change",
        reservationId: a,
        start: jst("2026-10-27T10:00"),
        end: jst("2026-10-27T12:00"),
        content: sameContent,
        confirmedPrice: Yen.parse(11_000),
        priceTable,
      },
      {
        maxAttempts: 3,
        beforeWrite: async () => {
          calls += 1;
          await bumpDay("2026-10-27");
        },
      },
    );

    expect(result).toEqual({ ok: false, reason: "busy" });
    expect(calls).toBe(3);
    const after = await scanAll();
    expect(sortedItems(after.filter((item) => item["pk"] !== "DAY#2026-10-27"))).toEqual(
      sortedItems(before),
    );
    expect(await dayVersion("2026-10-27")).toBe(3);
    expect(await storedIntervals("2026-10-27")).toEqual([]);
    expect(await unsentDraftKeys()).toEqual(unsentBefore);
  });

  it("仮予約 P 10/20 22:00–10/21 01:00 に第二キープ K 10/21 00:00–03:00 が付いているときの昇格で、書く直前に毎回 DAY#2026-10-20 の版番号が進み、上限（2回）を超える：busy。P・K の META と履歴、下書き、DAY#2026-10-21 は変わらず、DAY#2026-10-20 は版番号だけが進む", async () => {
    const p = await applyApproved("provisional", "2026-10-20T22:00", "2026-10-21T01:00");
    const k = await applyApproved("second-hold", "2026-10-21T00:00", "2026-10-21T03:00");
    const before = await scanAll();
    const day20Before = await storedIntervals("2026-10-20");
    const version20 = (await dayVersion("2026-10-20")) as number;
    let calls = 0;

    const result = await operate(
      { kind: "promote", reservationId: p },
      {
        maxAttempts: 2,
        beforeWrite: async () => {
          calls += 1;
          await bumpDay("2026-10-20");
        },
      },
    );

    expect(result).toEqual({ ok: false, reason: "busy" });
    expect(calls).toBe(2);
    const after = await scanAll();
    expect(sortedItems(after.filter((item) => item["pk"] !== "DAY#2026-10-20"))).toEqual(
      sortedItems(before.filter((item) => item["pk"] !== "DAY#2026-10-20")),
    );
    expect(await dayVersion("2026-10-20")).toBe(version20 + 2);
    expect(await storedIntervals("2026-10-20")).toEqual(day20Before);
    expect((await getReservation(store, p))?.status).toBe("provisional");
    expect((await getReservation(store, k))?.status).toBe("second-hold");
  });

  it("本予約 A の取消で、1回目の書く直前だけほかの書き込みで版番号が進む：読み直してやり直し、取消は成功。版番号は2増え、履歴と下書きは1件ずつ増える", async () => {
    const a = await applyApproved("firm", "2026-10-20T10:00", "2026-10-20T12:00");
    const version = (await dayVersion("2026-10-20")) as number;
    const histories = await historyCount(a);
    const drafts = (await draftItems()).length;
    let calls = 0;

    const result = await operate(
      { kind: "cancel", reservationId: a },
      {
        maxAttempts: 3,
        beforeWrite: async (attempt) => {
          calls += 1;
          if (attempt === 1) await bumpDay("2026-10-20");
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
    expect(await dayVersion("2026-10-20")).toBe(version + 2);
    expect(await storedIntervals("2026-10-20")).toEqual([]);
    expect(await historyCount(a)).toBe(histories + 1);
    expect(await draftItems()).toHaveLength(drafts + 1);
  });
});

describe("個人情報は下書き・履歴・日ごとのアイテムに入らない（INV-10）", () => {
  it("承認・昇格・変更・取消・繰り上げを保存したあと：お客様の情報と撮影の内容（自由記述）の値は PII のアイテムにだけあり、META・DAY#・HIST#・DRAFT# のどのアイテムにもない", async () => {
    const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    const k = await applyApproved("second-hold", "2026-10-20T14:00", "2026-10-20T17:00");
    const a = await applyApproved("firm", "2026-10-22T10:00", "2026-10-22T12:00", 27_500);
    const q = await applyApproved("provisional", "2026-10-23T10:00", "2026-10-23T12:00");
    await operateOk({
      kind: "change",
      reservationId: p,
      start: jst("2026-10-21T13:00"),
      end: jst("2026-10-21T15:00"),
      content: sameContent,
      confirmedPrice: Yen.parse(22_000),
      priceTable,
    });
    await operateOk({ kind: "move-up", reservationId: k });
    await operateOk({ kind: "cancel", reservationId: a });
    await operateOk({ kind: "promote", reservationId: q });

    const items = await scanAll();
    const notPii = items.filter((item) => item["sk"] !== "PII");
    expect(notPii.some((item) => String(item["sk"]).startsWith("DRAFT#"))).toBe(true);
    expect(notPii.some((item) => String(item["sk"]).startsWith("HIST#"))).toBe(true);
    expect(notPii.some((item) => String(item["pk"]).startsWith("DAY#"))).toBe(true);
    for (const item of notPii) {
      expectNoPersonalInfo(item);
    }
  });
});
