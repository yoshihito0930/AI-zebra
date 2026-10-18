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
import { Yen } from "@zebra/contracts";
import fc from "fast-check";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalDynamoClient } from "./client.ts";
import {
  type ApplicationKind,
  type ReservationApplication,
  type ReservationStore,
  type SaveApplicationResult,
  getReservation,
  readOccupiedIntervals,
  saveApplication,
} from "./reservations.ts";

// 申込の保存と読み出しの統合テスト（DynamoDB Local）。
// 根拠：docs/design-docs/dynamodb-keys.md（キー設計）、reservation-model.md（予約が持つもの、履歴）、
// core-beliefs.md（INV-1、INV-2、INV-7、INV-10）、TECH_STACK.md「DynamoDBでの重複予約の防ぎ方」。
// 承認・却下・昇格・取消・繰り上げ・変更の保存は、次の PR で扱う。
// ブロック枠と承認済みの仮予約は、それを保存する関数がまだないので、日ごとのアイテムの属性の形
// （dynamodb-keys.md「アイテム」）でテストから直接入れる。

const client = createLocalDynamoClient();
let store: ReservationStore;

// テーブルはキー設計どおり（pk・sk、GSI の gsi1pk・gsi1sk）にテストごとに作り、終わったら消す
async function createTable(): Promise<ReservationStore> {
  const tableName = `int-test-res-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
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
});

// ---- 日時（INV-7）。テストの日時は JST で書く。現在時刻は固定する ----

function jst(iso: string): DateTime {
  const dateTime = DateTime.fromISO(iso, { zone: "Asia/Tokyo" });
  if (!dateTime.isValid) {
    throw new Error(`テストの日時が不正：${iso}`);
  }
  return dateTime;
}

/** 現在時刻（固定）。申込の日時は、締め切りにかからないよう十分先に置く（締め切りは API の層で判定する） */
const now = jst("2026-10-01T12:00");

/** 保存された日時の文字列が、UTC で表されていて（INV-7）、JST で書いた時点と同じかを確かめる */
function expectUtcInstant(value: unknown, expectedJst: string): void {
  expect(typeof value).toBe("string");
  const parsed = DateTime.fromISO(value as string, { setZone: true });
  expect(parsed.isValid).toBe(true);
  expect(parsed.offset).toBe(0);
  expect(parsed.toMillis()).toBe(jst(expectedJst).toMillis());
}

// ---- 架空のお客様の情報（INV-10 の確認に使うので、ほかの値と紛れない文字列にする） ----

const customer = {
  name: "架空 花子",
  companyName: "架空商事株式会社",
  email: "hanako.kaku@example.com",
  phone: "090-0000-1234",
  address: "架空県架空市架空町1-2-3",
  photographerName: "仮名 撮影太郎",
} as const;

const shooting = {
  types: ["still", "movie"],
  details: "架空の撮影詳細：商品カタログの撮影",
  notes: "架空の補足事項：搬入は台車を使う",
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
    equipmentInsurance: true,
    optionIds: ["glitter"],
    estimate: {
      subtotalExcludingTax: Yen.parse(10_000),
      estimateIncludingTax: Yen.parse(11_000),
    },
    customer,
    shooting,
    ...overrides,
  };
}

async function save(
  app: ReservationApplication,
  options: Partial<Parameters<typeof saveApplication>[2]> = {},
): Promise<SaveApplicationResult> {
  return saveApplication(store, app, { now, ...options });
}

async function saveOk(
  app: ReservationApplication,
  options: Partial<Parameters<typeof saveApplication>[2]> = {},
): Promise<string> {
  const result = await save(app, options);
  if (!result.ok) {
    throw new Error(`受付になるはずが不可になった（${result.reason}）`);
  }
  return result.id;
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

function expectNoPersonalInfo(item: PlainItem): void {
  const strings = stringsIn(item);
  for (const personal of personalValues) {
    for (const s of strings) {
      expect(s).not.toContain(personal);
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

async function reservationItems(): Promise<PlainItem[]> {
  return (await scanAll()).filter((item) => String(item["pk"]).startsWith("RES#"));
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
  return (item["intervals"] as unknown[]).map(normalizeStored);
}

function expectedInterval(fields: {
  kind: "reservation" | "block";
  id: string;
  status?: string;
  provisionalIds?: string[];
  start: string;
  end: string;
}): NormalizedInterval {
  return {
    kind: fields.kind,
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

/** テストから直接入れる占有区間（日時は JST で書き、UTC の ISO 8601 で保存する） */
interface SeedInterval {
  kind: "reservation" | "block";
  id: string;
  status?: string;
  provisionalIds?: string[];
  start: string;
  end: string;
}

function seedIntervalAttribute(seed: SeedInterval): AttributeValue {
  const map: Record<string, AttributeValue> = {
    kind: { S: seed.kind },
    id: { S: seed.id },
    start: { S: jst(seed.start).toUTC().toISO() ?? "" },
    end: { S: jst(seed.end).toUTC().toISO() ?? "" },
  };
  if (seed.status !== undefined) map["status"] = { S: seed.status };
  if (seed.provisionalIds !== undefined) {
    map["provisionalIds"] = { L: seed.provisionalIds.map((id) => ({ S: id })) };
  }
  return { M: map };
}

/** 日ごとのアイテムを直接入れる（dynamodb-keys.md「アイテム」の属性の形） */
async function putDay(day: string, version: number, intervals: SeedInterval[]): Promise<void> {
  await client.send(
    new PutItemCommand({
      TableName: store.tableName,
      Item: {
        pk: { S: `DAY#${day}` },
        sk: { S: "META" },
        version: { N: String(version) },
        intervals: { L: intervals.map(seedIntervalAttribute) },
      },
    }),
  );
}

/** ほかの書き込みがあったことにする：版番号を1増やし、占有区間を足す（アイテムがなければ版番号1で作る） */
async function bumpDay(day: string, added: SeedInterval[] = []): Promise<void> {
  await client.send(
    new UpdateItemCommand({
      TableName: store.tableName,
      Key: { pk: { S: `DAY#${day}` }, sk: { S: "META" } },
      UpdateExpression:
        "SET version = if_not_exists(version, :zero) + :one, intervals = list_append(if_not_exists(intervals, :empty), :added)",
      ExpressionAttributeValues: {
        ":zero": { N: "0" },
        ":one": { N: "1" },
        ":empty": { L: [] },
        ":added": { L: added.map(seedIntervalAttribute) },
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

// 承認済みの仮予約 P 10/20 13:00–15:00（占有区間 13:00–16:00）。承認の保存はこの PR の範囲外なので直接入れる
const provisionalP: SeedInterval = {
  kind: "reservation",
  id: "seed-provisional-p",
  status: "provisional",
  start: "2026-10-20T13:00",
  end: "2026-10-20T16:00",
};

// ブロック枠 10/20 15:00–17:00、バッファ1時間（占有区間 15:00–18:00）
const block: SeedInterval = {
  kind: "block",
  id: "seed-block-1",
  start: "2026-10-20T15:00",
  end: "2026-10-20T18:00",
};

// ---- テスト ----

describe("申込の保存", () => {
  it("本予約申込 10/20 10:00–12:00：承認待ち（本）の META、PII、履歴、DAY#2026-10-20（占有区間 10:00–13:00、版番号1）が書かれる", async () => {
    const id = await saveOk(application("firm", "2026-10-20T10:00", "2026-10-20T12:00"));

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
    expect(historyAt.toMillis()).toBe(now.toMillis());
    expect(items).toHaveLength(3);

    const day = await dayItem("2026-10-20");
    expect(day?.["version"]).toBe(1);
    expect(await storedIntervals("2026-10-20")).toEqual([
      expectedInterval({
        kind: "reservation",
        id,
        status: "pending-firm",
        start: "2026-10-20T10:00",
        end: "2026-10-20T13:00",
      }),
    ]);
    // かからない日のアイテムは作らない
    expect(await dayItem("2026-10-19")).toBeUndefined();
    expect(await dayItem("2026-10-21")).toBeUndefined();
  });

  it("本予約申込を保存すると、予約の詳細を読み出せる：承認待ち（本）、バッファ60分、経路はフォーム、申込の内容と見積、確定金額なし、作成・更新は現在時刻、履歴は申込1件", async () => {
    const id = await saveOk(application("firm", "2026-10-20T10:00", "2026-10-20T12:00"));

    const detail = await getReservation(store, id);
    expect(detail).not.toBeNull();
    if (detail === null) return;
    expect(detail.id).toBe(id);
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
      subtotalExcludingTax: Yen.parse(10_000),
      estimateIncludingTax: Yen.parse(11_000),
    });
    expect(detail.confirmedPrice).toBeUndefined();
    expect(detail.provisionalIds).toBeUndefined();
    expect(detail.createdAt.toMillis()).toBe(now.toMillis());
    expect(detail.updatedAt.toMillis()).toBe(now.toMillis());
    expect(detail.customer).toEqual(customer);
    expect(detail.shooting).toEqual(shooting);

    expect(detail.history).toHaveLength(1);
    const entry = detail.history[0];
    expect(entry?.at.toMillis()).toBe(now.toMillis());
    expect(entry?.actor).toEqual({ kind: "customer" });
    expect(entry?.operation).toBe("apply");
    expect(entry?.before).toBeUndefined();
    expect(entry?.after?.status).toBe("pending-firm");
    expect(entry?.after?.start.toMillis()).toBe(jst("2026-10-20T10:00").toMillis());
    expect(entry?.after?.end.toMillis()).toBe(jst("2026-10-20T12:00").toMillis());
    expect(entry?.after?.bufferMinutes).toBe(60);
  });

  it("仮予約申込 10/20 10:00–12:00：承認待ち（仮）で保存され、日ごとのアイテムの状態も承認待ち（仮）", async () => {
    const id = await saveOk(application("provisional", "2026-10-20T10:00", "2026-10-20T12:00"));

    expect((await getReservation(store, id))?.status).toBe("pending-provisional");
    expect(await storedIntervals("2026-10-20")).toEqual([
      expectedInterval({
        kind: "reservation",
        id,
        status: "pending-provisional",
        start: "2026-10-20T10:00",
        end: "2026-10-20T13:00",
      }),
    ]);
    expect((await itemsOf(id)).map((item) => String(item["sk"])).sort()).toEqual(
      expect.arrayContaining(["META", "PII"]),
    );
  });

  it("承認済みの仮予約 P 13:00–15:00 があるときの第二キープ申込 14:00–17:00：承認待ち（第二キープ）で保存され、P の id を持つ（予約の詳細・履歴・日ごとのアイテム）", async () => {
    await putDay("2026-10-20", 1, [provisionalP]);

    const id = await saveOk(application("second-hold", "2026-10-20T14:00", "2026-10-20T17:00"));

    const detail = await getReservation(store, id);
    expect(detail?.status).toBe("pending-second-hold");
    expect(detail?.provisionalIds).toEqual([provisionalP.id]);
    expect(detail?.history[0]?.after?.provisionalIds).toEqual([provisionalP.id]);

    expect((await dayItem("2026-10-20"))?.["version"]).toBe(2);
    expect((await storedIntervals("2026-10-20")).sort(byStart)).toEqual([
      expectedInterval(provisionalP),
      expectedInterval({
        kind: "reservation",
        id,
        status: "pending-second-hold",
        provisionalIds: [provisionalP.id],
        start: "2026-10-20T14:00",
        end: "2026-10-20T18:00",
      }),
    ]);
  });

  it("2件の承認済みの仮予約 P1 10:00–12:00・P2 15:00–17:00 にまたがる第二キープ申込 12:00–16:00：P1 と P2 の両方の id を持つ", async () => {
    const p1: SeedInterval = {
      kind: "reservation",
      id: "seed-provisional-p1",
      status: "provisional",
      start: "2026-10-20T10:00",
      end: "2026-10-20T13:00",
    };
    const p2: SeedInterval = {
      kind: "reservation",
      id: "seed-provisional-p2",
      status: "provisional",
      start: "2026-10-20T15:00",
      end: "2026-10-20T18:00",
    };
    await putDay("2026-10-20", 1, [p1, p2]);

    const id = await saveOk(application("second-hold", "2026-10-20T12:00", "2026-10-20T16:00"));

    expect([...((await getReservation(store, id))?.provisionalIds ?? [])].sort()).toEqual(
      [p1.id, p2.id].sort(),
    );
  });

  it("予約の META に GSI のキーが入る：gsi1pk は STATUS#<状態>、gsi1sk は開始日時（UTC）。GSI で承認待ちの予約を引ける", async () => {
    const id = await saveOk(application("firm", "2026-10-20T10:00", "2026-10-20T12:00"));

    const meta = await getItem(`RES#${id}`, "META");
    expect(meta?.["gsi1pk"]).toBe("STATUS#pending-firm");
    expectUtcInstant(meta?.["gsi1sk"], "2026-10-20T10:00");

    const res = await client.send(
      new QueryCommand({
        TableName: store.tableName,
        IndexName: "gsi1",
        KeyConditionExpression: "gsi1pk = :pk",
        ExpressionAttributeValues: { ":pk": { S: "STATUS#pending-firm" } },
      }),
    );
    expect((res.Items ?? []).map((item) => plainItem(item)["pk"])).toEqual([`RES#${id}`]);
  });

  it("日ごとのアイテムがあるとき：版番号を1増やし、占有区間を足す（すでにある占有区間は残す）", async () => {
    await putDay("2026-10-20", 5, [block]);

    const id = await saveOk(application("firm", "2026-10-20T10:00", "2026-10-20T12:00"));

    expect((await dayItem("2026-10-20"))?.["version"]).toBe(6);
    expect((await storedIntervals("2026-10-20")).sort(byStart)).toEqual([
      expectedInterval({
        kind: "reservation",
        id,
        status: "pending-firm",
        start: "2026-10-20T10:00",
        end: "2026-10-20T13:00",
      }),
      expectedInterval(block),
    ]);
  });

  it("同じ日に重ならない申込を続けて2件：版番号は2になり、占有区間は2件", async () => {
    const a = await saveOk(application("firm", "2026-10-20T08:00", "2026-10-20T10:00"));
    const b = await saveOk(application("provisional", "2026-10-20T11:00", "2026-10-20T13:00"));

    expect(a).not.toBe(b);
    expect((await dayItem("2026-10-20"))?.["version"]).toBe(2);
    expect((await storedIntervals("2026-10-20")).map((i) => i.id).sort()).toEqual([a, b].sort());
  });
});

describe("重なる申込は保存されない（INV-1）", () => {
  /** 不可のときに何も書かれていないことを確かめるため、テーブルの中身をそのまま比べる */
  async function expectNothingWritten(before: PlainItem[]): Promise<void> {
    const after = await scanAll();
    const key = (item: PlainItem) => `${String(item["pk"])} ${String(item["sk"])}`;
    expect([...after].sort((x, y) => key(x).localeCompare(key(y)))).toEqual(
      [...before].sort((x, y) => key(x).localeCompare(key(y))),
    );
  }

  it("承認待ち（本）10:00–12:00（占有区間 10:00–13:00）があるときの本予約申込 12:00–14:00：不可（重なる）。何も書かれない", async () => {
    await saveOk(application("firm", "2026-10-20T10:00", "2026-10-20T12:00"));
    const before = await scanAll();

    expect(await save(application("firm", "2026-10-20T12:00", "2026-10-20T14:00"))).toEqual({
      ok: false,
      reason: "overlaps-existing",
    });
    await expectNothingWritten(before);
  });

  it("承認待ち（本）10:00–12:00（占有区間 10:00–13:00）があるときの仮予約申込 13:00–15:00：受付（13:00で接するだけ）", async () => {
    await saveOk(application("firm", "2026-10-20T10:00", "2026-10-20T12:00"));

    expect(
      (await save(application("provisional", "2026-10-20T13:00", "2026-10-20T15:00"))).ok,
    ).toBe(true);
  });

  it("ブロック枠（占有区間 15:00–18:00）があるときの本予約申込 17:00–19:00：不可（重なる）。何も書かれない", async () => {
    await putDay("2026-10-20", 1, [block]);
    const before = await scanAll();

    expect(await save(application("firm", "2026-10-20T17:00", "2026-10-20T19:00"))).toEqual({
      ok: false,
      reason: "overlaps-existing",
    });
    await expectNothingWritten(before);
  });

  it("前の日から日をまたぐブロック枠（占有区間 10/19 22:00–10/20 02:00。両日のアイテムにある）があるときの本予約申込 10/20 01:00–05:00：不可（重なる）", async () => {
    const overnight: SeedInterval = {
      kind: "block",
      id: "seed-block-overnight",
      start: "2026-10-19T22:00",
      end: "2026-10-20T02:00",
    };
    await putDay("2026-10-19", 1, [overnight]);
    await putDay("2026-10-20", 1, [overnight]);
    const before = await scanAll();

    expect(await save(application("firm", "2026-10-20T01:00", "2026-10-20T05:00"))).toEqual({
      ok: false,
      reason: "overlaps-existing",
    });
    await expectNothingWritten(before);
  });

  it("承認済みの仮予約 P（占有区間 13:00–16:00）があるときの本予約申込 14:00–16:00：不可（重なる。仮予約と重なってよいのは第二キープだけ）", async () => {
    await putDay("2026-10-20", 1, [provisionalP]);
    const before = await scanAll();

    expect(await save(application("firm", "2026-10-20T14:00", "2026-10-20T16:00"))).toEqual({
      ok: false,
      reason: "overlaps-existing",
    });
    await expectNothingWritten(before);
  });

  it("承認待ち（仮）（占有区間 13:00–16:00）があるときの第二キープ申込 13:00–15:00：不可（承認待ちの仮予約とは重なれない）。何も書かれない", async () => {
    await saveOk(application("provisional", "2026-10-20T13:00", "2026-10-20T15:00"));
    const before = await scanAll();

    const result = await save(application("second-hold", "2026-10-20T13:00", "2026-10-20T15:00"));
    expect(result.ok).toBe(false);
    await expectNothingWritten(before);
  });

  it("P に第二キープ 14:00–17:00（占有区間 14:00–18:00）がすでにあるときの第二キープ申込 13:00–15:00：不可（第二キープどうしは重ならない）。何も書かれない", async () => {
    await putDay("2026-10-20", 1, [provisionalP]);
    await saveOk(application("second-hold", "2026-10-20T14:00", "2026-10-20T17:00"));
    const before = await scanAll();

    expect(await save(application("second-hold", "2026-10-20T13:00", "2026-10-20T15:00"))).toEqual({
      ok: false,
      reason: "overlaps-existing",
    });
    await expectNothingWritten(before);
  });

  it("第二キープ 14:00–17:00（占有区間 14:00–18:00）があるときの本予約申込 16:00–18:00：不可（第二キープと重なる）", async () => {
    await putDay("2026-10-20", 1, [provisionalP]);
    await saveOk(application("second-hold", "2026-10-20T14:00", "2026-10-20T17:00"));
    const before = await scanAll();

    expect(await save(application("firm", "2026-10-20T16:00", "2026-10-20T18:00"))).toEqual({
      ok: false,
      reason: "overlaps-existing",
    });
    await expectNothingWritten(before);
  });

  it("仮予約 P（占有区間 13:00–16:00）があるときの第二キープ申込 14:00–17:00。ただし 17:00–19:00 に本予約がある：不可（本予約と重なる）。何も書かれない", async () => {
    await putDay("2026-10-20", 1, [provisionalP]);
    await saveOk(application("firm", "2026-10-20T17:00", "2026-10-20T19:00"));
    const before = await scanAll();

    expect(await save(application("second-hold", "2026-10-20T14:00", "2026-10-20T17:00"))).toEqual({
      ok: false,
      reason: "overlaps-existing",
    });
    await expectNothingWritten(before);
  });

  it("仮予約 P（占有区間 13:00–16:00）があるときの第二キープ申込 18:00–20:00：第二キープとしては不可（どの仮予約とも重ならない）。何も書かれない", async () => {
    await putDay("2026-10-20", 1, [provisionalP]);
    const before = await scanAll();

    expect(await save(application("second-hold", "2026-10-20T18:00", "2026-10-20T20:00"))).toEqual({
      ok: false,
      reason: "no-provisional-to-hold",
    });
    await expectNothingWritten(before);
  });

  it("取消・終了の予約は枠を確保しない：取消（占有区間 10:00–13:00）と終了（占有区間 14:00–18:00）しかない日の本予約申込 10:00–16:00：受付", async () => {
    await putDay("2026-10-20", 3, [
      {
        kind: "reservation",
        id: "seed-cancelled",
        status: "cancelled",
        start: "2026-10-20T10:00",
        end: "2026-10-20T13:00",
      },
      {
        kind: "reservation",
        id: "seed-ended",
        status: "ended",
        provisionalIds: ["seed-provisional-gone"],
        start: "2026-10-20T14:00",
        end: "2026-10-20T18:00",
      },
    ]);

    expect((await save(application("firm", "2026-10-20T10:00", "2026-10-20T16:00"))).ok).toBe(true);
  });

  it("どの順に申込が来ても、受付になった予約の占有区間は互いに重ならず、不可の申込は受付の予約と重なっていて、日ごとのアイテムと予約の数が受付の数と合う（ランダムな申込を同時に送る）", async () => {
    // 申込の候補：10/20 00:00（JST）からの30分単位の開始、長さ2〜8時間（10/20〜10/21）
    const base = jst("2026-10-20T00:00");
    const applicationShape = fc.record({
      kind: fc.constantFrom<"firm" | "provisional">("firm", "provisional"),
      startSlot: fc.integer({ min: 0, max: 60 }),
      lengthSlots: fc.integer({ min: 4, max: 16 }),
    });

    await fc.assert(
      fc.asyncProperty(
        fc.array(applicationShape, { minLength: 2, maxLength: 6 }),
        async (shapes) => {
          const own = await createTable();
          try {
            const apps = shapes.map((shape) => {
              const start = base.plus({ minutes: shape.startSlot * 30 });
              const end = start.plus({ minutes: shape.lengthSlots * 30 });
              return application(shape.kind, start.toISO() ?? "", end.toISO() ?? "");
            });
            const results = await Promise.all(
              apps.map((app) => saveApplication(own, app, { now, maxAttempts: apps.length + 1 })),
            );

            const occupied = (app: ReservationApplication) => ({
              start: app.start.toMillis(),
              end: app.end.plus({ minutes: 60 }).toMillis(),
            });
            const overlaps = (
              a: { start: number; end: number },
              b: { start: number; end: number },
            ) => a.start < b.end && b.start < a.end;

            const accepted = apps.filter((_, i) => results[i]?.ok === true);
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
              const app = apps[i];
              if (app === undefined || result.ok) return;
              // 混み合っている（busy）ときは、何も書かないことだけを求める（下の数の確認）
              if (result.reason === "overlaps-existing") {
                expect(accepted.some((other) => overlaps(occupied(app), occupied(other)))).toBe(
                  true,
                );
              } else {
                expect(result.reason).toBe("busy");
              }
            });

            const acceptedIds = results.flatMap((result) => (result.ok ? [result.id] : []));
            const res = await client.send(
              new ScanCommand({ TableName: own.tableName, ConsistentRead: true }),
            );
            const items = (res.Items ?? []).map(plainItem);
            const metas = items.filter(
              (item) => String(item["pk"]).startsWith("RES#") && item["sk"] === "META",
            );
            expect(metas.map((item) => String(item["pk"])).sort()).toEqual(
              acceptedIds.map((id) => `RES#${id}`).sort(),
            );
            const dayIds = new Set(
              items
                .filter((item) => String(item["pk"]).startsWith("DAY#"))
                .flatMap((item) => (item["intervals"] as PlainItem[]).map((i) => String(i["id"]))),
            );
            expect([...dayIds].sort()).toEqual([...acceptedIds].sort());
          } finally {
            await deleteTable(own);
          }
        },
      ),
      { numRuns: 15 },
    );
  }, 120_000);
});

describe("同時の申込（INV-1）", () => {
  it("同じ時間 10/20 10:00–12:00 への本予約申込2件を同時に送る：片方だけ受付、もう片方は不可。予約は1件、占有区間は1件", async () => {
    const results = await Promise.all([
      save(application("firm", "2026-10-20T10:00", "2026-10-20T12:00"), { maxAttempts: 3 }),
      save(application("firm", "2026-10-20T10:00", "2026-10-20T12:00"), { maxAttempts: 3 }),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "overlaps-existing" }]);
    expect((await reservationItems()).filter((item) => item["sk"] === "META")).toHaveLength(1);
    expect(await storedIntervals("2026-10-20")).toHaveLength(1);
  });

  it("同じ時間への仮予約申込と本予約申込を、どちらも読んで判定してから書くように同時に送る：片方だけ受付、もう片方は読み直して不可", async () => {
    const meet = meetBeforeFirstWrite(2);
    const results = await Promise.all([
      save(application("provisional", "2026-10-20T10:00", "2026-10-20T12:00"), {
        maxAttempts: 3,
        beforeWrite: meet,
      }),
      save(application("firm", "2026-10-20T11:00", "2026-10-20T13:00"), {
        maxAttempts: 3,
        beforeWrite: meet,
      }),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "overlaps-existing" }]);
    const winner = results.find((r) => r.ok);
    const intervals = await storedIntervals("2026-10-20");
    expect(intervals.map((i) => i.id)).toEqual([winner?.ok === true ? winner.id : "?"]);
    expect((await dayItem("2026-10-20"))?.["version"]).toBe(1);
    expect((await reservationItems()).filter((item) => item["sk"] === "META")).toHaveLength(1);
  });

  it("同じ日の重ならない2件 10/20 08:00–10:00 と 10/20 14:00–16:00 を、どちらも読んで判定してから書くように同時に送る：両方とも受付（版番号の衝突は読み直してやり直す）。版番号は2、占有区間は2件", async () => {
    const meet = meetBeforeFirstWrite(2);
    const results = await Promise.all([
      save(application("firm", "2026-10-20T08:00", "2026-10-20T10:00"), {
        maxAttempts: 3,
        beforeWrite: meet,
      }),
      save(application("provisional", "2026-10-20T14:00", "2026-10-20T16:00"), {
        maxAttempts: 3,
        beforeWrite: meet,
      }),
    ]);

    expect(results.map((r) => r.ok)).toEqual([true, true]);
    expect((await dayItem("2026-10-20"))?.["version"]).toBe(2);
    const ids = results.flatMap((r) => (r.ok ? [r.id] : []));
    expect((await storedIntervals("2026-10-20")).map((i) => i.id).sort()).toEqual(ids.sort());
    expect((await reservationItems()).filter((item) => item["sk"] === "META")).toHaveLength(2);
  });

  it("同じ日の重ならない2件を同時に送る（待ち合わせなし）：両方とも受付", async () => {
    const results = await Promise.all([
      save(application("firm", "2026-10-20T08:00", "2026-10-20T10:00"), { maxAttempts: 3 }),
      save(application("firm", "2026-10-20T14:00", "2026-10-20T16:00"), { maxAttempts: 3 }),
    ]);

    expect(results.map((r) => r.ok)).toEqual([true, true]);
    expect((await dayItem("2026-10-20"))?.["version"]).toBe(2);
    expect(await storedIntervals("2026-10-20")).toHaveLength(2);
  });
});

describe("途中で失敗したら何も残らない（INV-2）", () => {
  it("書く直前に毎回ほかの書き込みで版番号が進み、やり直しの上限（3回）を超える：混み合っている。予約・個人情報・履歴は残らず、日ごとのアイテムは版番号だけが進む", async () => {
    // 申込 10/20 22:00–10/21 02:00（占有区間 22:00–03:00）は 10/20 と 10/21 にかかる。
    // 10/21 のアイテムだけが毎回書き換わるので、10/20 のアイテムへの書き込みだけが残ってはいけない
    await putDay("2026-10-20", 1, [block]);
    await putDay("2026-10-21", 4, []);
    let calls = 0;

    const result = await save(application("firm", "2026-10-20T22:00", "2026-10-21T02:00"), {
      maxAttempts: 3,
      beforeWrite: async () => {
        calls += 1;
        await bumpDay("2026-10-21");
      },
    });

    expect(result).toEqual({ ok: false, reason: "busy" });
    expect(calls).toBe(3);
    expect(await reservationItems()).toEqual([]);
    expect((await dayItem("2026-10-20"))?.["version"]).toBe(1);
    expect(await storedIntervals("2026-10-20")).toEqual([expectedInterval(block)]);
    expect((await dayItem("2026-10-21"))?.["version"]).toBe(4 + 3);
    expect(await storedIntervals("2026-10-21")).toEqual([]);
  });

  it("まだない日のアイテムを、書く直前に毎回ほかの書き込みが作る・進める（上限1回）：混み合っている。予約・個人情報・履歴は残らない", async () => {
    let calls = 0;

    const result = await save(application("firm", "2026-10-20T10:00", "2026-10-20T12:00"), {
      maxAttempts: 1,
      beforeWrite: async () => {
        calls += 1;
        await bumpDay("2026-10-20");
      },
    });

    expect(result).toEqual({ ok: false, reason: "busy" });
    expect(calls).toBe(1);
    expect(await reservationItems()).toEqual([]);
    expect((await dayItem("2026-10-20"))?.["version"]).toBe(1);
    expect(await storedIntervals("2026-10-20")).toEqual([]);
  });

  it("まだない日のアイテムを、1回目の書く直前にほかの書き込みが作る：読み直してやり直し、受付。版番号は2", async () => {
    let calls = 0;

    const result = await save(application("firm", "2026-10-20T10:00", "2026-10-20T12:00"), {
      maxAttempts: 3,
      beforeWrite: async (attempt) => {
        calls += 1;
        if (attempt === 1) await bumpDay("2026-10-20");
      },
    });

    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
    expect((await dayItem("2026-10-20"))?.["version"]).toBe(2);
    expect(await storedIntervals("2026-10-20")).toHaveLength(1);
  });

  it("1回目の書く直前に、ほかの書き込みが重なるブロック枠を入れる：読み直して判定し、不可。予約・個人情報・履歴は残らず、日ごとのアイテムはほかの書き込みのまま", async () => {
    await putDay("2026-10-20", 1, []);
    const overlapping: SeedInterval = {
      kind: "block",
      id: "seed-block-late",
      start: "2026-10-20T11:00",
      end: "2026-10-20T12:00",
    };

    const result = await save(application("firm", "2026-10-20T10:00", "2026-10-20T12:00"), {
      maxAttempts: 3,
      beforeWrite: async (attempt) => {
        if (attempt === 1) await bumpDay("2026-10-20", [overlapping]);
      },
    });

    expect(result).toEqual({ ok: false, reason: "overlaps-existing" });
    expect(await reservationItems()).toEqual([]);
    expect((await dayItem("2026-10-20"))?.["version"]).toBe(2);
    expect(await storedIntervals("2026-10-20")).toEqual([expectedInterval(overlapping)]);
  });
});

describe("個人情報は予約の META・日ごとのアイテム・履歴に入らない（INV-10）", () => {
  it("本予約申込・第二キープ申込を保存したあと：お客様の情報と撮影の内容（自由記述）の値は PII のアイテムにだけあり、META・DAY#・HIST# のどのアイテムにもない", async () => {
    await putDay("2026-10-20", 1, [provisionalP]);
    const firm = await saveOk(application("firm", "2026-10-20T22:00", "2026-10-21T02:00"));
    const secondHold = await saveOk(
      application("second-hold", "2026-10-20T14:00", "2026-10-20T17:00"),
    );

    const items = await scanAll();
    const notPii = items.filter((item) => item["sk"] !== "PII");
    expect(notPii.some((item) => String(item["pk"]).startsWith("DAY#"))).toBe(true);
    expect(notPii.some((item) => String(item["sk"]).startsWith("HIST#"))).toBe(true);
    for (const item of notPii) {
      expectNoPersonalInfo(item);
    }

    for (const id of [firm, secondHold]) {
      const pii = await getItem(`RES#${id}`, "PII");
      const strings = stringsIn(pii);
      for (const personal of personalValues) {
        expect(strings).toContain(personal);
      }
    }
  });
});

describe("日時（INV-7）", () => {
  it("本予約申込 10/20 08:00–10:00（UTC では 10/19 23:00–10/20 01:00）：日ごとのアイテムは JST の DAY#2026-10-20 だけ。META と履歴の日時は UTC", async () => {
    const id = await saveOk(application("firm", "2026-10-20T08:00", "2026-10-20T10:00"));

    expect(await dayItem("2026-10-19")).toBeUndefined();
    expect(await storedIntervals("2026-10-20")).toEqual([
      expectedInterval({
        kind: "reservation",
        id,
        status: "pending-firm",
        start: "2026-10-20T08:00",
        end: "2026-10-20T11:00",
      }),
    ]);

    // META と履歴の中の日時の値は、どれも UTC で表されている
    for (const item of await itemsOf(id)) {
      if (item["sk"] === "PII") continue;
      for (const s of stringsIn(item)) {
        const parsed = DateTime.fromISO(s, { setZone: true });
        if (/^\d{4}-\d{2}-\d{2}T/.test(s) && parsed.isValid) {
          expect(parsed.offset).toBe(0);
        }
      }
    }
    const meta = await getItem(`RES#${id}`, "META");
    const instants = stringsIn(meta)
      .map((s) => DateTime.fromISO(s, { setZone: true }))
      .filter((d) => d.isValid)
      .map((d) => d.toMillis());
    expect(instants).toContain(jst("2026-10-20T08:00").toMillis());
    expect(instants).toContain(jst("2026-10-20T10:00").toMillis());
    expect(instants).toContain(now.toMillis());
  });

  it("本予約申込 10/20 22:00–10/21 02:00（占有区間 22:00–03:00。UTC では同じ 10/20）：DAY#2026-10-20 と DAY#2026-10-21 の両方に、同じ占有区間を切らずに入れる", async () => {
    const id = await saveOk(application("firm", "2026-10-20T22:00", "2026-10-21T02:00"));

    const expected = expectedInterval({
      kind: "reservation",
      id,
      status: "pending-firm",
      start: "2026-10-20T22:00",
      end: "2026-10-21T03:00",
    });
    expect(await storedIntervals("2026-10-20")).toEqual([expected]);
    expect(await storedIntervals("2026-10-21")).toEqual([expected]);
    expect((await dayItem("2026-10-20"))?.["version"]).toBe(1);
    expect((await dayItem("2026-10-21"))?.["version"]).toBe(1);
    expect(await dayItem("2026-10-22")).toBeUndefined();
  });

  it("本予約申込 10/20 23:30–10/21 23:30（24時間。占有区間 10/20 23:30–10/22 00:30）：DAY#2026-10-20、DAY#2026-10-21、DAY#2026-10-22 の3日に入れる", async () => {
    const id = await saveOk(application("firm", "2026-10-20T23:30", "2026-10-21T23:30"));

    const expected = expectedInterval({
      kind: "reservation",
      id,
      status: "pending-firm",
      start: "2026-10-20T23:30",
      end: "2026-10-22T00:30",
    });
    for (const day of ["2026-10-20", "2026-10-21", "2026-10-22"]) {
      expect(await storedIntervals(day)).toEqual([expected]);
    }
    expect(await dayItem("2026-10-19")).toBeUndefined();
    expect(await dayItem("2026-10-23")).toBeUndefined();
  });

  it("同じ申込 10/20 22:00–10/21 02:00 を UTC で表した日時（10/20 13:00–17:00Z）で渡し、現在時刻も UTC で渡す：JST で渡したときと同じ日ごとのアイテムに、同じ占有区間が入る", async () => {
    const app = application("firm", "2026-10-20T22:00", "2026-10-21T02:00");
    const id = await saveOk(
      { ...app, start: app.start.toUTC(), end: app.end.toUTC() },
      { now: now.toUTC() },
    );

    const expected = expectedInterval({
      kind: "reservation",
      id,
      status: "pending-firm",
      start: "2026-10-20T22:00",
      end: "2026-10-21T03:00",
    });
    expect(await storedIntervals("2026-10-20")).toEqual([expected]);
    expect(await storedIntervals("2026-10-21")).toEqual([expected]);
    expect((await getReservation(store, id))?.createdAt.toMillis()).toBe(now.toMillis());
  });

  it("重なりの判定も JST の日で読む：UTC で表した申込 10/20 01:00–05:00（JST）でも、前の日から日をまたぐブロック枠（占有区間 10/19 22:00–10/20 02:00）と重なって不可", async () => {
    const overnight: SeedInterval = {
      kind: "block",
      id: "seed-block-overnight",
      start: "2026-10-19T22:00",
      end: "2026-10-20T02:00",
    };
    await putDay("2026-10-19", 1, [overnight]);
    await putDay("2026-10-20", 1, [overnight]);
    const app = application("firm", "2026-10-20T01:00", "2026-10-20T05:00");

    expect(await save({ ...app, start: app.start.toUTC(), end: app.end.toUTC() })).toEqual({
      ok: false,
      reason: "overlaps-existing",
    });
  });
});

describe("読み出し", () => {
  function normalizeRead(interval: Awaited<ReturnType<typeof readOccupiedIntervals>>[number]) {
    return {
      kind: interval.kind,
      id: interval.id,
      status: interval.status,
      provisionalIds:
        interval.provisionalIds === undefined ? undefined : [...interval.provisionalIds],
      start: interval.start.toMillis(),
      end: interval.end.toMillis(),
    };
  }

  it("期間 10/20〜10/21 の占有区間を読む：予約・第二キープ・ブロック枠が、日をまたぐものも1件ずつ返り、期間の外の日（10/22）のものは返らない", async () => {
    await putDay("2026-10-20", 1, [provisionalP, block]);
    await putDay("2026-10-22", 1, [
      { kind: "block", id: "seed-block-later", start: "2026-10-22T10:00", end: "2026-10-22T12:00" },
    ]);
    const secondHold = await saveOk(
      application("second-hold", "2026-10-20T12:00", "2026-10-20T14:00"),
    );
    const overnight = await saveOk(application("firm", "2026-10-20T22:00", "2026-10-21T02:00"));

    const intervals = await readOccupiedIntervals(store, { from: "2026-10-20", to: "2026-10-21" });

    expect(intervals.map(normalizeRead).sort(byStart)).toEqual(
      [
        expectedInterval(provisionalP),
        expectedInterval({
          kind: "reservation",
          id: secondHold,
          status: "pending-second-hold",
          provisionalIds: [provisionalP.id],
          start: "2026-10-20T12:00",
          end: "2026-10-20T15:00",
        }),
        expectedInterval(block),
        expectedInterval({
          kind: "reservation",
          id: overnight,
          status: "pending-firm",
          start: "2026-10-20T22:00",
          end: "2026-10-21T03:00",
        }),
      ].sort(byStart),
    );
  });

  it("期間 10/21〜10/21 を読む：前の日から日をまたぐ予約（占有区間 10/20 22:00–10/21 03:00）は返り、10/20 だけの予約は返らない", async () => {
    await saveOk(application("firm", "2026-10-20T10:00", "2026-10-20T12:00"));
    const overnight = await saveOk(application("firm", "2026-10-20T22:00", "2026-10-21T02:00"));

    const intervals = await readOccupiedIntervals(store, { from: "2026-10-21", to: "2026-10-21" });

    expect(intervals.map((i) => i.id)).toEqual([overnight]);
  });

  it("日ごとのアイテムがない期間を読む：空の一覧", async () => {
    expect(await readOccupiedIntervals(store, { from: "2026-11-01", to: "2026-11-30" })).toEqual(
      [],
    );
  });

  it("ない id の予約の詳細を読む：null", async () => {
    await saveOk(application("firm", "2026-10-20T10:00", "2026-10-20T12:00"));

    expect(await getReservation(store, "no-such-reservation")).toBeNull();
  });

  it("会社名・補足事項が空の申込を保存して読む：お客様の情報と撮影の内容は、渡したとおり（会社名・補足事項はない）", async () => {
    const withoutCompany = {
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
      address: customer.address,
      photographerName: customer.photographerName,
    };
    const withoutNotes = { types: shooting.types, details: shooting.details };
    const id = await saveOk(
      application("firm", "2026-10-20T10:00", "2026-10-20T12:00", {
        customer: withoutCompany,
        shooting: withoutNotes,
      }),
    );

    const detail = await getReservation(store, id);
    expect(detail?.customer).toEqual(withoutCompany);
    expect(detail?.customer.companyName).toBeUndefined();
    expect(detail?.shooting).toEqual(withoutNotes);
    expect(detail?.shooting.notes).toBeUndefined();
  });
});
