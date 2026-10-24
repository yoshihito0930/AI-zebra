import {
  type AttributeValue,
  CreateTableCommand,
  DeleteTableCommand,
  GetItemCommand,
  PutItemCommand,
  ScanCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { Yen } from "@zebra/contracts";
import fc from "fast-check";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AdminBlockBufferMinutes,
  type AdminBlockInput,
  type SaveBlockOptions,
  deleteAdminBlock,
  getBlock,
  saveAdminBlock,
  updateAdminBlock,
} from "./blocks.ts";
import { createLocalDynamoClient } from "./client.ts";
import { saveDirectEntry } from "./direct-entry.ts";
import { saveReservationOperation } from "./operations.ts";
import {
  type ApplicationKind,
  type ReservationApplication,
  type ReservationStore,
  saveApplication,
} from "./reservations.ts";

// ブロック枠の保存（管理者が入れる・消す・直す）の統合テスト（DynamoDB Local）。
// 根拠：docs/product-specs/booking.md「管理者による予約の直接入力とブロック枠」の「ブロック枠のバッファ」
// 「ブロック枠を消す・直す」と例の表、dynamodb-keys.md（アイテム、書き込み）、core-beliefs.md（INV-1、INV-2、INV-7）。
// 30分単位と空き判定の細かい決まりは booking-core の単体テスト（blocks.test.ts の checkAdminBlock）で確かめているので、
// ここでは代表的な場合と、それが1回の書き込みで DB に残ること（残らないこと）を確かめる。
// 最長90日（占有区間がかかる JST の日。直すときは直す前と直したあとのかかる日を合わせて）は、保存の層で確かめる。
// 90日は、ブロック枠がかかる日をすべて1トランザクションで書くための決まり（dynamodb-keys.md「書き込み」）で、
// 保存の層が書く日ごとのアイテムの数そのものだから。booking-core の checkAdminBlock は長さを見ない（変えない）。
// ブロック枠の META の属性名は資料にないので、ブロック枠の読み出し（getBlock）とアイテムのキーで確かめる。
// 直接見る属性は、資料にある pk・sk・version・intervals（kind・id・status・start・end・bufferMinutes）だけ。
// Googleカレンダーから取り込んだブロック枠は、取り込みの保存がまだないので、資料の形（id は gcal-<イベントの id>、
// 日ごとのアイテムの占有区間）でテストから直接入れる。管理者が触れないことは id（gcal-…）で決まる。

const client = createLocalDynamoClient();
let store: ReservationStore;

// テーブルはキー設計どおり（pk・sk、GSI の gsi1pk・gsi1sk）にテストごとに作り、終わったら消す
async function createTable(): Promise<ReservationStore> {
  const tableName = `int-test-blk-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
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

/** 申込の時刻（固定）。申込の日時は、締め切りにかからないよう十分先に置く（締め切りは API の層で判定する） */
const appliedAt = jst("2026-10-01T12:00");
/** 準備でする承認・直接入力の時刻（固定） */
const preparedAt = jst("2026-10-02T12:00");

/** 操作した管理者（架空のユーザー id） */
const adminUserId = "admin-user-kaku-1";

type ToZone = (d: DateTime) => DateTime;

/** JST で渡すか、同じ時点を UTC で渡すか（INV-7）。例の表の行は、両方で確かめる */
const zoneVariants: readonly (readonly [string, ToZone])[] = [
  ["JST", (d) => d],
  ["UTC", (d) => d.toUTC()],
];

/**
 * 書き込みのある行を、JST で渡す場合と UTC で渡す場合のそれぞれで、空のテーブルから確かめる
 * （2回目の前に、テーブルを作り直す）
 */
async function inEachZone(body: (zone: string, toZone: ToZone) => Promise<void>): Promise<void> {
  let first = true;
  for (const [zone, toZone] of zoneVariants) {
    if (!first) {
      await deleteTable(store);
      store = await createTable();
    }
    first = false;
    await body(zone, toZone);
  }
}

// ---- 準備の道具（架空のお客様の情報） ----

const customer = {
  name: "架空 四郎",
  email: "shiro.kaku@example.com",
  phone: "090-0000-3456",
  address: "架空県架空市架空浜1-2-3",
  photographerName: "仮名 撮影三郎",
} as const;

const shooting = { types: ["still"], details: "架空の撮影詳細：ブロック枠のテストの準備" } as const;

function application(
  kind: ApplicationKind,
  start: DateTime | string,
  end: DateTime | string,
): ReservationApplication {
  return {
    kind,
    start: typeof start === "string" ? jst(start) : start,
    end: typeof end === "string" ? jst(end) : end,
    partySize: 2,
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

/** 申込して承認する（準備） */
async function applyApproved(kind: ApplicationKind, start: string, end: string): Promise<string> {
  const applied = await saveApplication(store, application(kind, start, end), { now: appliedAt });
  if (!applied.ok) {
    throw new Error(`準備の申込が不可になった（${kind} ${start}–${end}、${applied.reason}）`);
  }
  const approved = await saveReservationOperation(
    store,
    { kind: "approve", reservationId: applied.id, confirmedPrice: Yen.parse(22_000) },
    { now: preparedAt, adminUserId },
  );
  if (!approved.ok) {
    throw new Error(`準備の承認が不可になった（${approved.reason}）`);
  }
  return applied.id;
}

function block(
  start: string,
  end: string,
  bufferMinutes: AdminBlockBufferMinutes,
  toZone: ToZone = (d) => d,
  memo?: string,
): AdminBlockInput {
  return {
    start: toZone(jst(start)),
    end: toZone(jst(end)),
    bufferMinutes,
    ...(memo === undefined ? {} : { memo }),
  };
}

async function saveBlockOk(input: AdminBlockInput, options?: SaveBlockOptions): Promise<string> {
  const result = await saveAdminBlock(store, input, options);
  if (!result.ok) {
    throw new Error(`入るはずのブロック枠が不可になった（${result.reason}）`);
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

async function scanTable(target: ReservationStore): Promise<PlainItem[]> {
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

async function scanAll(): Promise<PlainItem[]> {
  return scanTable(store);
}

function itemKey(item: PlainItem): string {
  return `${String(item["pk"])} ${String(item["sk"])}`;
}

function sortedItems(items: readonly PlainItem[]): PlainItem[] {
  return [...items].sort((x, y) => itemKey(x).localeCompare(itemKey(y)));
}

/** 不可の操作・途中で失敗した操作で、テーブルの中身が何も変わっていないことを確かめる */
async function expectNothingWritten(before: readonly PlainItem[], message?: string): Promise<void> {
  expect(sortedItems(await scanAll()), message).toEqual(sortedItems(before));
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

async function dayItem(day: string): Promise<PlainItem | undefined> {
  return getItem(`DAY#${day}`, "META");
}

/** そのブロック枠の pk（BLK#<id>）を持つアイテムの sk の一覧。記録（履歴）を残さないので、あるのは META だけ */
async function blockItemSks(id: string): Promise<string[]> {
  return (await scanAll())
    .filter((item) => item["pk"] === `BLK#${id}`)
    .map((item) => String(item["sk"]));
}

/** 占有区間が入っている日ごとのアイテムの日付（JST の YYYY-MM-DD）の一覧 */
async function daysHolding(id: string): Promise<string[]> {
  return (await scanAll())
    .filter((item) => String(item["pk"]).startsWith("DAY#"))
    .filter((item) => (item["intervals"] as PlainItem[]).some((stored) => stored["id"] === id))
    .map((item) => String(item["pk"]).slice("DAY#".length))
    .sort();
}

/** JST の日付 from から count 日分の YYYY-MM-DD */
function jstDays(from: string, count: number): string[] {
  const first = jst(`${from}T00:00`);
  return Array.from({ length: count }, (_, i) => first.plus({ days: i }).toFormat("yyyy-MM-dd"));
}

/** 日ごとのアイテムの占有区間の1件を、比べやすい形にする（開始・終わりは UTC で保存されていることも確かめる） */
interface NormalizedInterval {
  kind: unknown;
  id: unknown;
  status: unknown;
  start: number;
  end: number;
  bufferMinutes: unknown;
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
    start: start.toMillis(),
    end: end.toMillis(),
    bufferMinutes: map["bufferMinutes"],
  };
}

async function storedIntervals(day: string): Promise<NormalizedInterval[]> {
  const item = await dayItem(day);
  if (item === undefined) return [];
  return (item["intervals"] as unknown[]).map(normalizeStored);
}

/** 日ごとのアイテムに入るブロック枠の占有区間（start・end はバッファ込み。ブロック枠には状態がない） */
function blockInterval(
  id: string,
  start: string,
  end: string,
  bufferMinutes: AdminBlockBufferMinutes,
): NormalizedInterval {
  return {
    kind: "block",
    id,
    status: undefined,
    start: jst(start).toMillis(),
    end: jst(end).toMillis(),
    bufferMinutes,
  };
}

/** 読み出したブロック枠が、JST で書いた区間・バッファ・メモと同じかを確かめる */
async function expectBlock(
  id: string,
  expected: { start: string; end: string; bufferMinutes: AdminBlockBufferMinutes; memo?: string },
  message?: string,
): Promise<void> {
  const detail = await getBlock(store, id);
  expect(detail, message).not.toBeNull();
  expect(detail?.id, message).toBe(id);
  expect(detail?.route, message).toBe("admin");
  expect(detail?.start.toMillis(), message).toBe(jst(expected.start).toMillis());
  expect(detail?.end.toMillis(), message).toBe(jst(expected.end).toMillis());
  expect(detail?.bufferMinutes, message).toBe(expected.bufferMinutes);
  expect(detail?.memo, message).toBe(expected.memo);
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

// 例の表の行のうち、ブロック枠を消す・直す、最長90日の行（f331d1a で足した8行）。ほかの行は booking-core の単体テストにある。
// 例の表には年がない行は 2026 年とし、日付のない行は 10/20 とする。バッファは、行に書かれていなければ初期値の「なし」
describe("管理者による予約の直接入力とブロック枠", () => {
  it("管理者が休業のブロック枠 2026/10/20 00:00–2027/01/18 00:00 をバッファなしで入れる：入る（かかる日がちょうど90日）", async () => {
    await inEachZone(async (zone, toZone) => {
      const id = await saveBlockOk(
        block("2026-10-20T00:00", "2027-01-18T00:00", 0, toZone, "休業"),
      );

      // 占有区間 [2026/10/20 00:00, 2027/01/18 00:00) がかかる JST の日は 10/20〜01/17 の90日。
      // 01/18 00:00 で終わるので、DAY#2027-01-18 にはかからない
      const days = jstDays("2026-10-20", 90);
      expect(days.at(-1), zone).toBe("2027-01-17");
      expect(await daysHolding(id), zone).toEqual(days);
      const expected = blockInterval(id, "2026-10-20T00:00", "2027-01-18T00:00", 0);
      for (const day of [days[0] ?? "", days[45] ?? "", days[89] ?? ""]) {
        expect(await storedIntervals(day), `${zone} ${day}`).toEqual([expected]);
      }
      expect(await dayItem("2026-10-19"), zone).toBeUndefined();
      expect(await dayItem("2027-01-18"), zone).toBeUndefined();
      expect(await blockItemSks(id), zone).toEqual(["META"]);
      await expectBlock(
        id,
        { start: "2026-10-20T00:00", end: "2027-01-18T00:00", bufferMinutes: 0, memo: "休業" },
        zone,
      );
    });
  }, 60_000);

  it("管理者が休業のブロック枠 2026/10/20 00:00–2027/01/19 00:00 をバッファなしで入れる：不可（かかる日が90日を超える）", async () => {
    const before = await scanAll();
    for (const [zone, toZone] of zoneVariants) {
      expect(
        await saveAdminBlock(store, block("2026-10-20T00:00", "2027-01-19T00:00", 0, toZone)),
        zone,
      ).toEqual({ ok: false, reason: "more-than-90-days" });
      await expectNothingWritten(before, zone);
    }
  });

  it("管理者がブロック枠 10/20 15:00–16:00（バッファなし）を消したあとに、ウィジェットから 10/20 14:00–16:00 を申込む：予約可", async () => {
    await inEachZone(async (zone, toZone) => {
      const id = await saveBlockOk(block("2026-10-20T15:00", "2026-10-20T16:00", 0, toZone));
      const app = application(
        "firm",
        toZone(jst("2026-10-20T14:00")),
        toZone(jst("2026-10-20T16:00")),
      );
      // 消す前は、ブロック枠と重なるので不可（消すことで空きに戻ることを確かめるため）
      expect(await saveApplication(store, app, { now: toZone(appliedAt) }), zone).toEqual({
        ok: false,
        reason: "overlaps-existing",
      });

      expect(await deleteAdminBlock(store, id), zone).toEqual({ ok: true });

      expect(await getBlock(store, id), zone).toBeNull();
      expect(await blockItemSks(id), zone).toEqual([]);
      expect(await daysHolding(id), zone).toEqual([]);
      // 消したブロック枠の記録は残さない：どのアイテムにも、そのブロック枠の id はない
      for (const item of await scanAll()) {
        expect(stringsIn(item), `${zone} ${itemKey(item)}`).not.toContain(id);
      }
      const applied = await saveApplication(store, app, { now: toZone(appliedAt) });
      expect(applied.ok, zone).toBe(true);
    });
  });

  it("管理者がブロック枠 10/20 15:00–16:00（バッファなし）を 10/20 15:00–17:00 に直す：直る（直す前の自分の占有区間とは重なってよい）。占有区間は 15:00–17:00", async () => {
    await inEachZone(async (zone, toZone) => {
      const id = await saveBlockOk(block("2026-10-20T15:00", "2026-10-20T16:00", 0, toZone));

      expect(
        await updateAdminBlock(store, id, block("2026-10-20T15:00", "2026-10-20T17:00", 0, toZone)),
        zone,
      ).toEqual({ ok: true });

      expect(await storedIntervals("2026-10-20"), zone).toEqual([
        blockInterval(id, "2026-10-20T15:00", "2026-10-20T17:00", 0),
      ]);
      await expectBlock(
        id,
        { start: "2026-10-20T15:00", end: "2026-10-20T17:00", bufferMinutes: 0 },
        zone,
      );
      expect(await blockItemSks(id), zone).toEqual(["META"]);
    });
  });

  it("本予約 10/20 17:00–19:00 があるときに、管理者がブロック枠 10/20 15:00–16:00（バッファなし）を 10/20 16:00–18:00 に直す：不可（空き判定）。ブロック枠は直す前のまま", async () => {
    await applyApproved("firm", "2026-10-20T17:00", "2026-10-20T19:00");
    const id = await saveBlockOk(block("2026-10-20T15:00", "2026-10-20T16:00", 0));
    const before = await scanAll();

    for (const [zone, toZone] of zoneVariants) {
      expect(
        await updateAdminBlock(store, id, block("2026-10-20T16:00", "2026-10-20T18:00", 0, toZone)),
        zone,
      ).toEqual({ ok: false, reason: "overlaps-existing" });
      await expectNothingWritten(before, zone);
      await expectBlock(
        id,
        { start: "2026-10-20T15:00", end: "2026-10-20T16:00", bufferMinutes: 0 },
        zone,
      );
    }
  });

  it("管理者がブロック枠 10/20 15:00–16:00 のバッファを「なし」から「1時間」に直す：直る。占有区間は 15:00–17:00", async () => {
    await inEachZone(async (zone, toZone) => {
      const id = await saveBlockOk(block("2026-10-20T15:00", "2026-10-20T16:00", 0, toZone));

      expect(
        await updateAdminBlock(
          store,
          id,
          block("2026-10-20T15:00", "2026-10-20T16:00", 60, toZone),
        ),
        zone,
      ).toEqual({ ok: true });

      expect(await storedIntervals("2026-10-20"), zone).toEqual([
        blockInterval(id, "2026-10-20T15:00", "2026-10-20T17:00", 60),
      ]);
      await expectBlock(
        id,
        { start: "2026-10-20T15:00", end: "2026-10-20T16:00", bufferMinutes: 60 },
        zone,
      );
    });
  });

  it("管理者が休業のブロック枠 2026/10/20 00:00–2027/01/18 00:00 を 2027/01/18 00:00–2027/04/18 00:00 に直す：不可（直す前と直したあとのかかる日を合わせて90日を超える）。消して入れ直す", async () => {
    await inEachZone(async (zone, toZone) => {
      const id = await saveBlockOk(block("2026-10-20T00:00", "2027-01-18T00:00", 0, toZone));
      const before = await scanAll();

      // 直す前は 2026/10/20〜2027/01/17 の90日、直したあとは 2027/01/18〜2027/04/17 の90日。合わせて180日
      expect(
        await updateAdminBlock(store, id, block("2027-01-18T00:00", "2027-04-18T00:00", 0, toZone)),
        zone,
      ).toEqual({ ok: false, reason: "more-than-90-days" });
      await expectNothingWritten(before, zone);

      // 消して入れ直す：直したあとのブロック枠だけなら、かかる日はちょうど90日なので入る
      expect(await deleteAdminBlock(store, id), zone).toEqual({ ok: true });
      const again = await saveBlockOk(block("2027-01-18T00:00", "2027-04-18T00:00", 0, toZone));
      expect(await daysHolding(id), zone).toEqual([]);
      expect(await daysHolding(again), zone).toEqual(jstDays("2027-01-18", 90));
    });
  }, 60_000);

  it("管理者が休業のブロック枠 2026/10/20 00:00–2027/01/18 00:00 を 2026/10/20 00:00–2027/01/17 00:00 に縮める：直る（両方にかかる日は1日と数えるので、合わせて90日）", async () => {
    await inEachZone(async (zone, toZone) => {
      const id = await saveBlockOk(block("2026-10-20T00:00", "2027-01-18T00:00", 0, toZone));

      // 直す前は 2026/10/20〜2027/01/17 の90日、直したあとは 2026/10/20〜2027/01/16 の89日。
      // 両方にかかる日を1日と数えると（書き直す日の和集合）、合わせて90日
      expect(
        await updateAdminBlock(store, id, block("2026-10-20T00:00", "2027-01-17T00:00", 0, toZone)),
        zone,
      ).toEqual({ ok: true });

      expect(await daysHolding(id), zone).toEqual(jstDays("2026-10-20", 89));
      expect(await storedIntervals("2027-01-16"), zone).toEqual([
        blockInterval(id, "2026-10-20T00:00", "2027-01-17T00:00", 0),
      ]);
      expect(await storedIntervals("2027-01-17"), zone).toEqual([]);
      await expectBlock(
        id,
        { start: "2026-10-20T00:00", end: "2027-01-17T00:00", bufferMinutes: 0 },
        zone,
      );
    });
  }, 60_000);

  it("管理者が、Googleカレンダーから取り込んだブロック枠を消す：不可（取り込みで更新する）", async () => {
    await putCalendarBlock(
      "gcal-kaku-event-1",
      "2026-10-20",
      "2026-10-20T10:00",
      "2026-10-20T13:00",
    );
    const before = await scanAll();

    expect(await deleteAdminBlock(store, "gcal-kaku-event-1")).toEqual({
      ok: false,
      reason: "google-calendar-block",
    });
    await expectNothingWritten(before);
  });
});

describe("ブロック枠の保存：入れる", () => {
  it("管理者が清掃のブロック枠 10/20 15:00–16:00 をバッファ30分・メモ「清掃」で入れる：BLK#<id> の META と、DAY#2026-10-20（占有区間 15:00–16:30、バッファ30、版番号1）を書く。id は gcal- で始まらず、記録（履歴）は書かない", async () => {
    const id = await saveBlockOk(
      block("2026-10-20T15:00", "2026-10-20T16:00", 30, undefined, "清掃"),
    );

    expect(id.startsWith("gcal-")).toBe(false);
    expect(await blockItemSks(id)).toEqual(["META"]);
    expect((await dayItem("2026-10-20"))?.["version"]).toBe(1);
    expect(await storedIntervals("2026-10-20")).toEqual([
      blockInterval(id, "2026-10-20T15:00", "2026-10-20T16:30", 30),
    ]);
    expect(await dayItem("2026-10-19")).toBeUndefined();
    expect(await dayItem("2026-10-21")).toBeUndefined();
    // ブロック枠を入れても、予約のアイテムは書かない
    expect((await scanAll()).filter((item) => String(item["pk"]).startsWith("RES#"))).toEqual([]);
    await expectBlock(id, {
      start: "2026-10-20T15:00",
      end: "2026-10-20T16:00",
      bufferMinutes: 30,
      memo: "清掃",
    });
  });

  it("管理者がブロック枠を2件入れる：id はそれぞれ違い、同じ日のアイテムに2件の占有区間が入る（版番号2）", async () => {
    const a = await saveBlockOk(block("2026-10-20T09:00", "2026-10-20T10:00", 0));
    const b = await saveBlockOk(block("2026-10-20T15:00", "2026-10-20T16:00", 0));

    expect(a).not.toBe(b);
    expect((await dayItem("2026-10-20"))?.["version"]).toBe(2);
    expect((await storedIntervals("2026-10-20")).map((i) => i.id).sort()).toEqual([a, b].sort());
  });

  it("管理者が休業のブロック枠 10/20 00:00–10/21 00:00 をバッファなしで入れる：DAY#2026-10-20 にだけ入る（10/21 00:00 で終わるので、DAY#2026-10-21 にはかからない）。JST で渡しても UTC で渡しても同じ", async () => {
    await inEachZone(async (zone, toZone) => {
      const id = await saveBlockOk(block("2026-10-20T00:00", "2026-10-21T00:00", 0, toZone));

      expect(await daysHolding(id), zone).toEqual(["2026-10-20"]);
      expect(await storedIntervals("2026-10-20"), zone).toEqual([
        blockInterval(id, "2026-10-20T00:00", "2026-10-21T00:00", 0),
      ]);
    });
  });

  it("かかる日はバッファ込みの占有区間で数える：2026/10/20 00:00–2027/01/17 23:30 をバッファ1時間で入れる（占有区間は 2027/01/18 00:30 まで。かかる日は91日）：不可（more-than-90-days）。何も書かれない", async () => {
    const before = await scanAll();
    for (const [zone, toZone] of zoneVariants) {
      expect(
        await saveAdminBlock(store, block("2026-10-20T00:00", "2027-01-17T23:30", 60, toZone)),
        zone,
      ).toEqual({ ok: false, reason: "more-than-90-days" });
      await expectNothingWritten(before, zone);
    }
  });

  it("管理者が清掃のブロック枠 15:15–16:00 を入れる：不可（not-on-30-minute-boundary）。JST で渡しても UTC で渡しても、何も書かれない", async () => {
    const before = await scanAll();
    for (const [zone, toZone] of zoneVariants) {
      expect(
        await saveAdminBlock(store, block("2026-10-20T15:15", "2026-10-20T16:00", 0, toZone)),
        zone,
      ).toEqual({ ok: false, reason: "not-on-30-minute-boundary" });
      await expectNothingWritten(before, zone);
    }
  });

  it("本予約 10/20 10:00–12:00（占有区間 10:00–13:00）があるときに、ブロック枠 12:00–13:00 を入れる：不可（overlaps-existing）。何も書かれない", async () => {
    await applyApproved("firm", "2026-10-20T10:00", "2026-10-20T12:00");
    const before = await scanAll();

    expect(await saveAdminBlock(store, block("2026-10-20T12:00", "2026-10-20T13:00", 0))).toEqual({
      ok: false,
      reason: "overlaps-existing",
    });
    await expectNothingWritten(before);
  });

  it("ブロック枠 10/20 15:00–16:00（バッファ1時間。占有区間 15:00–17:00）があるときに、ブロック枠 16:30–18:00 を入れる：不可（overlaps-existing）。17:00–18:00 なら入る（17:00で接するだけ）", async () => {
    await saveBlockOk(block("2026-10-20T15:00", "2026-10-20T16:00", 60));
    const before = await scanAll();

    expect(await saveAdminBlock(store, block("2026-10-20T16:30", "2026-10-20T18:00", 0))).toEqual({
      ok: false,
      reason: "overlaps-existing",
    });
    await expectNothingWritten(before);
    expect((await saveAdminBlock(store, block("2026-10-20T17:00", "2026-10-20T18:00", 0))).ok).toBe(
      true,
    );
  });

  it("ブロック枠 10/20 10:00–12:00（バッファなし）があるときに、管理者が本予約 10/20 11:00–13:00 を直接入れる：不可（overlaps-existing）", async () => {
    await saveBlockOk(block("2026-10-20T10:00", "2026-10-20T12:00", 0));

    const result = await saveDirectEntry(
      store,
      {
        ...application("firm", "2026-10-20T11:00", "2026-10-20T13:00"),
        kind: "firm",
        confirmedPrice: Yen.parse(11_000),
      },
      { now: preparedAt, adminUserId },
    );
    expect(result).toEqual({ ok: false, reason: "overlaps-existing" });
  });
});

describe("ブロック枠の保存：消す・直す", () => {
  // 直すときの「合わせて90日」は、直す前と直したあとにかかる日の和集合（両方にかかる日は1日と数える。eaf4951）。
  // 89日のブロック枠 2026/10/20 00:00–2027/01/17 00:00（かかる日は 2026/10/20〜2027/01/16）をずらす
  it("89日のブロック枠 2026/10/20 00:00–2027/01/17 00:00 を1日ずらして 2026/10/21 00:00–2027/01/18 00:00 に直す：直る（和集合は 2026/10/20〜2027/01/17 の90日）", async () => {
    await inEachZone(async (zone, toZone) => {
      const id = await saveBlockOk(block("2026-10-20T00:00", "2027-01-17T00:00", 0, toZone));

      expect(
        await updateAdminBlock(store, id, block("2026-10-21T00:00", "2027-01-18T00:00", 0, toZone)),
        zone,
      ).toEqual({ ok: true });

      expect(await daysHolding(id), zone).toEqual(jstDays("2026-10-21", 89));
    });
  }, 60_000);

  it("89日のブロック枠 2026/10/20 00:00–2027/01/17 00:00 を2日ずらして 2026/10/22 00:00–2027/01/19 00:00 に直す：不可（more-than-90-days。直す前も直したあとも89日だが、和集合は 2026/10/20〜2027/01/18 の91日）。何も書かれない", async () => {
    const id = await saveBlockOk(block("2026-10-20T00:00", "2027-01-17T00:00", 0));
    const before = await scanAll();

    for (const [zone, toZone] of zoneVariants) {
      expect(
        await updateAdminBlock(store, id, block("2026-10-22T00:00", "2027-01-19T00:00", 0, toZone)),
        zone,
      ).toEqual({ ok: false, reason: "more-than-90-days" });
      await expectNothingWritten(before, zone);
    }
  }, 60_000);

  it("管理者がブロック枠 10/20 15:00–16:00 のメモだけを「清掃」から「清掃（業者）」に直す：メモが変わり、占有区間はそのまま", async () => {
    const id = await saveBlockOk(
      block("2026-10-20T15:00", "2026-10-20T16:00", 0, undefined, "清掃"),
    );

    expect(
      await updateAdminBlock(
        store,
        id,
        block("2026-10-20T15:00", "2026-10-20T16:00", 0, undefined, "清掃（業者）"),
      ),
    ).toEqual({ ok: true });

    await expectBlock(id, {
      start: "2026-10-20T15:00",
      end: "2026-10-20T16:00",
      bufferMinutes: 0,
      memo: "清掃（業者）",
    });
    expect(await storedIntervals("2026-10-20")).toEqual([
      blockInterval(id, "2026-10-20T15:00", "2026-10-20T16:00", 0),
    ]);
    // 直す前のメモの記録は残さない
    for (const item of await scanAll()) {
      expect(stringsIn(item), itemKey(item)).not.toContain("清掃");
    }
  });

  it("管理者がブロック枠 10/20 15:00–16:00 を 10/27 15:00–16:00 に直す：DAY#2026-10-20 から外れ、DAY#2026-10-27 に入る（1回の書き込み）。BLK# のアイテムは META だけ", async () => {
    await inEachZone(async (zone, toZone) => {
      const id = await saveBlockOk(block("2026-10-20T15:00", "2026-10-20T16:00", 0, toZone));

      expect(
        await updateAdminBlock(store, id, block("2026-10-27T15:00", "2026-10-27T16:00", 0, toZone)),
        zone,
      ).toEqual({ ok: true });

      expect(await daysHolding(id), zone).toEqual(["2026-10-27"]);
      expect(await storedIntervals("2026-10-27"), zone).toEqual([
        blockInterval(id, "2026-10-27T15:00", "2026-10-27T16:00", 0),
      ]);
      expect(await blockItemSks(id), zone).toEqual(["META"]);
      await expectBlock(
        id,
        { start: "2026-10-27T15:00", end: "2026-10-27T16:00", bufferMinutes: 0 },
        zone,
      );
    });
  });

  it("ブロック枠 10/20 15:00–16:00 とブロック枠 17:00–18:00 があるときに、前のほうを 15:00–17:30 に直す：不可（overlaps-existing。ほかのブロック枠とは重なれない）。何も書かれない", async () => {
    const id = await saveBlockOk(block("2026-10-20T15:00", "2026-10-20T16:00", 0));
    await saveBlockOk(block("2026-10-20T17:00", "2026-10-20T18:00", 0));
    const before = await scanAll();

    expect(
      await updateAdminBlock(store, id, block("2026-10-20T15:00", "2026-10-20T17:30", 0)),
    ).toEqual({ ok: false, reason: "overlaps-existing" });
    await expectNothingWritten(before);
  });

  it("管理者がブロック枠 10/20 15:00–16:00 を 15:15–16:00 に直す：不可（not-on-30-minute-boundary）。JST で渡しても UTC で渡しても、何も書かれない", async () => {
    const id = await saveBlockOk(block("2026-10-20T15:00", "2026-10-20T16:00", 0));
    const before = await scanAll();

    for (const [zone, toZone] of zoneVariants) {
      expect(
        await updateAdminBlock(store, id, block("2026-10-20T15:15", "2026-10-20T16:00", 0, toZone)),
        zone,
      ).toEqual({ ok: false, reason: "not-on-30-minute-boundary" });
      await expectNothingWritten(before, zone);
    }
  });

  it("管理者が、Googleカレンダーから取り込んだブロック枠を直す：不可（google-calendar-block。取り込みで更新する）。何も書かれない", async () => {
    await putCalendarBlock(
      "gcal-kaku-event-2",
      "2026-10-20",
      "2026-10-20T10:00",
      "2026-10-20T13:00",
    );
    const before = await scanAll();

    expect(
      await updateAdminBlock(
        store,
        "gcal-kaku-event-2",
        block("2026-10-20T10:00", "2026-10-20T11:00", 0),
      ),
    ).toEqual({ ok: false, reason: "google-calendar-block" });
    await expectNothingWritten(before);
  });

  it("ない id のブロック枠を消す・直す：不可（not-found）。何も書かれない。読むと null", async () => {
    await saveBlockOk(block("2026-10-20T15:00", "2026-10-20T16:00", 0));
    const before = await scanAll();

    expect(await deleteAdminBlock(store, "no-such-block")).toEqual({
      ok: false,
      reason: "not-found",
    });
    expect(
      await updateAdminBlock(
        store,
        "no-such-block",
        block("2026-10-21T15:00", "2026-10-21T16:00", 0),
      ),
    ).toEqual({ ok: false, reason: "not-found" });
    await expectNothingWritten(before);
    expect(await getBlock(store, "no-such-block")).toBeNull();
  });

  it("同じブロック枠を2回消す：2回目は不可（not-found）", async () => {
    const id = await saveBlockOk(block("2026-10-20T15:00", "2026-10-20T16:00", 0));

    expect(await deleteAdminBlock(store, id)).toEqual({ ok: true });
    expect(await deleteAdminBlock(store, id)).toEqual({ ok: false, reason: "not-found" });
  });
});

describe("ブロック枠：途中で失敗したら何も残らない（INV-2）", () => {
  it("ブロック枠 10/20 22:00–10/21 01:00 を入れる。書く直前に毎回 DAY#2026-10-21 の版番号が進み、やり直しの上限（3回）を超える：混み合っている（busy）。BLK# は残らず、DAY#2026-10-20 にも書かれない", async () => {
    await bumpDay("2026-10-20");
    let calls = 0;

    const result = await saveAdminBlock(store, block("2026-10-20T22:00", "2026-10-21T01:00", 0), {
      maxAttempts: 3,
      beforeWrite: async () => {
        calls += 1;
        await bumpDay("2026-10-21");
      },
    });

    expect(result).toEqual({ ok: false, reason: "busy" });
    expect(calls).toBe(3);
    expect((await scanAll()).filter((item) => String(item["pk"]).startsWith("BLK#"))).toEqual([]);
    expect((await dayItem("2026-10-20"))?.["version"]).toBe(1);
    expect(await storedIntervals("2026-10-20")).toEqual([]);
    expect(await storedIntervals("2026-10-21")).toEqual([]);
  });

  it("ブロック枠 10/20 15:00–16:00 を 10/21 15:00–16:00 に直す。書く直前に毎回 DAY#2026-10-21 の版番号が進む（上限3回）：busy。ブロック枠は直す前のまま（DAY#2026-10-20 にあり、BLK# も直す前の日時）", async () => {
    const id = await saveBlockOk(block("2026-10-20T15:00", "2026-10-20T16:00", 0));
    let calls = 0;

    const result = await updateAdminBlock(
      store,
      id,
      block("2026-10-21T15:00", "2026-10-21T16:00", 0),
      {
        maxAttempts: 3,
        beforeWrite: async () => {
          calls += 1;
          await bumpDay("2026-10-21");
        },
      },
    );

    expect(result).toEqual({ ok: false, reason: "busy" });
    expect(calls).toBe(3);
    expect(await daysHolding(id)).toEqual(["2026-10-20"]);
    expect((await dayItem("2026-10-20"))?.["version"]).toBe(1);
    expect(await storedIntervals("2026-10-21")).toEqual([]);
    await expectBlock(id, { start: "2026-10-20T15:00", end: "2026-10-20T16:00", bufferMinutes: 0 });
  });

  it("ブロック枠 10/20 22:00–10/21 01:00 を消す。書く直前に毎回 DAY#2026-10-21 の版番号が進む（上限3回）：busy。ブロック枠は残り、両日のアイテムの占有区間もそのまま", async () => {
    const id = await saveBlockOk(block("2026-10-20T22:00", "2026-10-21T01:00", 0));
    let calls = 0;

    const result = await deleteAdminBlock(store, id, {
      maxAttempts: 3,
      beforeWrite: async () => {
        calls += 1;
        await bumpDay("2026-10-21");
      },
    });

    expect(result).toEqual({ ok: false, reason: "busy" });
    expect(calls).toBe(3);
    expect(await daysHolding(id)).toEqual(["2026-10-20", "2026-10-21"]);
    expect((await dayItem("2026-10-20"))?.["version"]).toBe(1);
    await expectBlock(id, { start: "2026-10-20T22:00", end: "2026-10-21T01:00", bufferMinutes: 0 });
  });
});

describe("ブロック枠と予約の同時の書き込み（INV-1）", () => {
  it("同じ時間へのブロック枠 10/20 15:00–17:00 と本予約申込 10/20 16:00–18:00 を、どちらも読んで判定してから書くように同時に送る：片方だけが成功し、もう片方は読み直して不可。占有区間は1件", async () => {
    const meet = meetBeforeFirstWrite(2);
    const [blocked, applied] = await Promise.all([
      saveAdminBlock(store, block("2026-10-20T15:00", "2026-10-20T17:00", 0), {
        maxAttempts: 3,
        beforeWrite: meet,
      }),
      saveApplication(store, application("firm", "2026-10-20T16:00", "2026-10-20T18:00"), {
        now: appliedAt,
        maxAttempts: 3,
        beforeWrite: meet,
      }),
    ]);

    expect([blocked.ok, applied.ok].filter((ok) => ok)).toHaveLength(1);
    expect([blocked, applied].filter((r) => !r.ok)).toEqual([
      { ok: false, reason: "overlaps-existing" },
    ]);
    expect(await storedIntervals("2026-10-20")).toHaveLength(1);
    expect((await dayItem("2026-10-20"))?.["version"]).toBe(1);
  });

  it("ブロック枠 10/20 15:00–16:00 を 15:00–17:00 に直すのと、本予約申込 16:00–18:00 を、どちらも読んで判定してから書くように同時に送る：片方だけが成功する。直すのが負けたら、ブロック枠は直す前のまま", async () => {
    const id = await saveBlockOk(block("2026-10-20T15:00", "2026-10-20T16:00", 0));
    const meet = meetBeforeFirstWrite(2);

    const [updated, applied] = await Promise.all([
      updateAdminBlock(store, id, block("2026-10-20T15:00", "2026-10-20T17:00", 0), {
        maxAttempts: 3,
        beforeWrite: meet,
      }),
      saveApplication(store, application("firm", "2026-10-20T16:00", "2026-10-20T18:00"), {
        now: appliedAt,
        maxAttempts: 3,
        beforeWrite: meet,
      }),
    ]);

    expect([updated.ok, applied.ok].filter((ok) => ok)).toHaveLength(1);
    expect([updated, applied].filter((r) => !r.ok)).toEqual([
      { ok: false, reason: "overlaps-existing" },
    ]);
    const intervals = await storedIntervals("2026-10-20");
    if (applied.ok) {
      // 申込が勝った：ブロック枠（15:00–16:00）と申込（占有区間 16:00–19:00）の2件
      expect(intervals.map((i) => i.id)).toHaveLength(2);
      expect(intervals.filter((i) => i.id === id)).toEqual([
        blockInterval(id, "2026-10-20T15:00", "2026-10-20T16:00", 0),
      ]);
    } else {
      expect(intervals).toEqual([blockInterval(id, "2026-10-20T15:00", "2026-10-20T17:00", 0)]);
    }
  });

  it("どの順に来ても、申込・直接入力・ブロック枠のうち成功したものの占有区間は互いに重ならず、不可のものは成功したものと重なっていて、日ごとのアイテムの占有区間が成功したものと合う（ランダムに同時に送る）", async () => {
    // 候補：10/20 00:00（JST）からの30分単位の開始。申込・直接入力は2〜8時間でバッファ1時間、
    // ブロック枠は30分〜2日でバッファ「なし／30分／1時間」
    const base = jst("2026-10-20T00:00");
    const writeShape = fc.oneof(
      fc.record({
        what: fc.constantFrom<"apply" | "direct">("apply", "direct"),
        kind: fc.constantFrom<"firm" | "provisional">("firm", "provisional"),
        startSlot: fc.integer({ min: 0, max: 60 }),
        lengthSlots: fc.integer({ min: 4, max: 16 }),
        bufferMinutes: fc.constant<AdminBlockBufferMinutes>(60),
      }),
      fc.record({
        what: fc.constant<"block">("block"),
        kind: fc.constant<"firm" | "provisional">("firm"),
        startSlot: fc.integer({ min: 0, max: 60 }),
        lengthSlots: fc.integer({ min: 1, max: 96 }),
        bufferMinutes: fc.constantFrom<AdminBlockBufferMinutes>(0, 30, 60),
      }),
    );

    await fc.assert(
      fc.asyncProperty(fc.array(writeShape, { minLength: 2, maxLength: 6 }), async (shapes) => {
        const own = await createTable();
        try {
          const writes = shapes.map((shape) => {
            const start = base.plus({ minutes: shape.startSlot * 30 });
            const end = start.plus({ minutes: shape.lengthSlots * 30 });
            return { shape, start, end };
          });
          const maxAttempts = writes.length + 1;
          const results = await Promise.all(
            writes.map(async ({ shape, start, end }) => {
              if (shape.what === "block") {
                return saveAdminBlock(
                  own,
                  { start, end, bufferMinutes: shape.bufferMinutes },
                  { maxAttempts },
                );
              }
              const app = application(shape.kind, start, end);
              if (shape.what === "apply") {
                return saveApplication(own, app, { now: appliedAt, maxAttempts });
              }
              return saveDirectEntry(
                own,
                { ...app, kind: shape.kind, confirmedPrice: Yen.parse(11_000) },
                { now: preparedAt, adminUserId, maxAttempts },
              );
            }),
          );

          const occupied = (i: number) => {
            const write = writes[i];
            if (write === undefined) throw new Error("ない書き込み");
            return {
              start: write.start.toMillis(),
              end: write.end.plus({ minutes: write.shape.bufferMinutes }).toMillis(),
            };
          };
          const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) =>
            a.start < b.end && b.start < a.end;

          const acceptedIndexes = results.flatMap((result, i) => (result.ok ? [i] : []));
          for (const i of acceptedIndexes) {
            for (const j of acceptedIndexes) {
              if (i < j) expect(overlaps(occupied(i), occupied(j))).toBe(false);
            }
          }
          results.forEach((result, i) => {
            if (result.ok) return;
            // 混み合っている（busy）ときは、何も書かないことだけを求める（下の占有区間の確認）
            if (result.reason === "overlaps-existing") {
              expect(acceptedIndexes.some((j) => overlaps(occupied(i), occupied(j)))).toBe(true);
            } else {
              expect(result.reason).toBe("busy");
            }
          });

          const acceptedIds = results.flatMap((result) => (result.ok ? [result.id] : []));
          const items = await scanTable(own);
          const dayIds = new Set(
            items
              .filter((item) => String(item["pk"]).startsWith("DAY#"))
              .flatMap((item) => (item["intervals"] as PlainItem[]).map((i) => String(i["id"]))),
          );
          expect([...dayIds].sort()).toEqual([...acceptedIds].sort());
          const blockIds = items
            .filter((item) => String(item["pk"]).startsWith("BLK#"))
            .map((item) => String(item["pk"]).slice("BLK#".length));
          const acceptedBlockIds = results.flatMap((result, i) =>
            result.ok && writes[i]?.shape.what === "block" ? [result.id] : [],
          );
          expect(blockIds.sort()).toEqual(acceptedBlockIds.sort());
        } finally {
          await deleteTable(own);
        }
      }),
      { numRuns: 15 },
    );
  }, 180_000);
});
