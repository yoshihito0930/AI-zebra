import {
  type AttributeValue,
  CreateTableCommand,
  DeleteTableCommand,
  PutItemCommand,
  ScanCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { PriceTable, Yen } from "@zebra/contracts";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AdminList,
  type AdminListedBlock,
  type AdminListedReservation,
  listAdminReservationsByStatus,
  listAdminReservationsInPeriod,
} from "./admin-list.ts";
import { saveAdminBlock } from "./blocks.ts";
import { createLocalDynamoClient } from "./client.ts";
import { type DirectEntry, saveDirectEntry } from "./direct-entry.ts";
import { type ReservationOperationInput, saveReservationOperation } from "./operations.ts";
import { submitApplication } from "../public/applications.ts";
import {
  type ApplicationKind,
  type ReservationApplication,
  type ReservationStore,
  saveApplication,
} from "./reservations.ts";

// 管理画面の予約の一覧の読み出しの統合テスト（DynamoDB Local）。
// 根拠：docs/design-docs/admin-api.md「予約の一覧」（期間か状態で読む、出るのは枠を確保している予約とブロック枠だけ、
// 予約ごと・ブロック枠ごとに返すもの、並び順）、dynamodb-keys.md「読み出し」（期間は日ごとのアイテムから予約の META・
// ブロック枠の META と、氏名のためだけに PII を読む。状態だけなら状態の GSI）、「アイテム」（ブロック枠の META の属性）、
// core-beliefs.md（INV-7、INV-10）。
// 予約は、申込の保存（saveApplication）・操作の保存（saveReservationOperation）・直接入力の保存（saveDirectEntry）で作り、
// 管理者のブロック枠は saveAdminBlock で入れる。Googleカレンダーから取り込んだブロック枠は、取り込みの保存がまだないので、
// 資料の形（BLK#gcal-<イベントの id> の META の属性 start・end・bufferMinutes・route、日ごとのアイテムの占有区間）で直接入れる。
// 期間の長さ（最長62日）と前後は API の層で確かめる（admin-api.md）ので、ここでは扱わない。
// 「期間の日にかかる」は占有区間（バッファを含む）で見る。バッファだけが次の日にかかる予約も、次の日の期間に出る（admin-api.md）。

const client = createLocalDynamoClient();
let store: ReservationStore;

// テーブルはキー設計どおり（pk・sk、GSI の gsi1pk・gsi1sk）にテストごとに作り、終わったら消す
async function createTable(): Promise<ReservationStore> {
  const tableName = `int-test-alist-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
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
/** テストの準備でする承認・直接入力の時刻（固定） */
const preparedAt = jst("2026-10-02T12:00");
/** テストの準備でする昇格・取消・却下の時刻（固定） */
const operatedAt = jst("2026-10-05T09:00");

/** 操作した管理者（架空のユーザー id） */
const adminUserId = "admin-user-kaku-list";

// ---- 架空のお客様の情報（INV-10 の確認に使うので、ほかの値と紛れない文字列にする） ----

/** 予約ごとに氏名を変える（一覧の氏名が、その予約の個人情報から来ていることを確かめるため） */
function customerNamed(name: string) {
  return {
    name,
    companyName: "架空一覧株式会社",
    email: "ichiran.kaku@example.com",
    phone: "090-0000-2468",
    address: "架空県架空市一覧町2-4-6",
    photographerName: "仮名 一覧撮影",
  };
}

const shooting = {
  types: ["still"],
  details: "架空の撮影詳細：一覧の確認用の撮影",
  notes: "架空の補足事項：一覧の確認用の補足",
} as const;

/** 一覧に出してはいけない個人情報（氏名以外） */
const nonNamePersonalValues: readonly string[] = [
  "架空一覧株式会社",
  "ichiran.kaku@example.com",
  "090-0000-2468",
  "架空県架空市一覧町2-4-6",
  "仮名 一覧撮影",
  shooting.details,
  shooting.notes,
];

function application(
  kind: ApplicationKind,
  start: string,
  end: string,
  name = "架空 一覧太郎",
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
    customer: customerNamed(name),
    shooting,
  };
}

// ---- 準備の道具 ----

async function apply(
  kind: ApplicationKind,
  start: string,
  end: string,
  name?: string,
): Promise<string> {
  const result = await saveApplication(store, application(kind, start, end, name), {
    now: appliedAt,
  });
  if (!result.ok) {
    throw new Error(`準備の申込が不可になった（${kind} ${start}–${end}、${result.reason}）`);
  }
  return result.id;
}

async function operate(operation: ReservationOperationInput, now = operatedAt): Promise<void> {
  const result = await saveReservationOperation(store, operation, { now, adminUserId });
  if (!result.ok) {
    throw new Error(`準備の操作が不可になった（${operation.kind}、${result.reason}）`);
  }
}

/** 申込して承認する（準備）。確定金額は 22,000円 */
async function applyApproved(
  kind: ApplicationKind,
  start: string,
  end: string,
  name?: string,
): Promise<string> {
  const id = await apply(kind, start, end, name);
  await operate(
    { kind: "approve", reservationId: id, confirmedPrice: Yen.parse(22_000) },
    preparedAt,
  );
  return id;
}

/** 料金表（booking.md「料金」）。フォームの申込（applyViaForm）の見積に使う */
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

/**
 * お客様がフォームから本予約を申込む（公開API の申込。受付番号のアイテム RCPT#<受付番号> ができるのはこの経路だけ）。
 * 人数4人・養生なし（プランA）、機材保険なし、オプションなし
 */
async function applyViaForm(
  start: string,
  end: string,
  name: string,
): Promise<{ id: string; receiptNumber: string }> {
  const before = await reservationIds();
  const result = await submitApplication(
    { store, now: () => appliedAt, priceTable: specPriceTable },
    {
      kind: "firm",
      start: jst(start).toISO(),
      end: jst(end).toISO(),
      partySize: 4,
      cycloramaFloorProtection: false,
      equipmentInsurance: false,
      optionIds: [],
      customer: customerNamed(name),
      shooting: { ...shooting, types: [...shooting.types] },
      agreedToCycloramaRules: true,
      agreedToTerms: true,
    },
  );
  if (!result.ok) {
    throw new Error(`準備のフォームの申込が不可になった（${start}–${end}、${result.reason}）`);
  }
  const added = (await reservationIds()).filter((id) => !before.includes(id));
  expect(added).toHaveLength(1);
  return { id: added[0] ?? "", receiptNumber: result.accepted.receiptNumber };
}

/** 管理者が直接入れる本予約（電話で受けたので、お客様の情報は氏名と電話番号だけ）。見積 27,500円、確定金額 26,000円、3人 */
async function enterFirm(start: string, end: string, name: string): Promise<string> {
  const entry: DirectEntry = {
    kind: "firm",
    start: jst(start),
    end: jst(end),
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
    customer: { name, phone: "090-0000-1357" },
    shooting: {},
  };
  const result = await saveDirectEntry(store, entry, { now: preparedAt, adminUserId });
  if (!result.ok) {
    throw new Error(`準備の直接入力が不可になった（${result.reason}）`);
  }
  return result.id;
}

async function addAdminBlock(
  start: string,
  end: string,
  bufferMinutes: 0 | 30 | 60,
  memo?: string,
): Promise<string> {
  const result = await saveAdminBlock(store, {
    start: jst(start),
    end: jst(end),
    bufferMinutes,
    ...(memo === undefined ? {} : { memo }),
  });
  if (!result.ok) {
    throw new Error(`準備のブロック枠が不可になった（${result.reason}）`);
  }
  return result.id;
}

/**
 * Googleカレンダーから取り込んだブロック枠を、資料の形で直接入れる（dynamodb-keys.md「アイテム」）：
 * BLK#<id> / META に start・end（バッファを含まない区間、UTC）・bufferMinutes（60）・route（google-calendar）、
 * かかる日の日ごとのアイテムに占有区間（バッファ込み）を足し、版番号を1増やす
 */
async function putCalendarBlock(id: string, days: string[], start: string, end: string) {
  const utc = (local: string) => jst(local).toUTC().toISO() ?? "";
  await client.send(
    new PutItemCommand({
      TableName: store.tableName,
      Item: {
        pk: { S: `BLK#${id}` },
        sk: { S: "META" },
        start: { S: utc(start) },
        end: { S: utc(end) },
        bufferMinutes: { N: "60" },
        route: { S: "google-calendar" },
      },
    }),
  );
  const occupiedEnd = jst(end).plus({ minutes: 60 }).toUTC().toISO() ?? "";
  for (const day of days) {
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
          ":added": {
            L: [
              {
                M: {
                  kind: { S: "block" },
                  id: { S: id },
                  start: { S: utc(start) },
                  end: { S: occupiedEnd },
                  bufferMinutes: { N: "60" },
                },
              },
            ],
          },
        },
      }),
    );
  }
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

/** 保存された予約の id（RES#<id> / META のアイテムから） */
async function reservationIds(): Promise<string[]> {
  return (await scanAll())
    .filter((item) => String(item["pk"]).startsWith("RES#") && item["sk"] === "META")
    .map((item) => String(item["pk"]).slice("RES#".length));
}

/** フォームの申込の受付番号（その予約を指す RCPT#<受付番号> のアイテムから） */
async function receiptOf(id: string): Promise<string> {
  const receipts = (await scanAll()).filter(
    (item) => String(item["pk"]).startsWith("RCPT#") && stringsIn(item).includes(id),
  );
  expect(receipts).toHaveLength(1);
  return String(receipts[0]?.["pk"]).slice("RCPT#".length);
}

// ---- 比べる道具 ----

/** 読み出した予約を、比べやすい形にする（日時は JST の "yyyy-MM-ddTHH:mm"） */
function normalizeReservation(r: AdminListedReservation) {
  return {
    id: r.id,
    receiptNumber: r.receiptNumber,
    status: r.status,
    start: local(r.start),
    end: local(r.end),
    bufferMinutes: r.bufferMinutes,
    route: r.route,
    partySize: r.partySize,
    estimateIncludingTax: r.estimateIncludingTax,
    confirmedPrice: r.confirmedPrice,
    provisionalIds: r.provisionalIds === undefined ? undefined : [...r.provisionalIds],
    customerName: r.customerName,
  };
}

function normalizeBlock(b: AdminListedBlock) {
  return {
    id: b.id,
    start: local(b.start),
    end: local(b.end),
    bufferMinutes: b.bufferMinutes,
    route: b.route,
    memo: b.memo,
  };
}

/** 同じ時点を JST で表した "yyyy-MM-ddTHH:mm"（どのゾーンで返しても、時点が同じなら同じになる） */
function local(value: DateTime): string {
  expect(DateTime.isDateTime(value)).toBe(true);
  return value.setZone("Asia/Tokyo").toFormat("yyyy-MM-dd'T'HH:mm");
}

function ids(list: AdminList): { reservations: string[]; blocks: string[] } {
  return { reservations: list.reservations.map((r) => r.id), blocks: list.blocks.map((b) => b.id) };
}

/** 文字列の大小（コードポイント順）で並べる */
function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---- テスト ----

describe("管理画面の予約の一覧の読み出し：期間（日ごとのアイテムから）", () => {
  it("期間 10/20〜10/21：その日にかかる承認待ち・仮予約・第二キープ・直接入力の本予約と、管理者のブロック枠・Googleカレンダーのブロック枠を返す。予約は開始の早い順に、id・受付番号・状態・予約区間・バッファ・経路・人数・見積額・確定金額・第二キープの仮予約の id・氏名。ブロック枠は区間・バッファ・経路・理由のメモ", async () => {
    const { id: a, receiptNumber } = await applyViaForm(
      "2026-10-20T10:00",
      "2026-10-20T12:00",
      "架空 承認待子",
    );
    expect(await receiptOf(a)).toBe(receiptNumber);
    const p = await applyApproved(
      "provisional",
      "2026-10-20T13:00",
      "2026-10-20T15:00",
      "架空 仮予約男",
    );
    const k = await applyApproved(
      "second-hold",
      "2026-10-20T14:00",
      "2026-10-20T17:00",
      "架空 第二子",
    );
    const d = await enterFirm("2026-10-21T10:00", "2026-10-21T12:00", "架空 電話次郎");
    const b = await addAdminBlock("2026-10-21T15:00", "2026-10-21T16:00", 30, "架空のメモ：清掃");
    await putCalendarBlock(
      "gcal-kaku-event-1",
      ["2026-10-21"],
      "2026-10-21T18:00",
      "2026-10-21T20:00",
    );
    // 期間の外
    await applyApproved("firm", "2026-10-19T10:00", "2026-10-19T12:00");
    await apply("firm", "2026-10-22T10:00", "2026-10-22T12:00");

    const list = await listAdminReservationsInPeriod(store, {
      from: "2026-10-20",
      to: "2026-10-21",
    });

    expect(list.reservations.map(normalizeReservation)).toEqual([
      {
        id: a,
        receiptNumber,
        status: "pending-firm",
        start: "2026-10-20T10:00",
        end: "2026-10-20T12:00",
        bufferMinutes: 60,
        route: "form",
        partySize: 4,
        estimateIncludingTax: 11_000,
        confirmedPrice: undefined,
        provisionalIds: undefined,
        customerName: "架空 承認待子",
      },
      {
        id: p,
        // 申込の保存（saveApplication）で直接作った予約は、受付番号を持たない
        receiptNumber: undefined,
        status: "provisional",
        start: "2026-10-20T13:00",
        end: "2026-10-20T15:00",
        bufferMinutes: 60,
        route: "form",
        partySize: 4,
        estimateIncludingTax: 11_000,
        confirmedPrice: 22_000,
        provisionalIds: undefined,
        customerName: "架空 仮予約男",
      },
      {
        id: k,
        receiptNumber: undefined,
        status: "second-hold",
        start: "2026-10-20T14:00",
        end: "2026-10-20T17:00",
        bufferMinutes: 60,
        route: "form",
        partySize: 4,
        estimateIncludingTax: 11_000,
        confirmedPrice: 22_000,
        provisionalIds: [p],
        customerName: "架空 第二子",
      },
      {
        id: d,
        receiptNumber: undefined,
        status: "firm",
        start: "2026-10-21T10:00",
        end: "2026-10-21T12:00",
        bufferMinutes: 60,
        route: "admin",
        partySize: 3,
        estimateIncludingTax: 27_500,
        confirmedPrice: 26_000,
        provisionalIds: undefined,
        customerName: "架空 電話次郎",
      },
    ]);
    expect(list.blocks.map(normalizeBlock)).toEqual([
      {
        id: b,
        start: "2026-10-21T15:00",
        end: "2026-10-21T16:00",
        bufferMinutes: 30,
        route: "admin",
        memo: "架空のメモ：清掃",
      },
      {
        id: "gcal-kaku-event-1",
        start: "2026-10-21T18:00",
        end: "2026-10-21T20:00",
        bufferMinutes: 60,
        route: "google-calendar",
        memo: undefined,
      },
    ]);
  });

  it("期間 10/20〜10/20 で、承認待ち（仮）と承認待ち（第二キープ）も出る。承認待ち（第二キープ）は付く仮予約の id を持ち、確定金額はない", async () => {
    const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    const k = await apply("second-hold", "2026-10-20T14:00", "2026-10-20T17:00");
    const q = await apply("provisional", "2026-10-20T19:00", "2026-10-20T21:00");

    const list = await listAdminReservationsInPeriod(store, {
      from: "2026-10-20",
      to: "2026-10-20",
    });

    expect(
      list.reservations.map((r) => ({
        id: r.id,
        status: r.status,
        confirmedPrice: r.confirmedPrice,
        provisionalIds: r.provisionalIds === undefined ? undefined : [...r.provisionalIds],
      })),
    ).toEqual([
      { id: p, status: "provisional", confirmedPrice: 22_000, provisionalIds: undefined },
      { id: k, status: "pending-second-hold", confirmedPrice: undefined, provisionalIds: [p] },
      {
        id: q,
        status: "pending-provisional",
        confirmedPrice: undefined,
        provisionalIds: undefined,
      },
    ]);
  });

  it("取消・終了の予約は出ない：却下した承認待ち、取消した本予約、仮予約の昇格で終了した第二キープ。昇格した予約は本予約として出る", async () => {
    const a = await apply("firm", "2026-10-20T08:00", "2026-10-20T10:00");
    const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    const k = await applyApproved("second-hold", "2026-10-20T14:00", "2026-10-20T17:00");
    const f = await applyApproved("firm", "2026-10-20T19:00", "2026-10-20T21:00");
    await operate({ kind: "reject", reservationId: a });
    await operate({ kind: "cancel", reservationId: f });
    await operate({ kind: "promote", reservationId: p });

    const list = await listAdminReservationsInPeriod(store, {
      from: "2026-10-20",
      to: "2026-10-20",
    });

    expect(list.reservations.map((r) => [r.id, r.status])).toEqual([[p, "firm"]]);
    expect(list.reservations.map((r) => r.id)).not.toContain(k);
    expect(await listAdminReservationsByStatus(store, "firm")).toHaveLength(1);
    expect(await listAdminReservationsByStatus(store, "second-hold")).toEqual([]);
    expect(await listAdminReservationsByStatus(store, "pending-firm")).toEqual([]);
  });

  it("日をまたぐ予約（10/20 22:00–10/21 02:00）と、何日も続くブロック枠（10/22 00:00–10/24 00:00）は、かかる日がいくつあっても1件として返す。どちらかの日だけを含む期間でも出る", async () => {
    const r = await applyApproved("firm", "2026-10-20T22:00", "2026-10-21T02:00");
    const blk = await addAdminBlock("2026-10-22T00:00", "2026-10-24T00:00", 0, "架空のメモ：休業");

    expect(
      ids(await listAdminReservationsInPeriod(store, { from: "2026-10-20", to: "2026-10-24" })),
    ).toEqual({ reservations: [r], blocks: [blk] });
    expect(
      ids(await listAdminReservationsInPeriod(store, { from: "2026-10-21", to: "2026-10-21" })),
    ).toEqual({ reservations: [r], blocks: [] });
    expect(
      ids(await listAdminReservationsInPeriod(store, { from: "2026-10-23", to: "2026-10-23" })),
    ).toEqual({ reservations: [], blocks: [blk] });
  });

  it("「期間の日にかかる」は占有区間で見る：10/20 19:30–23:30（占有区間は 10/21 00:30 まで）の本予約は、バッファだけがかかる 10/21 の期間にも出る。10/22 の期間には出ない", async () => {
    const r = await applyApproved("firm", "2026-10-20T19:30", "2026-10-20T23:30");

    const on21 = await listAdminReservationsInPeriod(store, {
      from: "2026-10-21",
      to: "2026-10-21",
    });
    expect(ids(on21)).toEqual({ reservations: [r], blocks: [] });
    // 返すのは予約区間（バッファを含まない）
    expect(local(on21.reservations[0]?.start ?? DateTime.invalid("なし"))).toBe("2026-10-20T19:30");
    expect(local(on21.reservations[0]?.end ?? DateTime.invalid("なし"))).toBe("2026-10-20T23:30");
    expect(
      ids(await listAdminReservationsInPeriod(store, { from: "2026-10-22", to: "2026-10-22" })),
    ).toEqual({ reservations: [], blocks: [] });
  });

  it("バッファだけが次の日にかかるブロック枠（10/20 23:00–23:30、バッファ1時間。占有区間は 10/21 00:30 まで）も、10/21 の期間に出る", async () => {
    const blk = await addAdminBlock("2026-10-20T23:00", "2026-10-20T23:30", 60);

    expect(
      ids(await listAdminReservationsInPeriod(store, { from: "2026-10-21", to: "2026-10-21" })),
    ).toEqual({ reservations: [], blocks: [blk] });
  });

  it("期間の日は JST で区切る（INV-7）：10/20 08:00–10:00（UTC では 10/19 23:00–10/20 01:00）の本予約は、10/20 の期間に出て、10/19 の期間には出ない", async () => {
    const r = await applyApproved("firm", "2026-10-20T08:00", "2026-10-20T10:00");

    const on20 = await listAdminReservationsInPeriod(store, {
      from: "2026-10-20",
      to: "2026-10-20",
    });
    expect(ids(on20)).toEqual({ reservations: [r], blocks: [] });
    expect(on20.reservations[0]?.start.toMillis()).toBe(jst("2026-10-20T08:00").toMillis());
    expect(
      ids(await listAdminReservationsInPeriod(store, { from: "2026-10-19", to: "2026-10-19" })),
    ).toEqual({ reservations: [], blocks: [] });
  });

  it("予約もブロック枠もない期間：どちらも空の一覧", async () => {
    await applyApproved("firm", "2026-10-20T10:00", "2026-10-20T12:00");

    expect(
      await listAdminReservationsInPeriod(store, { from: "2026-11-01", to: "2026-11-30" }),
    ).toEqual({ reservations: [], blocks: [] });
  });

  it("期間と状態（仮予約）：期間の中の仮予約だけを返し、ブロック枠は返さない", async () => {
    const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    await applyApproved("firm", "2026-10-20T18:00", "2026-10-20T20:00");
    await apply("provisional", "2026-10-21T10:00", "2026-10-21T12:00");
    await addAdminBlock("2026-10-20T08:00", "2026-10-20T09:00", 0);
    // 期間の外の仮予約
    await applyApproved("provisional", "2026-10-25T13:00", "2026-10-25T15:00");

    const list = await listAdminReservationsInPeriod(store, {
      from: "2026-10-20",
      to: "2026-10-21",
      status: "provisional",
    });

    expect(ids(list)).toEqual({ reservations: [p], blocks: [] });
  });
});

describe("管理画面の予約の一覧の読み出し：並び順（開始 → 終わり → id）", () => {
  it("開始が同じ予約は終わりの早い順、終わりも同じなら id の順。ブロック枠も同じ", async () => {
    // 仮予約 P1 10/20 13:00–17:00 に、開始が同じで終わりの早い第二キープ K1 13:00–15:00 が付く
    const p1 = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T17:00");
    const k1 = await applyApproved("second-hold", "2026-10-20T13:00", "2026-10-20T15:00");
    // 仮予約 P2 10/21 10:00–12:00 に、開始も終わりも同じ第二キープ K2 が付く
    const p2 = await applyApproved("provisional", "2026-10-21T10:00", "2026-10-21T12:00");
    const k2 = await applyApproved("second-hold", "2026-10-21T10:00", "2026-10-21T12:00");
    // ブロック枠：開始が同じで終わりが違うもの、開始も終わりも同じもの（並び順だけを確かめるため、直接入れる）
    await putCalendarBlock(
      "gcal-kaku-order-b",
      ["2026-10-22"],
      "2026-10-22T10:00",
      "2026-10-22T12:00",
    );
    await putCalendarBlock(
      "gcal-kaku-order-a",
      ["2026-10-22"],
      "2026-10-22T10:00",
      "2026-10-22T11:00",
    );
    await putCalendarBlock(
      "gcal-kaku-order-d",
      ["2026-10-22"],
      "2026-10-22T14:00",
      "2026-10-22T15:00",
    );
    await putCalendarBlock(
      "gcal-kaku-order-c",
      ["2026-10-22"],
      "2026-10-22T14:00",
      "2026-10-22T15:00",
    );

    const list = await listAdminReservationsInPeriod(store, {
      from: "2026-10-20",
      to: "2026-10-22",
    });

    expect(ids(list)).toEqual({
      reservations: [k1, p1, ...[p2, k2].sort(byId)],
      blocks: ["gcal-kaku-order-a", "gcal-kaku-order-b", "gcal-kaku-order-c", "gcal-kaku-order-d"],
    });
  });
});

describe("管理画面の予約の一覧の読み出し：状態だけ（状態の GSI から）", () => {
  it("承認待ち（本）：期間によらず、承認待ち（本）の予約だけを開始の早い順に返す（入れた順ではない）。返す中身は期間のときと同じ", async () => {
    const x1 = await apply("firm", "2027-03-01T10:00", "2027-03-01T12:00", "架空 三月子");
    const x2 = await apply("firm", "2026-10-20T10:00", "2026-10-20T12:00", "架空 十月子");
    const x3 = await apply("firm", "2026-12-25T10:00", "2026-12-25T12:00", "架空 師走子");
    const y = await apply("provisional", "2026-11-01T10:00", "2026-11-01T12:00");
    const z = await applyApproved("firm", "2026-10-21T10:00", "2026-10-21T12:00");
    await addAdminBlock("2026-10-22T10:00", "2026-10-22T12:00", 0);

    const pendingFirm = await listAdminReservationsByStatus(store, "pending-firm");

    expect(pendingFirm.map(normalizeReservation)).toEqual(
      [
        [x2, "2026-10-20", "架空 十月子"],
        [x3, "2026-12-25", "架空 師走子"],
        [x1, "2027-03-01", "架空 三月子"],
      ].map(([id, day, name]) => ({
        id,
        receiptNumber: undefined,
        status: "pending-firm",
        start: `${day}T10:00`,
        end: `${day}T12:00`,
        bufferMinutes: 60,
        route: "form",
        partySize: 4,
        estimateIncludingTax: 11_000,
        confirmedPrice: undefined,
        provisionalIds: undefined,
        customerName: name,
      })),
    );
    expect(
      (await listAdminReservationsByStatus(store, "pending-provisional")).map((r) => r.id),
    ).toEqual([y]);
    expect((await listAdminReservationsByStatus(store, "firm")).map((r) => r.id)).toEqual([z]);
    expect(await listAdminReservationsByStatus(store, "second-hold")).toEqual([]);
  });
});

describe("管理画面の予約の一覧の読み出し：個人情報は氏名だけ（INV-10 の考え方）", () => {
  it("期間でも状態でも、返す値に、氏名以外のお客様の情報（会社名・メールアドレス・電話番号・住所・カメラマン氏名・撮影詳細・補足事項）がない", async () => {
    await apply("firm", "2026-10-20T10:00", "2026-10-20T12:00", "架空 個人子");
    await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00", "架空 個人男");

    const texts = [
      JSON.stringify(
        await listAdminReservationsInPeriod(store, { from: "2026-10-20", to: "2026-10-20" }),
      ),
      JSON.stringify(await listAdminReservationsByStatus(store, "pending-firm")),
      JSON.stringify(await listAdminReservationsByStatus(store, "provisional")),
    ];

    expect(texts[0]).toContain("架空 個人子");
    expect(texts[0]).toContain("架空 個人男");
    for (const text of texts) {
      for (const personal of nonNamePersonalValues) {
        expect(text).not.toContain(personal);
      }
    }
  });
});
