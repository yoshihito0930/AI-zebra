import {
  type AttributeValue,
  CreateTableCommand,
  DeleteTableCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { type PublicBookingLabel, PublicCalendar, Yen } from "@zebra/contracts";
import fc from "fast-check";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalDynamoClient } from "../db/client.ts";
import {
  type ReservationOperationInput,
  type SaveOperationOptions,
  saveReservationOperation,
} from "../db/operations.ts";
import {
  type ApplicationKind,
  type ReservationApplication,
  type ReservationStore,
  saveApplication,
} from "../db/reservations.ts";
import { createPublicCalendarRoute, readPublicCalendar } from "./calendar.ts";

// 公開API（認証なし）の予約状況の統合テスト（DynamoDB Local）。
// 根拠：docs/design-docs/core-beliefs.md の INV-3（と INV-7）、docs/product-specs/booking.md「空き判定」の公開APIの行
// （表示名の対応、時間は予約区間でバッファを含まない）、docs/product-specs/index.md の予約ウィジェットと予約API、
// docs/design-docs/dynamodb-keys.md（日ごとのアイテムの属性、bufferMinutes、公開APIの読み出し）、
// packages/contracts の PublicCalendar。
// 予約は、なるべく申込の保存（saveApplication）と操作の保存（saveReservationOperation）で作る。
// バッファ30分の予約とブロック枠は、それを保存する関数がまだないので、日ごとのアイテムの属性の形
// （dynamodb-keys.md「アイテム」。bufferMinutes を含む）でテストから直接入れる。
// 期間の長さの上限やキャッシュは、資料にないのでテストしない。

const client = createLocalDynamoClient();
let store: ReservationStore;

// テーブルはキー設計どおり（pk・sk、GSI の gsi1pk・gsi1sk）にテストごとに作り、終わったら消す
async function createTable(): Promise<ReservationStore> {
  const tableName = `int-test-pub-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
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

/** 申込の時刻（固定） */
const appliedAt = jst("2026-10-01T12:00");
/** テストの準備でする承認・昇格・却下・取消の時刻（固定） */
const operatedAt = jst("2026-10-02T12:00");

/** 操作した管理者（架空のユーザー id） */
const adminUserId = "admin-user-kaku-pub";

// ---- 架空のお客様の情報（INV-3 の確認に使うので、ほかの値と紛れない文字列にする） ----

const customer = {
  name: "架空 三郎",
  companyName: "架空写真館合同会社",
  email: "saburo.kaku@example.com",
  phone: "090-0000-9012",
  address: "架空県架空市架空坂7-8-9",
  photographerName: "仮名 撮影次郎",
} as const;

const shooting = {
  types: ["still"],
  details: "架空の撮影詳細：家具のカタログの撮影",
  notes: "架空の補足事項：搬入は午前中",
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

/** 見積（税込 11,000円）と確定金額（22,000円）。返す JSON に金額が出ないことの確認に使う */
const estimateIncludingTax = 11_000;
const confirmedPrice = 22_000;

// ---- 準備の道具 ----

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
      estimateIncludingTax: Yen.parse(estimateIncludingTax),
    },
    customer,
    shooting,
  };
}

/** 申込む（準備）。承認待ちになる */
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
): Promise<void> {
  const result = await saveReservationOperation(store, operation, {
    now: operatedAt,
    adminUserId,
    ...options,
  });
  if (!result.ok) {
    throw new Error(`準備の操作が不可になった（${operation.kind}、${result.reason}）`);
  }
}

/** 申込んで承認する（準備）。仮予約・本予約・第二キープになる */
async function applyApproved(kind: ApplicationKind, start: string, end: string): Promise<string> {
  const id = await apply(kind, start, end);
  await operate({ kind: "approve", reservationId: id, confirmedPrice: Yen.parse(confirmedPrice) });
  return id;
}

/** テストから直接入れる占有区間（日時は JST で書き、UTC の ISO 8601 で保存する） */
interface SeedInterval {
  kind: "reservation" | "block";
  id: string;
  status?: string;
  provisionalIds?: string[];
  /** 占有区間（バッファ込み）の開始と終わり */
  start: string;
  end: string;
  bufferMinutes: number;
}

function seedIntervalAttribute(seed: SeedInterval): AttributeValue {
  const map: Record<string, AttributeValue> = {
    kind: { S: seed.kind },
    id: { S: seed.id },
    start: { S: jst(seed.start).toUTC().toISO() ?? "" },
    end: { S: jst(seed.end).toUTC().toISO() ?? "" },
    bufferMinutes: { N: String(seed.bufferMinutes) },
  };
  if (seed.status !== undefined) map["status"] = { S: seed.status };
  if (seed.provisionalIds !== undefined) {
    map["provisionalIds"] = { L: seed.provisionalIds.map((id) => ({ S: id })) };
  }
  return { M: map };
}

/** 日ごとのアイテムを直接入れる（dynamodb-keys.md「アイテム」の属性の形） */
async function putDay(
  day: string,
  intervals: SeedInterval[],
  target: ReservationStore = store,
): Promise<void> {
  await client.send(
    new PutItemCommand({
      TableName: target.tableName,
      Item: {
        pk: { S: `DAY#${day}` },
        sk: { S: "META" },
        version: { N: "1" },
        intervals: { L: intervals.map(seedIntervalAttribute) },
      },
    }),
  );
}

/** ブロック枠の理由（INV-3。返す JSON に出ないことの確認に使う） */
const blockReason = "架空の理由：内装工事のため休業";

/**
 * ブロック枠のアイテム（BLK#<id> / META）を、理由のメモ付きで入れる。
 * 属性名は資料にない（dynamodb-keys.md は「区間、バッファ、経路、理由のメモ」とだけ書く）ので、
 * 理由が値として返す JSON に出ないことだけを確かめるために、それらしい属性名で入れる
 */
async function putBlockMeta(id: string, start: string, end: string): Promise<void> {
  await client.send(
    new PutItemCommand({
      TableName: store.tableName,
      Item: {
        pk: { S: `BLK#${id}` },
        sk: { S: "META" },
        start: { S: jst(start).toUTC().toISO() ?? "" },
        end: { S: jst(end).toUTC().toISO() ?? "" },
        reason: { S: blockReason },
        memo: { S: blockReason },
      },
    }),
  );
}

// ---- 比べる道具 ----

interface ExpectedBooking {
  label: PublicBookingLabel;
  /** 予約区間（バッファを含まない）の開始と終わり。JST で書く */
  start: string;
  end: string;
}

interface ExpectedDay {
  date: string;
  bookings: ExpectedBooking[];
}

interface NormalizedBooking {
  label: string;
  start: number;
  end: number;
}

function byStart(a: NormalizedBooking, b: NormalizedBooking): number {
  return a.start - b.start || a.end - b.end || a.label.localeCompare(b.label);
}

/** 返った予約状況を比べやすい形にする。契約（PublicCalendar、strictObject）を通ることも確かめる */
function normalizeCalendar(value: unknown): { date: string; bookings: NormalizedBooking[] }[] {
  const calendar = PublicCalendar.parse(value);
  return calendar.days.map((day) => ({
    date: day.date,
    bookings: day.bookings
      .map((booking) => {
        const start = DateTime.fromISO(booking.start, { setZone: true });
        const end = DateTime.fromISO(booking.end, { setZone: true });
        expect(start.isValid && end.isValid).toBe(true);
        return { label: booking.label, start: start.toMillis(), end: end.toMillis() };
      })
      .sort(byStart),
  }));
}

function normalizeExpected(days: ExpectedDay[]): { date: string; bookings: NormalizedBooking[] }[] {
  return days.map((day) => ({
    date: day.date,
    bookings: day.bookings
      .map((booking) => ({
        label: booking.label,
        start: jst(booking.start).toMillis(),
        end: jst(booking.end).toMillis(),
      }))
      .sort(byStart),
  }));
}

/**
 * 予約状況が期待どおりかを確かめる。期間のすべての日が日付の順に並び、各日の予約が表示名と予約区間で一致する
 * （同じ日の中の並び順は問わない。時刻はオフセットによらず、同じ時点かで比べる）
 */
function expectCalendar(actual: unknown, expected: ExpectedDay[]): void {
  expect(normalizeCalendar(actual)).toEqual(normalizeExpected(expected));
}

async function read(from: string, to: string): Promise<PublicCalendar> {
  return readPublicCalendar(store, { from, to });
}

/** 返す JSON の中の、キーと値（文字列・数値）を入れ子も含めてすべて集める */
function keysAndValuesIn(value: unknown): { keys: string[]; strings: string[]; numbers: number[] } {
  const keys: string[] = [];
  const strings: string[] = [];
  const numbers: number[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") strings.push(node);
    else if (typeof node === "number") numbers.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node !== null && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        keys.push(key);
        walk(child);
      }
    }
  };
  walk(value);
  return { keys, strings, numbers };
}

/** 承認待ちかどうか・取消・終了がわかる状態の値（表示名と同じ綴りの provisional・firm・second-hold は除く） */
const statusValues: readonly string[] = [
  "pending-provisional",
  "pending-firm",
  "pending-second-hold",
  "pending",
  "cancelled",
  "ended",
];

/**
 * INV-3：返す JSON のどこにも、予約・ブロック枠の id、承認待ちかどうか（状態）、お客様の情報、金額、ブロック枠の理由がない。
 * キーは契約のもの（days・date・bookings・label・start・end）だけ。数値（金額など）は1つもない
 */
function expectNothingPrivate(json: unknown, ids: readonly string[]): void {
  const { keys, strings, numbers } = keysAndValuesIn(json);
  for (const key of keys) {
    expect(["days", "date", "bookings", "label", "start", "end"]).toContain(key);
  }
  expect(numbers).toEqual([]);
  const forbidden = [
    ...ids,
    ...statusValues,
    ...personalValues,
    blockReason,
    String(estimateIncludingTax),
    String(confirmedPrice),
    "11,000",
    "22,000",
  ];
  for (const s of strings) {
    for (const value of forbidden) {
      expect(s).not.toContain(value);
    }
  }
}

// ---- テスト ----

describe("公開APIの予約状況：表示名（booking.md「空き判定」）", () => {
  it("承認待ち（仮）10/20 10:00–12:00：表示名は仮予約、時間は 10:00–12:00", async () => {
    await apply("provisional", "2026-10-20T10:00", "2026-10-20T12:00");

    expectCalendar(await read("2026-10-20", "2026-10-20"), [
      {
        date: "2026-10-20",
        bookings: [{ label: "provisional", start: "2026-10-20T10:00", end: "2026-10-20T12:00" }],
      },
    ]);
  });

  it("仮予約（承認済み）10/20 10:00–12:00：表示名は仮予約、時間は 10:00–12:00", async () => {
    await applyApproved("provisional", "2026-10-20T10:00", "2026-10-20T12:00");

    expectCalendar(await read("2026-10-20", "2026-10-20"), [
      {
        date: "2026-10-20",
        bookings: [{ label: "provisional", start: "2026-10-20T10:00", end: "2026-10-20T12:00" }],
      },
    ]);
  });

  it("承認待ち（本）10/20 10:00–12:00：表示名は本予約、時間は 10:00–12:00", async () => {
    await apply("firm", "2026-10-20T10:00", "2026-10-20T12:00");

    expectCalendar(await read("2026-10-20", "2026-10-20"), [
      {
        date: "2026-10-20",
        bookings: [{ label: "firm", start: "2026-10-20T10:00", end: "2026-10-20T12:00" }],
      },
    ]);
  });

  it("本予約（承認済み）10/20 10:00–12:00：表示名は本予約、時間は 10:00–12:00", async () => {
    await applyApproved("firm", "2026-10-20T10:00", "2026-10-20T12:00");

    expectCalendar(await read("2026-10-20", "2026-10-20"), [
      {
        date: "2026-10-20",
        bookings: [{ label: "firm", start: "2026-10-20T10:00", end: "2026-10-20T12:00" }],
      },
    ]);
  });

  it("仮予約 10/20 10:00–12:00 を本予約に昇格：表示名は本予約、時間は 10:00–12:00", async () => {
    const p = await applyApproved("provisional", "2026-10-20T10:00", "2026-10-20T12:00");
    await operate({ kind: "promote", reservationId: p });

    expectCalendar(await read("2026-10-20", "2026-10-20"), [
      {
        date: "2026-10-20",
        bookings: [{ label: "firm", start: "2026-10-20T10:00", end: "2026-10-20T12:00" }],
      },
    ]);
  });

  it("仮予約 P 13:00–15:00 に付く承認待ち（第二キープ）14:00–17:00：P は仮予約 13:00–15:00、第二キープの表示名は第二キープで 14:00–17:00", async () => {
    await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    await apply("second-hold", "2026-10-20T14:00", "2026-10-20T17:00");

    expectCalendar(await read("2026-10-20", "2026-10-20"), [
      {
        date: "2026-10-20",
        bookings: [
          { label: "provisional", start: "2026-10-20T13:00", end: "2026-10-20T15:00" },
          { label: "second-hold", start: "2026-10-20T14:00", end: "2026-10-20T17:00" },
        ],
      },
    ]);
  });

  it("仮予約 P 13:00–15:00 に付く第二キープ（承認済み）14:00–17:00：P は仮予約 13:00–15:00、第二キープの表示名は第二キープで 14:00–17:00", async () => {
    await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    await applyApproved("second-hold", "2026-10-20T14:00", "2026-10-20T17:00");

    expectCalendar(await read("2026-10-20", "2026-10-20"), [
      {
        date: "2026-10-20",
        bookings: [
          { label: "provisional", start: "2026-10-20T13:00", end: "2026-10-20T15:00" },
          { label: "second-hold", start: "2026-10-20T14:00", end: "2026-10-20T17:00" },
        ],
      },
    ]);
  });

  it("ブロック枠 10/20 15:00–17:00（バッファ1時間）：表示名は予約不可、時間は 15:00–17:00", async () => {
    await putDay("2026-10-20", [
      {
        kind: "block",
        id: "seed-block-label",
        start: "2026-10-20T15:00",
        end: "2026-10-20T18:00",
        bufferMinutes: 60,
      },
    ]);

    expectCalendar(await read("2026-10-20", "2026-10-20"), [
      {
        date: "2026-10-20",
        bookings: [{ label: "unavailable", start: "2026-10-20T15:00", end: "2026-10-20T17:00" }],
      },
    ]);
  });

  it("10/21 に承認待ち（仮）09:00–11:00 と承認待ち（本）13:00–15:00、10/22 に同じ時間の仮予約と本予約：どちらの日も仮予約 09:00–11:00 と本予約 13:00–15:00 で、承認待ちかどうかの区別がつかない", async () => {
    await apply("provisional", "2026-10-21T09:00", "2026-10-21T11:00");
    await applyApproved("provisional", "2026-10-22T09:00", "2026-10-22T11:00");
    await apply("firm", "2026-10-21T13:00", "2026-10-21T15:00");
    await applyApproved("firm", "2026-10-22T13:00", "2026-10-22T15:00");

    expectCalendar(await read("2026-10-21", "2026-10-22"), [
      {
        date: "2026-10-21",
        bookings: [
          { label: "provisional", start: "2026-10-21T09:00", end: "2026-10-21T11:00" },
          { label: "firm", start: "2026-10-21T13:00", end: "2026-10-21T15:00" },
        ],
      },
      {
        date: "2026-10-22",
        bookings: [
          { label: "provisional", start: "2026-10-22T09:00", end: "2026-10-22T11:00" },
          { label: "firm", start: "2026-10-22T13:00", end: "2026-10-22T15:00" },
        ],
      },
    ]);
  });
});

describe("公開APIの予約状況：時間は予約区間で、バッファを含まない", () => {
  it("申込で作った本予約 10/20 10:00–12:00（バッファ1時間、占有区間 10:00–13:00）：時間は 10:00–12:00", async () => {
    await applyApproved("firm", "2026-10-20T10:00", "2026-10-20T12:00");

    expectCalendar(await read("2026-10-20", "2026-10-20"), [
      {
        date: "2026-10-20",
        bookings: [{ label: "firm", start: "2026-10-20T10:00", end: "2026-10-20T12:00" }],
      },
    ]);
  });

  it("本予約 A 09:00–12:00、バッファ30分（占有区間 09:00–12:30）：時間は 09:00–12:00", async () => {
    await putDay("2026-10-20", [
      {
        kind: "reservation",
        id: "seed-firm-buffer-30",
        status: "firm",
        start: "2026-10-20T09:00",
        end: "2026-10-20T12:30",
        bufferMinutes: 30,
      },
    ]);

    expectCalendar(await read("2026-10-20", "2026-10-20"), [
      {
        date: "2026-10-20",
        bookings: [{ label: "firm", start: "2026-10-20T09:00", end: "2026-10-20T12:00" }],
      },
    ]);
  });

  it("本予約 A 09:00–12:00、バッファ30分のあとに申込 12:30–14:30（予約可）：A は 09:00–12:00、申込は本予約 12:30–14:30", async () => {
    await putDay("2026-10-20", [
      {
        kind: "reservation",
        id: "seed-firm-buffer-30",
        status: "firm",
        start: "2026-10-20T09:00",
        end: "2026-10-20T12:30",
        bufferMinutes: 30,
      },
    ]);
    await apply("firm", "2026-10-20T12:30", "2026-10-20T14:30");

    expectCalendar(await read("2026-10-20", "2026-10-20"), [
      {
        date: "2026-10-20",
        bookings: [
          { label: "firm", start: "2026-10-20T09:00", end: "2026-10-20T12:00" },
          { label: "firm", start: "2026-10-20T12:30", end: "2026-10-20T14:30" },
        ],
      },
    ]);
  });

  it("ブロック枠 10/20 15:00–17:00、バッファ1時間（占有区間 15:00–18:00）：予約不可 15:00–17:00", async () => {
    await putDay("2026-10-20", [
      {
        kind: "block",
        id: "seed-block-60",
        start: "2026-10-20T15:00",
        end: "2026-10-20T18:00",
        bufferMinutes: 60,
      },
    ]);

    expectCalendar(await read("2026-10-20", "2026-10-20"), [
      {
        date: "2026-10-20",
        bookings: [{ label: "unavailable", start: "2026-10-20T15:00", end: "2026-10-20T17:00" }],
      },
    ]);
  });

  it("清掃のブロック枠 15:00–16:00、バッファ30分（占有区間 15:00–16:30）：予約不可 15:00–16:00", async () => {
    await putDay("2026-10-20", [
      {
        kind: "block",
        id: "seed-block-30",
        start: "2026-10-20T15:00",
        end: "2026-10-20T16:30",
        bufferMinutes: 30,
      },
    ]);

    expectCalendar(await read("2026-10-20", "2026-10-20"), [
      {
        date: "2026-10-20",
        bookings: [{ label: "unavailable", start: "2026-10-20T15:00", end: "2026-10-20T16:00" }],
      },
    ]);
  });

  it("休業のブロック枠 10/20 00:00–10/21 00:00、バッファなし：10/20 に予約不可 00:00–10/21 00:00、10/21 には出ない", async () => {
    await putDay("2026-10-20", [
      {
        kind: "block",
        id: "seed-block-0",
        start: "2026-10-20T00:00",
        end: "2026-10-21T00:00",
        bufferMinutes: 0,
      },
    ]);

    expectCalendar(await read("2026-10-20", "2026-10-21"), [
      {
        date: "2026-10-20",
        bookings: [{ label: "unavailable", start: "2026-10-20T00:00", end: "2026-10-21T00:00" }],
      },
      { date: "2026-10-21", bookings: [] },
    ]);
  });
});

describe("公開APIの予約状況：期間の日と、日をまたぐ予約", () => {
  it("予約のない期間 10/19〜10/21：3日がそれぞれ空の一覧で、日付の順に並ぶ", async () => {
    expectCalendar(await read("2026-10-19", "2026-10-21"), [
      { date: "2026-10-19", bookings: [] },
      { date: "2026-10-20", bookings: [] },
      { date: "2026-10-21", bookings: [] },
    ]);
  });

  it("from と to が同じ日 10/20：その1日だけを返す", async () => {
    await apply("firm", "2026-10-20T10:00", "2026-10-20T12:00");
    await apply("firm", "2026-10-21T10:00", "2026-10-21T12:00");

    expectCalendar(await read("2026-10-20", "2026-10-20"), [
      {
        date: "2026-10-20",
        bookings: [{ label: "firm", start: "2026-10-20T10:00", end: "2026-10-20T12:00" }],
      },
    ]);
  });

  it("期間 10/20〜10/21 の外の予約（10/19、10/22）：出ない", async () => {
    await apply("firm", "2026-10-19T10:00", "2026-10-19T12:00");
    await apply("firm", "2026-10-20T10:00", "2026-10-20T12:00");
    await apply("provisional", "2026-10-21T10:00", "2026-10-21T12:00");
    await apply("firm", "2026-10-22T10:00", "2026-10-22T12:00");

    expectCalendar(await read("2026-10-20", "2026-10-21"), [
      {
        date: "2026-10-20",
        bookings: [{ label: "firm", start: "2026-10-20T10:00", end: "2026-10-20T12:00" }],
      },
      {
        date: "2026-10-21",
        bookings: [{ label: "provisional", start: "2026-10-21T10:00", end: "2026-10-21T12:00" }],
      },
    ]);
  });

  it("本予約 10/20 22:00–10/21 02:00：10/20 と 10/21 のそれぞれに、同じ時間 10/20 22:00–10/21 02:00 で入る", async () => {
    await applyApproved("firm", "2026-10-20T22:00", "2026-10-21T02:00");

    expectCalendar(await read("2026-10-19", "2026-10-22"), [
      { date: "2026-10-19", bookings: [] },
      {
        date: "2026-10-20",
        bookings: [{ label: "firm", start: "2026-10-20T22:00", end: "2026-10-21T02:00" }],
      },
      {
        date: "2026-10-21",
        bookings: [{ label: "firm", start: "2026-10-20T22:00", end: "2026-10-21T02:00" }],
      },
      { date: "2026-10-22", bookings: [] },
    ]);
  });

  it("本予約 10/21 22:00–10/22 02:00 を期間 10/20〜10/21 で読む：10/21 に、切らずに 10/21 22:00–10/22 02:00 で入る", async () => {
    await apply("firm", "2026-10-21T22:00", "2026-10-22T02:00");

    expectCalendar(await read("2026-10-20", "2026-10-21"), [
      { date: "2026-10-20", bookings: [] },
      {
        date: "2026-10-21",
        bookings: [{ label: "firm", start: "2026-10-21T22:00", end: "2026-10-22T02:00" }],
      },
    ]);
  });

  it("本予約 10/20 20:00–10/21 00:00（バッファで占有区間は 10/21 01:00 まで）：10/20 にだけ 20:00–10/21 00:00 で入り、10/21 には出ない", async () => {
    await applyApproved("firm", "2026-10-20T20:00", "2026-10-21T00:00");

    expectCalendar(await read("2026-10-20", "2026-10-21"), [
      {
        date: "2026-10-20",
        bookings: [{ label: "firm", start: "2026-10-20T20:00", end: "2026-10-21T00:00" }],
      },
      { date: "2026-10-21", bookings: [] },
    ]);
  });

  it("本予約 10/21 03:00–07:00（UTC では 10/20 18:00–22:00）：JST の 10/21 にだけ入り、10/20 には出ない（INV-7）", async () => {
    await apply("firm", "2026-10-21T03:00", "2026-10-21T07:00");

    expectCalendar(await read("2026-10-20", "2026-10-21"), [
      { date: "2026-10-20", bookings: [] },
      {
        date: "2026-10-21",
        bookings: [{ label: "firm", start: "2026-10-21T03:00", end: "2026-10-21T07:00" }],
      },
    ]);
  });

  it("休業のブロック枠 10/22 00:00–10/24 00:00、バッファなし：10/22 と 10/23 に同じ時間で入り、10/24 には出ない", async () => {
    const blockInterval: SeedInterval = {
      kind: "block",
      id: "seed-block-two-days",
      start: "2026-10-22T00:00",
      end: "2026-10-24T00:00",
      bufferMinutes: 0,
    };
    await putDay("2026-10-22", [blockInterval]);
    await putDay("2026-10-23", [blockInterval]);

    expectCalendar(await read("2026-10-22", "2026-10-24"), [
      {
        date: "2026-10-22",
        bookings: [{ label: "unavailable", start: "2026-10-22T00:00", end: "2026-10-24T00:00" }],
      },
      {
        date: "2026-10-23",
        bookings: [{ label: "unavailable", start: "2026-10-22T00:00", end: "2026-10-24T00:00" }],
      },
      { date: "2026-10-24", bookings: [] },
    ]);
  });
});

describe("公開APIの予約状況：取消・終了した予約は出ない", () => {
  it("承認待ち（本）10/20 10:00–12:00 を却下：出ない", async () => {
    const a = await apply("firm", "2026-10-20T10:00", "2026-10-20T12:00");
    await operate({ kind: "reject", reservationId: a });

    expectCalendar(await read("2026-10-20", "2026-10-20"), [{ date: "2026-10-20", bookings: [] }]);
  });

  it("本予約 10/20 10:00–12:00 を取消：出ない。ほかの日の本予約 10/21 10:00–12:00 は残る", async () => {
    const a = await applyApproved("firm", "2026-10-20T10:00", "2026-10-20T12:00");
    await applyApproved("firm", "2026-10-21T10:00", "2026-10-21T12:00");
    await operate({ kind: "cancel", reservationId: a });

    expectCalendar(await read("2026-10-20", "2026-10-21"), [
      { date: "2026-10-20", bookings: [] },
      {
        date: "2026-10-21",
        bookings: [{ label: "firm", start: "2026-10-21T10:00", end: "2026-10-21T12:00" }],
      },
    ]);
  });

  it("日をまたぐ本予約 10/20 22:00–10/21 02:00 を取消：10/20 にも 10/21 にも出ない", async () => {
    const a = await applyApproved("firm", "2026-10-20T22:00", "2026-10-21T02:00");
    await operate({ kind: "cancel", reservationId: a });

    expectCalendar(await read("2026-10-20", "2026-10-21"), [
      { date: "2026-10-20", bookings: [] },
      { date: "2026-10-21", bookings: [] },
    ]);
  });

  it("仮予約 P 13:00–15:00 に第二キープ K 14:00–17:00 が付いているときに P を取消：P は出ない。K は第二キープ 14:00–17:00 のまま出る", async () => {
    const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    await applyApproved("second-hold", "2026-10-20T14:00", "2026-10-20T17:00");
    await operate({ kind: "cancel", reservationId: p });

    expectCalendar(await read("2026-10-20", "2026-10-20"), [
      {
        date: "2026-10-20",
        bookings: [{ label: "second-hold", start: "2026-10-20T14:00", end: "2026-10-20T17:00" }],
      },
    ]);
  });

  it("仮予約 P 13:00–15:00 に第二キープ K 14:00–17:00 が付いているときに P を昇格：K は終了して出ない。P は本予約 13:00–15:00", async () => {
    const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    await applyApproved("second-hold", "2026-10-20T14:00", "2026-10-20T17:00");
    await operate({ kind: "promote", reservationId: p });

    expectCalendar(await read("2026-10-20", "2026-10-20"), [
      {
        date: "2026-10-20",
        bookings: [{ label: "firm", start: "2026-10-20T13:00", end: "2026-10-20T15:00" }],
      },
    ]);
  });
});

describe("公開APIの予約状況：返す JSON（INV-3 の契約テスト）", () => {
  /** すべての種類（承認待ち・承認済みの各種、第二キープ、ブロック枠、取消・終了）を入れ、id を返す */
  async function prepareAllKinds(): Promise<string[]> {
    const ids: string[] = [];
    // 10/20：仮予約 P、P に付く第二キープ K（承認済み）と承認待ち（第二キープ）K2、承認待ち（本）、ブロック枠
    const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    const k = await applyApproved("second-hold", "2026-10-20T14:00", "2026-10-20T17:00");
    const k2 = await apply("second-hold", "2026-10-20T10:30", "2026-10-20T12:30");
    const pendingFirm = await apply("firm", "2026-10-20T05:00", "2026-10-20T09:00");
    ids.push(p, k, k2, pendingFirm);
    // 10/21：承認待ち（仮）、本予約、取消した本予約
    const pendingProvisional = await apply("provisional", "2026-10-21T09:00", "2026-10-21T11:00");
    const firm = await applyApproved("firm", "2026-10-21T13:00", "2026-10-21T15:00");
    const cancelled = await applyApproved("firm", "2026-10-21T17:00", "2026-10-21T19:00");
    await operate({ kind: "cancel", reservationId: cancelled });
    ids.push(pendingProvisional, firm, cancelled);
    // 10/22：仮予約 Q と第二キープ L。Q を昇格して L は終了
    const q = await applyApproved("provisional", "2026-10-22T13:00", "2026-10-22T15:00");
    const l = await applyApproved("second-hold", "2026-10-22T14:00", "2026-10-22T17:00");
    await operate({ kind: "promote", reservationId: q });
    ids.push(q, l);
    // 10/23：ブロック枠（理由のメモ付き）
    const blockId = "seed-block-with-reason";
    await putBlockMeta(blockId, "2026-10-23T10:00", "2026-10-23T12:00");
    await putDay("2026-10-23", [
      {
        kind: "block",
        id: blockId,
        start: "2026-10-23T10:00",
        end: "2026-10-23T13:00",
        bufferMinutes: 60,
      },
    ]);
    ids.push(blockId);
    return ids;
  }

  const expectedAllKinds: ExpectedDay[] = [
    {
      date: "2026-10-20",
      bookings: [
        { label: "firm", start: "2026-10-20T05:00", end: "2026-10-20T09:00" },
        { label: "second-hold", start: "2026-10-20T10:30", end: "2026-10-20T12:30" },
        { label: "provisional", start: "2026-10-20T13:00", end: "2026-10-20T15:00" },
        { label: "second-hold", start: "2026-10-20T14:00", end: "2026-10-20T17:00" },
      ],
    },
    {
      date: "2026-10-21",
      bookings: [
        { label: "provisional", start: "2026-10-21T09:00", end: "2026-10-21T11:00" },
        { label: "firm", start: "2026-10-21T13:00", end: "2026-10-21T15:00" },
      ],
    },
    {
      date: "2026-10-22",
      bookings: [{ label: "firm", start: "2026-10-22T13:00", end: "2026-10-22T15:00" }],
    },
    {
      date: "2026-10-23",
      bookings: [{ label: "unavailable", start: "2026-10-23T10:00", end: "2026-10-23T12:00" }],
    },
  ];

  it("すべての種類の予約とブロック枠があるとき：返す値は PublicCalendar（strictObject）を通り、表示名と予約区間だけが並ぶ", async () => {
    await prepareAllKinds();

    const calendar = await read("2026-10-20", "2026-10-23");

    expect(PublicCalendar.safeParse(calendar).success).toBe(true);
    expectCalendar(calendar, expectedAllKinds);
  });

  it("同じとき：予約・ブロック枠の id、状態（承認待ち・取消・終了）、お客様の情報、金額、ブロック枠の理由が、返す値のどこにもない", async () => {
    const ids = await prepareAllKinds();

    const calendar = await read("2026-10-20", "2026-10-23");

    expectNothingPrivate(JSON.parse(JSON.stringify(calendar)), ids);
  });

  it("同じとき：HTTP の応答の JSON も PublicCalendar を通り、id・状態・お客様の情報・金額・ブロック枠の理由がどこにもない", async () => {
    const ids = await prepareAllKinds();
    const route = createPublicCalendarRoute(store);

    const res = await route.request("/calendar?from=2026-10-20&to=2026-10-23");

    expect(res.status).toBe(200);
    const text = await res.text();
    for (const value of [...ids, ...personalValues, blockReason, ...statusValues]) {
      expect(text).not.toContain(value);
    }
    const json: unknown = JSON.parse(text);
    expect(PublicCalendar.safeParse(json).success).toBe(true);
    expectCalendar(json, expectedAllKinds);
    expectNothingPrivate(json, ids);
  });
});

describe("公開APIの予約状況：HTTP（GET /calendar）", () => {
  it("GET /calendar?from=2026-10-20&to=2026-10-21（認証なし）：200 と JSON。期間の日ごとの表示名と予約区間", async () => {
    await apply("firm", "2026-10-20T10:00", "2026-10-20T12:00");
    await applyApproved("provisional", "2026-10-21T22:00", "2026-10-22T02:00");
    const route = createPublicCalendarRoute(store);

    const res = await route.request("/calendar?from=2026-10-20&to=2026-10-21");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    expectCalendar(await res.json(), [
      {
        date: "2026-10-20",
        bookings: [{ label: "firm", start: "2026-10-20T10:00", end: "2026-10-20T12:00" }],
      },
      {
        date: "2026-10-21",
        bookings: [{ label: "provisional", start: "2026-10-21T22:00", end: "2026-10-22T02:00" }],
      },
    ]);
  });

  it("GET /calendar?from=2026-10-20&to=2026-10-20（予約なし）：200 と、10/20 の空の一覧", async () => {
    const route = createPublicCalendarRoute(store);

    const res = await route.request("/calendar?from=2026-10-20&to=2026-10-20");

    expect(res.status).toBe(200);
    expectCalendar(await res.json(), [{ date: "2026-10-20", bookings: [] }]);
  });

  it.each([
    ["from がない", "/calendar?to=2026-10-21"],
    ["to がない", "/calendar?from=2026-10-20"],
    ["from も to もない", "/calendar"],
    ["from の形が不正（2026/10/20）", "/calendar?from=2026%2F10%2F20&to=2026-10-21"],
    ["from の形が不正（20261020）", "/calendar?from=20261020&to=2026-10-21"],
    ["from が空", "/calendar?from=&to=2026-10-21"],
    ["to の形が不正（日時 2026-10-21T00:00）", "/calendar?from=2026-10-20&to=2026-10-21T00%3A00"],
    ["to が存在しない日付（2026-10-32）", "/calendar?from=2026-10-20&to=2026-10-32"],
    ["from が存在しない日付（2026-02-30）", "/calendar?from=2026-02-30&to=2026-03-01"],
    ["from が to より後（10/21〜10/20）", "/calendar?from=2026-10-21&to=2026-10-20"],
  ])("期間の指定がおかしい（%s）：400", async (_, path) => {
    const route = createPublicCalendarRoute(store);

    const res = await route.request(path);

    expect(res.status).toBe(400);
  });
});

// ---- プロパティベーステスト（INV-3） ----

const activeStatuses = [
  "pending-provisional",
  "pending-firm",
  "pending-second-hold",
  "provisional",
  "firm",
  "second-hold",
] as const;
type ActiveStatus = (typeof activeStatuses)[number];

const labelOf: Record<ActiveStatus, PublicBookingLabel> = {
  "pending-provisional": "provisional",
  provisional: "provisional",
  "pending-firm": "firm",
  firm: "firm",
  "pending-second-hold": "second-hold",
  "second-hold": "second-hold",
};

/** JST の日付（YYYY-MM-DD）の 0:00 */
function dayStart(day: string): DateTime {
  return jst(`${day}T00:00`);
}

/** 区間 [start, end) がかかる JST の日付 */
function daysTouched(start: DateTime, end: DateTime): string[] {
  const days: string[] = [];
  let day = start.setZone("Asia/Tokyo").startOf("day");
  while (day < end) {
    days.push(day.toISODate() ?? "");
    day = day.plus({ days: 1 });
  }
  return days;
}

describe("公開APIの予約状況：どの予約・ブロック枠の組み合わせでも、表示名と予約区間だけを返す（INV-3）", () => {
  it("ランダムに並べた予約（6つの状態、バッファ30分・1時間）とブロック枠（バッファなし・30分・1時間）を日ごとのアイテムに入れると：期間の日ごとに、予約区間がその日にかかるものだけが、表示名と予約区間で返り、id と状態の値はどこにもない", async () => {
    const base = jst("2026-10-19T00:00");
    const entryShape = fc.oneof(
      fc.record({
        kind: fc.constant("reservation" as const),
        status: fc.constantFrom(...activeStatuses),
        gapSlots: fc.integer({ min: 0, max: 30 }),
        lengthSlots: fc.integer({ min: 4, max: 48 }),
        bufferMinutes: fc.constantFrom(30, 60),
      }),
      fc.record({
        kind: fc.constant("block" as const),
        gapSlots: fc.integer({ min: 0, max: 30 }),
        lengthSlots: fc.integer({ min: 1, max: 96 }),
        bufferMinutes: fc.constantFrom(0, 30, 60),
      }),
    );

    await fc.assert(
      fc.asyncProperty(
        fc.array(entryShape, { minLength: 0, maxLength: 8 }),
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 0, max: 4 }),
        async (shapes, fromOffset, length) => {
          const own = await createTable();
          try {
            // 占有区間が重ならないように、前のものの占有区間の終わりから間を空けて並べる
            let cursor = base;
            const entries = shapes.map((shape, index) => {
              const start = cursor.plus({ minutes: shape.gapSlots * 30 });
              const end = start.plus({ minutes: shape.lengthSlots * 30 });
              const occupiedEnd = end.plus({ minutes: shape.bufferMinutes });
              cursor = occupiedEnd;
              const id = `pbt-${shape.kind}-${index}-${Math.random().toString(36).slice(2, 8)}`;
              return { shape, id, start, end, occupiedEnd };
            });

            // 日ごとのアイテム：占有区間がかかる JST の日それぞれに、同じ区間を入れる
            const byDay = new Map<string, SeedInterval[]>();
            for (const { shape, id, start, occupiedEnd } of entries) {
              const seed: SeedInterval = {
                kind: shape.kind,
                id,
                start: start.toISO() ?? "",
                end: occupiedEnd.toISO() ?? "",
                bufferMinutes: shape.bufferMinutes,
              };
              if (shape.kind === "reservation") {
                seed.status = shape.status;
                if (shape.status === "pending-second-hold" || shape.status === "second-hold") {
                  seed.provisionalIds = [`pbt-provisional-of-${id}`];
                }
              }
              for (const day of daysTouched(start, occupiedEnd)) {
                byDay.set(day, [...(byDay.get(day) ?? []), seed]);
              }
            }
            for (const [day, intervals] of byDay) {
              await putDay(day, intervals, own);
            }

            const from = base.plus({ days: fromOffset });
            const to = from.plus({ days: length });
            const fromDate = from.toISODate() ?? "";
            const toDate = to.toISODate() ?? "";

            const expected: ExpectedDay[] = [];
            for (let day = from; day <= to; day = day.plus({ days: 1 })) {
              const date = day.toISODate() ?? "";
              const next = dayStart(date).plus({ days: 1 });
              expected.push({
                date,
                bookings: entries
                  .filter(({ start, end }) => start < next && dayStart(date) < end)
                  .map(({ shape, start, end }) => ({
                    label: shape.kind === "block" ? "unavailable" : labelOf[shape.status],
                    start: start.toISO() ?? "",
                    end: end.toISO() ?? "",
                  })),
              });
            }

            const calendar = await readPublicCalendar(own, { from: fromDate, to: toDate });

            expectCalendar(calendar, expected);
            const { strings } = keysAndValuesIn(JSON.parse(JSON.stringify(calendar)));
            for (const s of strings) {
              for (const value of [
                ...entries.map(({ id }) => id),
                "pbt-provisional-of-",
                ...statusValues,
              ]) {
                expect(s).not.toContain(value);
              }
            }
          } finally {
            await deleteTable(own);
          }
        },
      ),
      { numRuns: 25 },
    );
  }, 120_000);
});
