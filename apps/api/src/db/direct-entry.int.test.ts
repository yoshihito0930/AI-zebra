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
import { ReceiptNumber, Yen } from "@zebra/contracts";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalDynamoClient } from "./client.ts";
import {
  type DirectEntry,
  type DirectEntryKind,
  type SaveDirectEntryOptions,
  type SaveDirectEntryResult,
  saveDirectEntry,
} from "./direct-entry.ts";
import { saveReservationOperation } from "./operations.ts";
import {
  type ApplicationKind,
  type ReservationApplication,
  type ReservationStore,
  type StoredCustomerInfo,
  type StoredShootingInfo,
  getReservation,
  saveApplication,
} from "./reservations.ts";

// 管理者による予約の直接入力の保存の統合テスト（DynamoDB Local）。
// 根拠：docs/product-specs/booking.md「管理者による予約の直接入力とブロック枠」の「直接入れる予約のルール」、
// docs/design-docs/reservation-model.md（予約が持つもの、状態と操作の直接入力、履歴）、dynamodb-keys.md（アイテム、書き込み）、
// core-beliefs.md（INV-1、INV-2、INV-7、INV-10）。
// 直接入力の判定の細かい決まり（例の表の行）は booking-core の単体テスト（direct-entry.test.ts）で確かめているので、
// ここでは代表的な場合と、それが1回の書き込みで DB に残ること（残らないこと）を確かめる。
// - 警告（締め切り、深夜帯にかかる予約の最短4時間）は、管理者の確認を受けてから保存を呼ぶ前提で、保存の層では止めない
//   （確認の流れは管理 API の仕事）
// - 例外を認めない決まり（30分単位、最短2時間、最長24時間、空き判定、付く仮予約がない）は、保存の層でも理由つきで止まり、
//   何も書かない。予約の変更の保存が、日時の不可を保存の層で止めているのと同じ考え方
// - 入力の形の確かめ（メールアドレス・電話番号の形、長さの上限、氏名と連絡先が1つあること）は API の層の仕事。
//   保存の層では、任意の欄がないまま保存・読み出しできることを確かめる
// 予約の準備は、申込の保存（saveApplication）と承認の保存（saveReservationOperation）で作る。
// META・履歴の属性名は資料にないので、予約の詳細（getReservation）とアイテムの中の値で確かめる。
// 直接見る属性は、資料にある pk・sk・gsi1pk・gsi1sk・version・intervals だけ。

const client = createLocalDynamoClient();
let store: ReservationStore;

// テーブルはキー設計どおり（pk・sk、GSI の gsi1pk・gsi1sk）にテストごとに作り、終わったら消す
async function createTable(): Promise<ReservationStore> {
  const tableName = `int-test-direct-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
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

/** 申込の時刻（準備。固定） */
const appliedAt = jst("2026-10-01T12:00");
/** 準備でする承認の時刻（固定） */
const preparedAt = jst("2026-10-02T12:00");
/** 直接入力の時刻（固定）。行に書かれていなければ、締め切りより十分前 */
const enteredAt = jst("2026-10-05T09:00");

/** 操作した管理者（架空のユーザー id） */
const adminUserId = "admin-user-kaku-1";

/** JST で渡すか、同じ時点を UTC で渡すか（INV-7） */
const zoneVariants = [
  ["JST", (d: DateTime) => d],
  ["UTC", (d: DateTime) => d.toUTC()],
] as const;

/** 保存された日時の文字列が、UTC で表されていて（INV-7）、指定の時点と同じかを確かめる */
function expectUtcInstant(value: unknown, expected: DateTime): void {
  expect(typeof value).toBe("string");
  const parsed = DateTime.fromISO(value as string, { setZone: true });
  expect(parsed.isValid).toBe(true);
  expect(parsed.offset).toBe(0);
  expect(parsed.toMillis()).toBe(expected.toMillis());
}

// ---- 架空のお客様の情報（INV-10 の確認に使うので、ほかの値と紛れない文字列にする） ----

const fullCustomer = {
  name: "架空 三郎",
  companyName: "架空制作株式会社",
  email: "saburo.kaku@example.com",
  phone: "090-0000-9012",
  address: "架空県架空市架空坂7-8-9",
  photographerName: "仮名 撮影次郎",
} as const satisfies StoredCustomerInfo;

const fullShooting = {
  types: ["movie"],
  details: "架空の撮影詳細：電話で受けたミュージックビデオの撮影",
  notes: "架空の補足事項：機材車が1台来る",
} as const satisfies StoredShootingInfo;

const personalValues: readonly string[] = [
  fullCustomer.name,
  fullCustomer.companyName,
  fullCustomer.email,
  fullCustomer.phone,
  fullCustomer.address,
  fullCustomer.photographerName,
  fullShooting.details,
  fullShooting.notes,
];

/** 準備の申込のお客様（直接入力のお客様と紛れないよう、別の架空の値にする） */
const applicantCustomer = {
  name: "架空 申込子",
  email: "moushikomi.kaku@example.com",
  phone: "090-0000-0001",
  address: "架空県架空市申込町1-1-1",
  photographerName: "仮名 申込撮影",
} as const;

const applicantShooting = { types: ["still"], details: "架空の撮影詳細：準備の申込" } as const;

function application(kind: ApplicationKind, start: string, end: string): ReservationApplication {
  return {
    kind,
    start: jst(start),
    end: jst(end),
    partySize: 2,
    cycloramaFloorProtection: false,
    planId: "A",
    equipmentInsurance: false,
    optionIds: [],
    estimate: {
      subtotalExcludingTax: Yen.parse(10_000),
      estimateIncludingTax: Yen.parse(11_000),
    },
    customer: applicantCustomer,
    shooting: applicantShooting,
  };
}

/** 直接入れる予約。人数3人・養生あり・プランA・機材保険あり・オプションなし、見積 税抜 25,000円・税込 27,500円、確定金額 26,000円 */
function entry(
  kind: DirectEntryKind,
  start: DateTime | string,
  end: DateTime | string,
  overrides: Partial<DirectEntry> = {},
): DirectEntry {
  return {
    kind,
    start: typeof start === "string" ? jst(start) : start,
    end: typeof end === "string" ? jst(end) : end,
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
    customer: fullCustomer,
    shooting: fullShooting,
    ...overrides,
  };
}

async function enter(
  value: DirectEntry,
  options: Partial<SaveDirectEntryOptions> = {},
): Promise<SaveDirectEntryResult> {
  return saveDirectEntry(store, value, { now: enteredAt, adminUserId, ...options });
}

async function enterOk(
  value: DirectEntry,
  options: Partial<SaveDirectEntryOptions> = {},
): Promise<string> {
  const result = await enter(value, options);
  if (!result.ok) {
    throw new Error(`入るはずが不可になった（${value.kind}、${result.reason}）`);
  }
  return result.id;
}

// ---- 準備の道具 ----

async function apply(kind: ApplicationKind, start: string, end: string): Promise<string> {
  const result = await saveApplication(store, application(kind, start, end), { now: appliedAt });
  if (!result.ok) {
    throw new Error(`準備の申込が不可になった（${kind} ${start}–${end}、${result.reason}）`);
  }
  return result.id;
}

/** 申込して承認する（準備） */
async function applyApproved(kind: ApplicationKind, start: string, end: string): Promise<string> {
  const id = await apply(kind, start, end);
  const result = await saveReservationOperation(
    store,
    { kind: "approve", reservationId: id, confirmedPrice: Yen.parse(22_000) },
    { now: preparedAt, adminUserId },
  );
  if (!result.ok) {
    throw new Error(`準備の承認が不可になった（${result.reason}）`);
  }
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

/** 不可の直接入力・途中で失敗した直接入力で、テーブルの中身が何も変わっていないことを確かめる */
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

async function itemsOf(id: string): Promise<PlainItem[]> {
  const res = await client.send(
    new QueryCommand({
      TableName: store.tableName,
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": { S: `RES#${id}` } },
      ConsistentRead: true,
    }),
  );
  return (res.Items ?? []).map(plainItem);
}

async function metaCount(): Promise<number> {
  return (await scanAll()).filter(
    (item) => String(item["pk"]).startsWith("RES#") && item["sk"] === "META",
  ).length;
}

async function dayItem(day: string): Promise<PlainItem | undefined> {
  return getItem(`DAY#${day}`, "META");
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

function normalizeStored(stored: unknown): NormalizedInterval {
  const map = stored as Record<string, unknown>;
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
  return (item["intervals"] as unknown[]).map(normalizeStored);
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

/** 管理者が入れたブロック枠を、日ごとのアイテムに直接入れる（dynamodb-keys.md「アイテム」の属性の形） */
async function putBlockDay(day: string, id: string, start: string, end: string): Promise<void> {
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
                bufferMinutes: { N: "0" },
              },
            },
          ],
        },
      },
    }),
  );
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

/** 2件の書き込みがどちらも「読んで判定した」ところで待ち合わせ、それから書かせる（必ず衝突させる） */
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

// ---- テスト ----

describe("直接入力の保存", () => {
  it("管理者が本予約 10/20 15:00–17:00 を直接入れる：承認待ちを経ず本予約（firm）。予約の META・個人情報・履歴1件と、DAY#2026-10-20（占有区間 15:00–18:00、版番号1）が書かれる。受付番号は作らない", async () => {
    const id = await enterOk(entry("firm", "2026-10-20T15:00", "2026-10-20T17:00"));

    const items = await itemsOf(id);
    const sks = items.map((item) => String(item["sk"]));
    expect(sks).toContain("META");
    expect(sks).toContain("PII");
    const histories = sks.filter((sk) => sk.startsWith("HIST#"));
    expect(histories).toHaveLength(1);
    // HIST#<日時（UTC）>#<連番>。日時は現在時刻
    const match = /^HIST#([^#]+)#\d+$/.exec(histories[0] ?? "");
    expect(match).not.toBeNull();
    const historyAt = DateTime.fromISO(match?.[1] ?? "", { setZone: true });
    expect(historyAt.offset).toBe(0);
    expect(historyAt.toMillis()).toBe(enteredAt.toMillis());
    expect(items).toHaveLength(3);

    expect((await dayItem("2026-10-20"))?.["version"]).toBe(1);
    expect(await storedIntervals("2026-10-20")).toEqual([
      interval({ id, status: "firm", start: "2026-10-20T15:00", end: "2026-10-20T18:00" }),
    ]);
    expect(await dayItem("2026-10-19")).toBeUndefined();
    expect(await dayItem("2026-10-21")).toBeUndefined();

    // 受付番号はフォームの申込だけ（dynamodb-keys.md「アイテム」）：RCPT# のアイテムはなく、META に受付番号の形の値もない
    const all = await scanAll();
    expect(all.filter((item) => String(item["pk"]).startsWith("RCPT#"))).toEqual([]);
    const meta = await getItem(`RES#${id}`, "META");
    for (const s of stringsIn(meta)) {
      expect(ReceiptNumber.safeParse(s).success, s).toBe(false);
    }
  });

  it("同じ直接入力を読み出す：本予約、バッファ60分、経路は admin、申込の内容と見積、確定金額 26,000円、第二キープの仮予約なし、作成・更新は現在時刻、お客様の情報と撮影の内容は渡したとおり。履歴は直接入力（direct-entry）1件で、誰がは操作した管理者", async () => {
    const id = await enterOk(entry("firm", "2026-10-20T15:00", "2026-10-20T17:00"));

    const detail = await getReservation(store, id);
    expect(detail).not.toBeNull();
    if (detail === null) return;
    expect(detail.id).toBe(id);
    expect(detail.status).toBe("firm");
    expect(detail.start.toMillis()).toBe(jst("2026-10-20T15:00").toMillis());
    expect(detail.end.toMillis()).toBe(jst("2026-10-20T17:00").toMillis());
    expect(detail.bufferMinutes).toBe(60);
    expect(detail.route).toBe("admin");
    expect(detail.partySize).toBe(3);
    expect(detail.cycloramaFloorProtection).toBe(true);
    expect(detail.planId).toBe("A");
    expect(detail.equipmentInsurance).toBe(true);
    expect(detail.optionIds).toEqual([]);
    expect(detail.estimate).toEqual({
      subtotalExcludingTax: Yen.parse(25_000),
      estimateIncludingTax: Yen.parse(27_500),
    });
    expect(detail.confirmedPrice).toBe(26_000);
    expect(detail.provisionalIds).toBeUndefined();
    expect(detail.createdAt.toMillis()).toBe(enteredAt.toMillis());
    expect(detail.updatedAt.toMillis()).toBe(enteredAt.toMillis());
    expect(detail.customer).toEqual(fullCustomer);
    expect(detail.shooting).toEqual(fullShooting);

    expect(detail.history).toHaveLength(1);
    const history = detail.history[0];
    expect(history?.at.toMillis()).toBe(enteredAt.toMillis());
    expect(history?.actor).toEqual({ kind: "admin", userId: adminUserId });
    expect(history?.operation).toBe("direct-entry");
    expect(history?.before).toBeUndefined();
    expect(history?.after?.status).toBe("firm");
    expect(history?.after?.start.toMillis()).toBe(jst("2026-10-20T15:00").toMillis());
    expect(history?.after?.end.toMillis()).toBe(jst("2026-10-20T17:00").toMillis());
    expect(history?.after?.bufferMinutes).toBe(60);
    expect(history?.after?.confirmedPrice).toBe(26_000);
  });

  it("管理者が仮予約 10/20 15:00–17:00 を直接入れる：承認待ちを経ず仮予約（provisional）。日ごとのアイテムの状態も仮予約", async () => {
    const id = await enterOk(entry("provisional", "2026-10-20T15:00", "2026-10-20T17:00"));

    const detail = await getReservation(store, id);
    expect(detail?.status).toBe("provisional");
    expect(detail?.route).toBe("admin");
    expect(detail?.confirmedPrice).toBe(26_000);
    expect(detail?.history[0]?.operation).toBe("direct-entry");
    expect(await storedIntervals("2026-10-20")).toEqual([
      interval({ id, status: "provisional", start: "2026-10-20T15:00", end: "2026-10-20T18:00" }),
    ]);
  });

  it("承認済みの仮予約 P 10/20 15:00–17:00 があるときに、管理者が第二キープ 10/20 15:00–17:00 を直接入れる：承認待ちを経ず第二キープ（second-hold）。P の id を持つ（予約の詳細・履歴・日ごとのアイテム）", async () => {
    const p = await applyApproved("provisional", "2026-10-20T15:00", "2026-10-20T17:00");

    const k = await enterOk(entry("second-hold", "2026-10-20T15:00", "2026-10-20T17:00"));

    const detail = await getReservation(store, k);
    expect(detail?.status).toBe("second-hold");
    expect(detail?.provisionalIds).toEqual([p]);
    expect(detail?.history[0]?.operation).toBe("direct-entry");
    expect(detail?.history[0]?.after?.provisionalIds).toEqual([p]);
    expect((await storedIntervals("2026-10-20")).sort(byStart)).toEqual(
      [
        interval({
          id: p,
          status: "provisional",
          start: "2026-10-20T15:00",
          end: "2026-10-20T18:00",
        }),
        interval({
          id: k,
          status: "second-hold",
          provisionalIds: [p],
          start: "2026-10-20T15:00",
          end: "2026-10-20T18:00",
        }),
      ].sort(byStart),
    );
  });

  it("承認済みの仮予約 P1 10/20 10:00–12:00・P2 10/20 15:00–17:00 にまたがる第二キープ 12:00–16:00 を直接入れる：P1 と P2 の両方に付く", async () => {
    const p1 = await applyApproved("provisional", "2026-10-20T10:00", "2026-10-20T12:00");
    const p2 = await applyApproved("provisional", "2026-10-20T15:00", "2026-10-20T17:00");

    const k = await enterOk(entry("second-hold", "2026-10-20T12:00", "2026-10-20T16:00"));

    expect([...((await getReservation(store, k))?.provisionalIds ?? [])].sort()).toEqual(
      [p1, p2].sort(),
    );
  });

  it("予約の META に GSI のキーが入る：gsi1pk は STATUS#firm、gsi1sk は開始日時（UTC）", async () => {
    const id = await enterOk(entry("firm", "2026-10-20T15:00", "2026-10-20T17:00"));

    const meta = await getItem(`RES#${id}`, "META");
    expect(meta?.["gsi1pk"]).toBe("STATUS#firm");
    expectUtcInstant(meta?.["gsi1sk"], jst("2026-10-20T15:00"));
  });

  it("確定金額は、見積と別に管理者が決めた値で残る：見積 税込 27,500円、確定金額 30,000円で入れると、META に 30,000 があり、予約の詳細の確定金額は 30,000円", async () => {
    const id = await enterOk(
      entry("firm", "2026-10-20T15:00", "2026-10-20T17:00", {
        confirmedPrice: Yen.parse(30_000),
      }),
    );

    expect(numbersIn(await getItem(`RES#${id}`, "META"))).toContain(30_000);
    const detail = await getReservation(store, id);
    expect(detail?.confirmedPrice).toBe(30_000);
    expect(detail?.estimate.estimateIncludingTax).toBe(27_500);
  });
});

describe("直接入力のお客様の情報", () => {
  it("氏名と電話番号だけ（会社名・メールアドレス・住所・カメラマン氏名・撮影内容・撮影詳細・補足事項はない）で直接入れて読む：お客様の情報と撮影の内容は渡したとおり（ない欄はない）", async () => {
    const phoneOnly: StoredCustomerInfo = { name: fullCustomer.name, phone: fullCustomer.phone };
    const noShooting: StoredShootingInfo = {};
    const id = await enterOk(
      entry("firm", "2026-10-20T15:00", "2026-10-20T17:00", {
        customer: phoneOnly,
        shooting: noShooting,
      }),
    );

    const detail = await getReservation(store, id);
    expect(detail?.customer).toEqual(phoneOnly);
    expect(detail?.customer.email).toBeUndefined();
    expect(detail?.customer.address).toBeUndefined();
    expect(detail?.customer.photographerName).toBeUndefined();
    expect(detail?.customer.companyName).toBeUndefined();
    expect(detail?.shooting).toEqual(noShooting);
    expect(detail?.shooting.types).toBeUndefined();
    expect(detail?.shooting.details).toBeUndefined();
    expect(detail?.shooting.notes).toBeUndefined();
    expect(detail?.status).toBe("firm");
  });

  it("氏名とメールアドレスだけ（電話番号ほかはない）で直接入れて読む：お客様の情報は渡したとおり（電話番号はない）", async () => {
    const emailOnly: StoredCustomerInfo = { name: fullCustomer.name, email: fullCustomer.email };
    const id = await enterOk(
      entry("provisional", "2026-10-20T15:00", "2026-10-20T17:00", { customer: emailOnly }),
    );

    const detail = await getReservation(store, id);
    expect(detail?.customer).toEqual(emailOnly);
    expect(detail?.customer.phone).toBeUndefined();
    expect(detail?.shooting).toEqual(fullShooting);
  });

  it("撮影詳細だけ（撮影内容・補足事項はない）で直接入れて読む：撮影の内容は渡したとおり", async () => {
    const detailsOnly: StoredShootingInfo = { details: fullShooting.details };
    const id = await enterOk(
      entry("firm", "2026-10-20T15:00", "2026-10-20T17:00", { shooting: detailsOnly }),
    );

    expect((await getReservation(store, id))?.shooting).toEqual(detailsOnly);
  });

  it("お客様の情報と撮影の内容（自由記述）の値は、PII のアイテムにだけあり、META・DAY#・HIST# のどのアイテムにもない（INV-10）", async () => {
    await applyApproved("provisional", "2026-10-21T15:00", "2026-10-21T17:00");
    const firm = await enterOk(entry("firm", "2026-10-20T22:00", "2026-10-21T02:00"));
    const secondHold = await enterOk(entry("second-hold", "2026-10-21T15:00", "2026-10-21T17:00"));

    const items = await scanAll();
    const notPii = items.filter((item) => item["sk"] !== "PII");
    expect(notPii.some((item) => String(item["pk"]).startsWith("DAY#"))).toBe(true);
    expect(notPii.some((item) => String(item["sk"]).startsWith("HIST#"))).toBe(true);
    for (const item of notPii) {
      expectNoPersonalInfo(item);
    }
    for (const id of [firm, secondHold]) {
      const strings = stringsIn(await getItem(`RES#${id}`, "PII"));
      for (const personal of personalValues) {
        expect(strings).toContain(personal);
      }
    }
  });
});

// 締め切りと、深夜帯にかかる予約の最短4時間は警告（管理者が確認すれば入る）。確認の流れは管理 API の仕事で、
// 保存は管理者の確認のあとに呼ばれるので、保存の層では止めない
describe("直接入力の保存：警告に当たる予約も、保存の層では止めない", () => {
  it("10/20 9:00 に、本予約 10/20 15:00–17:00 を保存する（締め切り〈24時間前〉を過ぎている）：入る", async () => {
    const id = await enterOk(entry("firm", "2026-10-20T15:00", "2026-10-20T17:00"), {
      now: jst("2026-10-20T09:00"),
    });

    expect((await getReservation(store, id))?.status).toBe("firm");
  });

  it("本予約 10/20 03:00–05:00 を保存する（深夜帯にかかり4時間未満）：入る。占有区間は 03:00–06:00", async () => {
    const id = await enterOk(entry("firm", "2026-10-20T03:00", "2026-10-20T05:00"));

    expect(await storedIntervals("2026-10-20")).toEqual([
      interval({ id, status: "firm", start: "2026-10-20T03:00", end: "2026-10-20T06:00" }),
    ]);
  });

  it("10/15 12:00 に、仮予約 10/20 15:00–17:00 を保存する（利用日の5日前。仮予約の期限を過ぎている）：入る", async () => {
    const id = await enterOk(entry("provisional", "2026-10-20T15:00", "2026-10-20T17:00"), {
      now: jst("2026-10-15T12:00"),
    });

    expect((await getReservation(store, id))?.status).toBe("provisional");
  });

  it("10/14 12:00 に、承認済みの仮予約 P 10/20 15:00–17:00 と重なる第二キープ 10/20 15:00–17:00 を保存する（仮予約の期限 10/13 18:00 を過ぎている）：入る。P に付く", async () => {
    const p = await applyApproved("provisional", "2026-10-20T15:00", "2026-10-20T17:00");

    const k = await enterOk(entry("second-hold", "2026-10-20T15:00", "2026-10-20T17:00"), {
      now: jst("2026-10-14T12:00"),
    });

    expect((await getReservation(store, k))?.provisionalIds).toEqual([p]);
  });
});

// 例外を認めない決まりは、保存の層でも止める（予約の変更の保存と同じ）。判定は JST で行う（INV-7）ので、
// 同じ時点を UTC で表した日時でも確かめる。値の名前は、公開 API の契約（ApplicationRejection）と同じ
describe("直接入力の保存：不可なら何も書かない", () => {
  async function expectRejected(
    kind: DirectEntryKind,
    start: string,
    end: string,
    reason: string,
  ): Promise<void> {
    const before = await scanAll();
    for (const [zone, toZone] of zoneVariants) {
      const result = await enter(entry(kind, toZone(jst(start)), toZone(jst(end))), {
        now: toZone(enteredAt),
      });
      expect(result, zone).toEqual({ ok: false, reason });
      await expectNothingWritten(before);
    }
  }

  it("本予約 10/20 10:15–12:15：不可（not-on-30-minute-boundary。30分単位でない）。JST で渡しても UTC で渡しても、何も書かれない", async () => {
    await expectRejected(
      "firm",
      "2026-10-20T10:15",
      "2026-10-20T12:15",
      "not-on-30-minute-boundary",
    );
  });

  it("本予約 10/20 10:00–11:00：不可（shorter-than-2-hours。2時間未満）。JST で渡しても UTC で渡しても、何も書かれない", async () => {
    await expectRejected("firm", "2026-10-20T10:00", "2026-10-20T11:00", "shorter-than-2-hours");
  });

  it("本予約 10/20 03:00–04:30：不可（shorter-than-2-hours。深夜帯にかかっても、2時間未満は入れられない）。JST で渡しても UTC で渡しても、何も書かれない", async () => {
    await expectRejected("firm", "2026-10-20T03:00", "2026-10-20T04:30", "shorter-than-2-hours");
  });

  it("本予約 10/20 10:00–10/21 10:30：不可（longer-than-24-hours。24時間を超える）。JST で渡しても UTC で渡しても、何も書かれない", async () => {
    await expectRejected("firm", "2026-10-20T10:00", "2026-10-21T10:30", "longer-than-24-hours");
  });

  it("本予約 10/20 10:00–12:00（占有区間 10:00–13:00）があるときの本予約 12:00–14:00：不可（overlaps-existing。空き判定）。何も書かれない", async () => {
    await applyApproved("firm", "2026-10-20T10:00", "2026-10-20T12:00");

    await expectRejected("firm", "2026-10-20T12:00", "2026-10-20T14:00", "overlaps-existing");
  });

  it("前の日から日をまたぐブロック枠（10/19 22:00–10/20 02:00。両日のアイテムにある）があるときの仮予約 10/20 01:00–05:00：不可（overlaps-existing）。JST で渡しても UTC で渡しても、何も書かれない", async () => {
    await putBlockDay("2026-10-19", "seed-block-overnight", "2026-10-19T22:00", "2026-10-20T02:00");
    await putBlockDay("2026-10-20", "seed-block-overnight", "2026-10-19T22:00", "2026-10-20T02:00");

    await expectRejected(
      "provisional",
      "2026-10-20T01:00",
      "2026-10-20T05:00",
      "overlaps-existing",
    );
  });

  it("重なる承認済みの仮予約がないときの第二キープ 10/20 15:00–17:00：不可（no-provisional-to-hold。付く仮予約がない。普通の予約には切り替えない）。何も書かれない", async () => {
    await expectRejected(
      "second-hold",
      "2026-10-20T15:00",
      "2026-10-20T17:00",
      "no-provisional-to-hold",
    );
  });

  it("承認待ちの仮予約 10/20 15:00–17:00 があるときの第二キープ 10/20 15:00–17:00：不可（承認待ちとは重なれない）。何も書かれない", async () => {
    await apply("provisional", "2026-10-20T15:00", "2026-10-20T17:00");
    const before = await scanAll();

    const result = await enter(entry("second-hold", "2026-10-20T15:00", "2026-10-20T17:00"));

    expect(result.ok).toBe(false);
    await expectNothingWritten(before);
  });

  it("承認済みの仮予約 P 10/20 15:00–17:00 があるときの本予約 16:00–18:00：不可（overlaps-existing。仮予約と重なってよいのは第二キープだけ）。何も書かれない", async () => {
    await applyApproved("provisional", "2026-10-20T15:00", "2026-10-20T17:00");

    await expectRejected("firm", "2026-10-20T16:00", "2026-10-20T18:00", "overlaps-existing");
  });
});

describe("同時の直接入力（INV-1）", () => {
  it("重なる本予約 10/20 15:00–17:00 と仮予約 10/20 16:00–18:00 の直接入力を、どちらも読んで判定してから書くように同時に送る：片方だけ入り、もう片方は読み直して不可。予約は1件、占有区間は1件", async () => {
    const meet = meetBeforeFirstWrite(2);
    const results = await Promise.all([
      enter(entry("firm", "2026-10-20T15:00", "2026-10-20T17:00"), {
        maxAttempts: 3,
        beforeWrite: meet,
      }),
      enter(entry("provisional", "2026-10-20T16:00", "2026-10-20T18:00"), {
        maxAttempts: 3,
        beforeWrite: meet,
      }),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "overlaps-existing" }]);
    const winner = results.find((r) => r.ok);
    expect((await storedIntervals("2026-10-20")).map((i) => i.id)).toEqual([
      winner?.ok === true ? winner.id : "?",
    ]);
    expect((await dayItem("2026-10-20"))?.["version"]).toBe(1);
    expect(await metaCount()).toBe(1);
  });

  it("同じ時間への直接入力とウィジェットからの申込を、どちらも読んで判定してから書くように同時に送る：片方だけが成功し、予約は1件、占有区間は1件", async () => {
    const meet = meetBeforeFirstWrite(2);
    const [direct, applied] = await Promise.all([
      enter(entry("firm", "2026-10-20T15:00", "2026-10-20T17:00"), {
        maxAttempts: 3,
        beforeWrite: meet,
      }),
      saveApplication(store, application("firm", "2026-10-20T15:00", "2026-10-20T17:00"), {
        now: appliedAt,
        maxAttempts: 3,
        beforeWrite: meet,
      }),
    ]);

    expect([direct.ok, applied.ok].filter((ok) => ok)).toHaveLength(1);
    expect([direct, applied].filter((r) => !r.ok)).toEqual([
      { ok: false, reason: "overlaps-existing" },
    ]);
    expect(await storedIntervals("2026-10-20")).toHaveLength(1);
    expect(await metaCount()).toBe(1);
  });

  it("同じ日の重ならない2件 10/20 08:00–10:00 と 10/20 14:00–16:00 を、どちらも読んで判定してから書くように同時に送る：両方とも入る（版番号の衝突は読み直してやり直す）。版番号は2、占有区間は2件", async () => {
    const meet = meetBeforeFirstWrite(2);
    const results = await Promise.all([
      enter(entry("firm", "2026-10-20T08:00", "2026-10-20T10:00"), {
        maxAttempts: 3,
        beforeWrite: meet,
      }),
      enter(entry("provisional", "2026-10-20T14:00", "2026-10-20T16:00"), {
        maxAttempts: 3,
        beforeWrite: meet,
      }),
    ]);

    expect(results.map((r) => r.ok)).toEqual([true, true]);
    expect((await dayItem("2026-10-20"))?.["version"]).toBe(2);
    const ids = results.flatMap((r) => (r.ok ? [r.id] : []));
    expect((await storedIntervals("2026-10-20")).map((i) => i.id).sort()).toEqual(ids.sort());
    expect(await metaCount()).toBe(2);
  });
});

describe("直接入力：途中で失敗したら何も残らない（INV-2）", () => {
  it("書く直前に毎回ほかの書き込みで版番号が進み、やり直しの上限（3回）を超える：混み合っている（busy）。予約・個人情報・履歴は残らず、日ごとのアイテムは版番号だけが進む", async () => {
    // 10/20 22:00–10/21 02:00（占有区間 22:00–03:00）は 10/20 と 10/21 にかかる。
    // 10/21 のアイテムだけが毎回書き換わるので、10/20 のアイテムへの書き込みだけが残ってはいけない
    await bumpDay("2026-10-20");
    let calls = 0;

    const result = await enter(entry("firm", "2026-10-20T22:00", "2026-10-21T02:00"), {
      maxAttempts: 3,
      beforeWrite: async () => {
        calls += 1;
        await bumpDay("2026-10-21");
      },
    });

    expect(result).toEqual({ ok: false, reason: "busy" });
    expect(calls).toBe(3);
    expect((await scanAll()).filter((item) => String(item["pk"]).startsWith("RES#"))).toEqual([]);
    expect((await dayItem("2026-10-20"))?.["version"]).toBe(1);
    expect(await storedIntervals("2026-10-20")).toEqual([]);
    expect((await dayItem("2026-10-21"))?.["version"]).toBe(3);
    expect(await storedIntervals("2026-10-21")).toEqual([]);
  });
});

describe("直接入力の日時（INV-7）", () => {
  it("本予約 10/20 22:00–10/21 02:00 を UTC で表した日時（10/20 13:00–17:00Z）で渡し、現在時刻も UTC で渡す：DAY#2026-10-20 と DAY#2026-10-21 の両方に、同じ占有区間 22:00–03:00 を切らずに入れる。作成日時は同じ時点", async () => {
    const id = await enterOk(
      entry("firm", jst("2026-10-20T22:00").toUTC(), jst("2026-10-21T02:00").toUTC()),
      { now: enteredAt.toUTC() },
    );

    const expected = interval({
      id,
      status: "firm",
      start: "2026-10-20T22:00",
      end: "2026-10-21T03:00",
    });
    expect(await storedIntervals("2026-10-20")).toEqual([expected]);
    expect(await storedIntervals("2026-10-21")).toEqual([expected]);
    expect(await dayItem("2026-10-22")).toBeUndefined();
    expect((await getReservation(store, id))?.createdAt.toMillis()).toBe(enteredAt.toMillis());
  });

  it("本予約 10/20 08:00–10:00（UTC では 10/19 23:00–10/20 01:00）：日ごとのアイテムは JST の DAY#2026-10-20 だけ。META と履歴の日時は UTC", async () => {
    const id = await enterOk(entry("firm", "2026-10-20T08:00", "2026-10-20T10:00"));

    expect(await dayItem("2026-10-19")).toBeUndefined();
    expect((await storedIntervals("2026-10-20")).map((i) => i.id)).toEqual([id]);
    for (const item of await itemsOf(id)) {
      if (item["sk"] === "PII") continue;
      for (const s of stringsIn(item)) {
        const parsed = DateTime.fromISO(s, { setZone: true });
        if (/^\d{4}-\d{2}-\d{2}T/.test(s) && parsed.isValid) {
          expect(parsed.offset).toBe(0);
        }
      }
    }
  });
});
