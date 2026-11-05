import {
  type AttributeValue,
  CreateTableCommand,
  DeleteTableCommand,
  GetItemCommand,
  QueryCommand,
  ScanCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { Yen } from "@zebra/contracts";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type SaveBufferChangeOptions,
  type SaveBufferChangeResult,
  saveBufferChange,
} from "./buffer-change.ts";
import { createLocalDynamoClient } from "./client.ts";
import {
  type OperationDraft,
  type ReservationOperationInput,
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

// バッファの切り替えの保存（saveBufferChange）の統合テスト（DynamoDB Local）。
// 根拠：docs/product-specs/booking.md「バッファを30分に縮める」、reservation-model.md（状態と操作のバッファの切り替え、
// 第二キープと仮予約、履歴）、dynamodb-keys.md（日ごとのアイテムの属性、書き込みの手順、下書きのアイテム）、
// admin-api.md「バッファの切り替え・お客様の情報の変更（2回目b）」、core-beliefs.md（INV-1、INV-2、INV-7、INV-10）。
// 判定の細かい決まり（例の表の行）は booking-core の単体テスト（buffer-change.test.ts）で確かめているので、
// ここでは代表的な場合と、それが1回の書き込みで DB に残ること（残らないこと）を確かめる。
// - 予約は、テストから直接入れずに申込の保存（saveApplication）と承認などの保存（saveReservationOperation）で作る
// - META・履歴・下書きの属性名は資料にないので、予約の詳細（getReservation）・関数の戻り値・アイテムの中の値で確かめる。
//   直接見る属性は、資料にある pk・sk・gsi1pk・gsi1sk・version・intervals（とその中の属性）だけ
// - 例の表には日付がないので 2026/10/20 とする

const client = createLocalDynamoClient();
let store: ReservationStore;

// テーブルはキー設計どおり（pk・sk、GSI の gsi1pk・gsi1sk）にテストごとに作り、終わったら消す
async function createTable(): Promise<ReservationStore> {
  const tableName = `int-test-buffer-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
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
/** テストの準備でする承認・取消・切り替えの時刻（固定） */
const preparedAt = jst("2026-10-02T12:00");
/** 確かめる操作の時刻（固定） */
const operatedAt = jst("2026-10-05T09:00");

/** 操作した管理者（架空のユーザー id） */
const adminUserId = "admin-user-kaku-buffer-1";

/** 保存された日時の文字列が、UTC で表されていて（INV-7）、指定の時点と同じかを確かめる */
function expectUtcInstant(value: unknown, expected: DateTime): void {
  expect(typeof value).toBe("string");
  const parsed = DateTime.fromISO(value as string, { setZone: true });
  expect(parsed.isValid).toBe(true);
  expect(parsed.offset).toBe(0);
  expect(parsed.toMillis()).toBe(expected.toMillis());
}

// ---- 架空のお客様の情報（INV-10 の確認に使うので、ほかの値と紛れない文字列にする） ----

const customer = {
  name: "架空 切替太郎",
  companyName: "架空切替合同会社",
  email: "kirikae.taro.kaku@example.com",
  phone: "090-0000-2468",
  address: "架空県架空市切替町2-4-6",
  photographerName: "仮名 切替撮影",
} as const;

const shooting = {
  types: ["still"],
  details: "架空の撮影詳細：バッファの切り替えの確認用",
  notes: "架空の補足事項：バッファの切り替えの確認用",
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

/** 申込して承認する（準備）。確定金額は 22,000円 */
async function applyApproved(kind: ApplicationKind, start: string, end: string): Promise<string> {
  const id = await apply(kind, start, end);
  await prepareOperation({ kind: "approve", reservationId: id, confirmedPrice: Yen.parse(22_000) });
  return id;
}

async function switchBuffer(
  reservationId: string,
  bufferMinutes: 30 | 60,
  options: Partial<SaveBufferChangeOptions> = {},
): Promise<SaveBufferChangeResult> {
  return saveBufferChange(
    store,
    { reservationId, bufferMinutes },
    { now: operatedAt, adminUserId, ...options },
  );
}

async function switchOk(
  reservationId: string,
  bufferMinutes: 30 | 60,
  options: Partial<SaveBufferChangeOptions> = {},
): Promise<Extract<SaveBufferChangeResult, { ok: true }>> {
  const result = await switchBuffer(reservationId, bufferMinutes, options);
  if (!result.ok) {
    throw new Error(`切り替えが成功するはずが不可になった（${reservationId}、${result.reason}）`);
  }
  return result;
}

/** 準備として、バッファを切り替えておく */
async function prepareBuffer(reservationId: string, bufferMinutes: 30 | 60): Promise<void> {
  await switchOk(reservationId, bufferMinutes, { now: preparedAt });
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

/** できない切り替え・何もしない切り替えで、テーブルの中身が何も変わっていないことを確かめる */
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

async function dayVersion(day: string): Promise<number> {
  const version = (await dayItem(day))?.["version"];
  expect(typeof version).toBe("number");
  return version as number;
}

async function draftItems(): Promise<PlainItem[]> {
  return (await scanAll()).filter((item) => String(item["sk"]).startsWith("DRAFT#"));
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

/** 日ごとのアイテムの占有区間の1件を、比べやすい形にする（開始・終わりは UTC で保存されていることも確かめる） */
interface NormalizedInterval {
  kind: unknown;
  id: unknown;
  status: unknown;
  provisionalIds: unknown;
  start: number;
  end: number;
  bufferMinutes: unknown;
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
    bufferMinutes: map["bufferMinutes"],
  };
}

function byStart(a: NormalizedInterval, b: NormalizedInterval): number {
  return a.start - b.start || String(a.id).localeCompare(String(b.id));
}

async function storedIntervals(day: string): Promise<NormalizedInterval[]> {
  const item = await dayItem(day);
  if (item === undefined) return [];
  return (item["intervals"] as unknown[]).map(normalizeStored).sort(byStart);
}

/** 日ごとのアイテムの占有区間（start・end はバッファ込み。bufferMinutes はバッファの長さ） */
function interval(fields: {
  id: string;
  status: string;
  provisionalIds?: string[];
  start: string;
  end: string;
  bufferMinutes: 30 | 60;
}): NormalizedInterval {
  return {
    kind: "reservation",
    id: fields.id,
    status: fields.status,
    provisionalIds: fields.provisionalIds,
    start: jst(fields.start).toMillis(),
    end: jst(fields.end).toMillis(),
    bufferMinutes: fields.bufferMinutes,
  };
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

/** 下書きの並び順は決めていないので、件数と中身で比べる */
function expectDrafts(saved: readonly SavedDraft[], expected: readonly OperationDraft[]): void {
  const drafts = saved.map((s) => s.draft);
  expect(drafts).toHaveLength(expected.length);
  expect(drafts).toEqual(expect.arrayContaining([...expected]));
}

/**
 * 戻り値の下書きが、切り替えと同じ書き込みでテーブルに入っていることを確かめる：
 * pk は RES#<あて先の予約の id>、sk は DRAFT#<作った日時（UTC）>#<連番>、状態は未送信、
 * GSI は gsi1pk = DRAFT#UNSENT・gsi1sk = 作った日時
 */
async function expectDraftsStored(
  saved: readonly SavedDraft[],
  createdAt: DateTime,
): Promise<void> {
  for (const s of saved) {
    expect(s.status).toBe("unsent");
    const match = /^DRAFT#([^#]+)#\d+$/.exec(s.sk);
    expect(match, s.sk).not.toBeNull();
    expectUtcInstant(match?.[1], createdAt);
    const item = await getItem(`RES#${s.draft.reservationId}`, s.sk);
    expect(item, `RES#${s.draft.reservationId} ${s.sk}`).toBeDefined();
    expect(item?.["gsi1pk"]).toBe("DRAFT#UNSENT");
    expectUtcInstant(item?.["gsi1sk"], createdAt);
  }
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

describe("バッファの切り替えの保存", () => {
  it("本予約 A 10/20 09:00–12:00（バッファ1時間）のバッファを30分にする：成功。META のバッファは30分・更新日時は操作の時刻、DAY#2026-10-20 の占有区間は 09:00–12:30（バッファ30分）で版番号が1増える。履歴（管理者・buffer-change・前後のバッファ 60 → 30）が1件増える。下書きは作らない", async () => {
    const a = await applyApproved("firm", "2026-10-20T09:00", "2026-10-20T12:00");
    const version = await dayVersion("2026-10-20");
    const histories = await historyCount(a);
    const draftsBefore = (await draftItems()).length;

    const result = await switchOk(a, 30);

    expect(result.changed).toBe(true);
    expect(result.drafts).toEqual([]);
    const detail = await getReservation(store, a);
    expect(detail?.bufferMinutes).toBe(30);
    expect(detail?.status).toBe("firm");
    // 予約区間・確定金額は変わらない
    expect(detail?.start.toMillis()).toBe(jst("2026-10-20T09:00").toMillis());
    expect(detail?.end.toMillis()).toBe(jst("2026-10-20T12:00").toMillis());
    expect(detail?.confirmedPrice).toBe(22_000);
    expect(detail?.updatedAt.toMillis()).toBe(operatedAt.toMillis());
    expect((await meta(a))?.["gsi1pk"]).toBe("STATUS#firm");

    expect(await dayVersion("2026-10-20")).toBe(version + 1);
    expect(await storedIntervals("2026-10-20")).toEqual([
      interval({
        id: a,
        status: "firm",
        start: "2026-10-20T09:00",
        end: "2026-10-20T12:30",
        bufferMinutes: 30,
      }),
    ]);

    expect(await historyCount(a)).toBe(histories + 1);
    const entry = await lastHistory(a);
    expect(entry?.at.toMillis()).toBe(operatedAt.toMillis());
    expect(entry?.actor).toEqual({ kind: "admin", userId: adminUserId });
    expect(entry?.operation).toBe("buffer-change");
    expect(entry?.before?.bufferMinutes).toBe(60);
    expect(entry?.after?.bufferMinutes).toBe(30);
    expect(entry?.before?.status).toBe("firm");
    expect(entry?.after?.status).toBe("firm");

    expect(await draftItems()).toHaveLength(draftsBefore);
  });

  it("A のバッファを30分にしたあと、1時間に戻す：成功。DAY#2026-10-20 の占有区間は 09:00–13:00（バッファ1時間）に戻り、履歴の前後のバッファは 30 → 60", async () => {
    const a = await applyApproved("firm", "2026-10-20T09:00", "2026-10-20T12:00");
    await prepareBuffer(a, 30);

    const result = await switchOk(a, 60);

    expect(result.changed).toBe(true);
    expect((await getReservation(store, a))?.bufferMinutes).toBe(60);
    expect(await storedIntervals("2026-10-20")).toEqual([
      interval({
        id: a,
        status: "firm",
        start: "2026-10-20T09:00",
        end: "2026-10-20T13:00",
        bufferMinutes: 60,
      }),
    ]);
    const entry = await lastHistory(a);
    expect(entry?.operation).toBe("buffer-change");
    expect(entry?.before?.bufferMinutes).toBe(30);
    expect(entry?.after?.bufferMinutes).toBe(60);
  });

  it("A のバッファ30分、本予約 B 12:30–14:30 あり、A のバッファを1時間に戻す：不可（overlaps-existing。12:30–13:00が B と重なる）。何も書かれない", async () => {
    const a = await applyApproved("firm", "2026-10-20T09:00", "2026-10-20T12:00");
    await prepareBuffer(a, 30);
    await applyApproved("firm", "2026-10-20T12:30", "2026-10-20T14:30");
    const before = await scanAll();

    expect(await switchBuffer(a, 60)).toEqual({ ok: false, reason: "overlaps-existing" });
    await expectNothingWritten(before);
  });

  it("本予約 A 09:00–12:00、バッファ1時間、A のバッファを1時間にする：何もしない（今と同じ）。成功（changed は false、下書きなし）で、版番号・META・履歴を含めて何も書かれない", async () => {
    const a = await applyApproved("firm", "2026-10-20T09:00", "2026-10-20T12:00");
    const before = await scanAll();

    expect(await switchBuffer(a, 60)).toEqual({ ok: true, changed: false, drafts: [] });
    await expectNothingWritten(before);
  });

  it("切り替えられない状態（承認待ち（本）・承認待ち（仮）・第二キープ・承認待ち（第二キープ）・取消・終了）：不可（not-changeable）。何も書かれない", async () => {
    const pendingFirm = await apply("firm", "2026-10-20T09:00", "2026-10-20T12:00");
    const pendingProvisional = await apply("provisional", "2026-10-21T09:00", "2026-10-21T12:00");
    // 仮予約 P 10/22 13:00–15:00 に付く第二キープ K 14:00–17:00 と、承認待ちの第二キープ K2 11:00–13:00（占有区間 11:00–14:00）
    await applyApproved("provisional", "2026-10-22T13:00", "2026-10-22T15:00");
    const k = await applyApproved("second-hold", "2026-10-22T14:00", "2026-10-22T17:00");
    const k2 = await apply("second-hold", "2026-10-22T11:00", "2026-10-22T13:00");
    const cancelled = await applyApproved("firm", "2026-10-23T09:00", "2026-10-23T12:00");
    await prepareOperation({ kind: "cancel", reservationId: cancelled });
    // 仮予約 Q 10/24 13:00–15:00 を昇格すると、付いている第二キープ E 14:00–17:00 は終了する
    const q = await applyApproved("provisional", "2026-10-24T13:00", "2026-10-24T15:00");
    const ended = await applyApproved("second-hold", "2026-10-24T14:00", "2026-10-24T17:00");
    await prepareOperation({ kind: "promote", reservationId: q });
    expect((await getReservation(store, ended))?.status).toBe("ended");
    const before = await scanAll();

    for (const id of [pendingFirm, pendingProvisional, k, k2, cancelled, ended]) {
      const status = (await getReservation(store, id))?.status;
      expect(await switchBuffer(id, 30), String(status)).toEqual({
        ok: false,
        reason: "not-changeable",
      });
      await expectNothingWritten(before);
    }
  });

  it("ない id の予約のバッファを切り替えようとする：不可（not-found）。何も書かれない", async () => {
    await applyApproved("firm", "2026-10-20T09:00", "2026-10-20T12:00");
    const before = await scanAll();

    expect(await switchBuffer("no-such-reservation", 30)).toEqual({
      ok: false,
      reason: "not-found",
    });
    await expectNothingWritten(before);
  });

  it("仮予約 P 13:00–15:00、バッファ30分（占有区間 13:00–15:30）。P に付く第二キープ K 15:00–17:00、P のバッファを1時間にする：成功（K の枠と重なる部分は P が使ってよい）。DAY#2026-10-20 の P の占有区間は 13:00–16:00。K は P に付いたままで、K の META は変わらない。下書きは作らない", async () => {
    const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    await prepareBuffer(p, 30);
    const k = await applyApproved("second-hold", "2026-10-20T15:00", "2026-10-20T17:00");
    expect((await getReservation(store, k))?.provisionalIds).toEqual([p]);
    const kBefore = await meta(k);

    const result = await switchOk(p, 60);

    expect(result.drafts).toEqual([]);
    expect((await getReservation(store, p))?.bufferMinutes).toBe(60);
    expect(await meta(k)).toEqual(kBefore);
    expect(await storedIntervals("2026-10-20")).toEqual([
      interval({
        id: p,
        status: "provisional",
        start: "2026-10-20T13:00",
        end: "2026-10-20T16:00",
        bufferMinutes: 60,
      }),
      interval({
        id: k,
        status: "second-hold",
        provisionalIds: [p],
        start: "2026-10-20T15:00",
        end: "2026-10-20T18:00",
        bufferMinutes: 60,
      }),
    ]);
  });

  it("仮予約 P 13:00–15:00（占有区間 13:00–16:00）。P に付く第二キープ K 15:30–17:30、P のバッファを30分にする：成功。P の占有区間は 13:00–15:30。K は P に付かなくなる（META・DAY#2026-10-20）が、第二キープのまま枠を確保する。K への繰り上げ案内の下書き（残っている仮予約なし）が、同じ書き込みで入る", async () => {
    const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    const k = await applyApproved("second-hold", "2026-10-20T15:30", "2026-10-20T17:30");
    expect((await getReservation(store, k))?.provisionalIds).toEqual([p]);
    const version = await dayVersion("2026-10-20");

    const result = await switchOk(p, 30);

    expect((await getReservation(store, p))?.bufferMinutes).toBe(30);
    const kDetail = await getReservation(store, k);
    expect(kDetail?.status).toBe("second-hold");
    expect(kDetail?.provisionalIds ?? []).toEqual([]);
    expect(kDetail?.bufferMinutes).toBe(60);

    expect(await dayVersion("2026-10-20")).toBe(version + 1);
    const day20 = await storedIntervals("2026-10-20");
    expect(day20.map((i) => i.id)).toEqual([p, k]);
    expect(day20[0]).toEqual(
      interval({
        id: p,
        status: "provisional",
        start: "2026-10-20T13:00",
        end: "2026-10-20T15:30",
        bufferMinutes: 30,
      }),
    );
    expect(withoutProvisionalIds(day20[1])).toEqual(
      interval({
        id: k,
        status: "second-hold",
        start: "2026-10-20T15:30",
        end: "2026-10-20T18:30",
        bufferMinutes: 60,
      }),
    );

    const entry = await lastHistory(p);
    expect(entry?.operation).toBe("buffer-change");
    expect(entry?.before?.bufferMinutes).toBe(60);
    expect(entry?.after?.bufferMinutes).toBe(30);

    expectDrafts(result.drafts, [
      { kind: "move-up-notice", reservationId: k, remainingProvisionalIds: [] },
    ]);
    await expectDraftsStored(result.drafts, operatedAt);
  });

  it("仮予約 P 13:00–15:00（占有区間 13:00–16:00）に付く承認待ちの第二キープ K 15:30–17:30 があり、P のバッファを30分にする：成功。K は承認待ちのまま P に付かなくなる（META・DAY#2026-10-20）。下書きは作らない", async () => {
    const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    const k = await apply("second-hold", "2026-10-20T15:30", "2026-10-20T17:30");
    expect((await getReservation(store, k))?.provisionalIds).toEqual([p]);
    const draftsBefore = (await draftItems()).length;

    const result = await switchOk(p, 30);

    expect(result.drafts).toEqual([]);
    expect(await draftItems()).toHaveLength(draftsBefore);
    const kDetail = await getReservation(store, k);
    expect(kDetail?.status).toBe("pending-second-hold");
    expect(kDetail?.provisionalIds ?? []).toEqual([]);
    const day20 = await storedIntervals("2026-10-20");
    expect(withoutProvisionalIds(day20.find((i) => i.id === k))).toEqual(
      interval({
        id: k,
        status: "pending-second-hold",
        start: "2026-10-20T15:30",
        end: "2026-10-20T18:30",
        bufferMinutes: 60,
      }),
    );
  });

  // 占有区間がかかる日は、切り替えの前と後で変わることがある（dynamodb-keys.md「1つの占有区間が日をまたぐときは、
  // かかる日それぞれのアイテムに、同じ区間を入れる」。区間は半開区間なので、10/21 00:00 で終わる占有区間は 10/21 にかからない）。
  // 本予約 A 10/20 19:00–23:30 の占有区間は、バッファ1時間なら 19:00–10/21 00:30、30分なら 19:00–10/21 00:00
  it("本予約 A 10/20 19:00–23:30（占有区間 19:00–10/21 00:30）のバッファを、UTC で表した現在時刻で30分にする：DAY#2026-10-20 の占有区間は 19:00–10/21 00:00 になり、DAY#2026-10-21 から A が消える（版番号はどちらも1増える）。1時間に戻すと、DAY#2026-10-21 にまた入る。履歴の日時は UTC", async () => {
    const a = await applyApproved("firm", "2026-10-20T19:00", "2026-10-20T23:30");
    const expected60 = interval({
      id: a,
      status: "firm",
      start: "2026-10-20T19:00",
      end: "2026-10-21T00:30",
      bufferMinutes: 60,
    });
    expect(await storedIntervals("2026-10-20")).toEqual([expected60]);
    expect(await storedIntervals("2026-10-21")).toEqual([expected60]);
    const version20 = await dayVersion("2026-10-20");
    const version21 = await dayVersion("2026-10-21");

    await switchOk(a, 30, { now: operatedAt.toUTC() });

    expect(await storedIntervals("2026-10-20")).toEqual([
      interval({
        id: a,
        status: "firm",
        start: "2026-10-20T19:00",
        end: "2026-10-21T00:00",
        bufferMinutes: 30,
      }),
    ]);
    expect(await storedIntervals("2026-10-21")).toEqual([]);
    expect(await dayVersion("2026-10-20")).toBe(version20 + 1);
    expect(await dayVersion("2026-10-21")).toBe(version21 + 1);
    expect((await lastHistory(a))?.at.toMillis()).toBe(operatedAt.toMillis());
    for (const item of await historyItems(a)) {
      const match = /^HIST#([^#]+)#\d+$/.exec(String(item["sk"]));
      expect(match).not.toBeNull();
      expect(DateTime.fromISO(match?.[1] ?? "", { setZone: true }).offset).toBe(0);
    }

    await switchOk(a, 60, { now: operatedAt.plus({ hours: 1 }).toUTC() });

    expect(await storedIntervals("2026-10-20")).toEqual([expected60]);
    expect(await storedIntervals("2026-10-21")).toEqual([expected60]);
  });
});

describe("バッファの切り替えの保存：同時の書き込み（INV-1）", () => {
  function overlapping(intervals: readonly NormalizedInterval[]): boolean {
    return intervals.some((a, i) =>
      intervals.slice(i + 1).some((b) => a.start < b.end && b.start < a.end),
    );
  }

  it("本予約 A 10/20 09:00–12:00（バッファ30分）を1時間に戻す切り替えと、12:30–14:30 への申込を、どちらも読んで判定してから書くように同時に送る：片方だけ成功、もう片方は読み直して不可（overlaps-existing）。占有区間は重ならない", async () => {
    const a = await applyApproved("firm", "2026-10-20T09:00", "2026-10-20T12:00");
    await prepareBuffer(a, 30);
    const meet = meetBeforeFirstWrite(2);

    const [switched, applied] = await Promise.all([
      switchBuffer(a, 60, { maxAttempts: 3, beforeWrite: meet }),
      saveApplication(store, application("firm", "2026-10-20T12:30", "2026-10-20T14:30"), {
        now: appliedAt,
        maxAttempts: 3,
        beforeWrite: meet,
      }),
    ]);

    expect([switched.ok, applied.ok].filter(Boolean)).toHaveLength(1);
    const intervals = await storedIntervals("2026-10-20");
    expect(overlapping(intervals)).toBe(false);
    if (switched.ok) {
      expect(applied).toEqual({ ok: false, reason: "overlaps-existing" });
      expect((await getReservation(store, a))?.bufferMinutes).toBe(60);
      expect(intervals.map((i) => i.id)).toEqual([a]);
    } else {
      expect(switched).toEqual({ ok: false, reason: "overlaps-existing" });
      expect((await getReservation(store, a))?.bufferMinutes).toBe(30);
      expect(intervals.map((i) => i.id)).toEqual([a, applied.ok ? applied.id : "?"]);
    }
  });

  it("A のバッファを30分にする切り替えで、1回目の書く直前だけほかの書き込みで版番号が進む：読み直してやり直し、成功。版番号は2増え、履歴は1件だけ増える", async () => {
    const a = await applyApproved("firm", "2026-10-20T09:00", "2026-10-20T12:00");
    const version = await dayVersion("2026-10-20");
    const histories = await historyCount(a);
    let calls = 0;

    const result = await switchBuffer(a, 30, {
      maxAttempts: 3,
      beforeWrite: async (attempt) => {
        calls += 1;
        if (attempt === 1) await bumpDay("2026-10-20");
      },
    });

    expect(result.ok).toBe(true);
    expect(calls).toBe(2);
    expect(await dayVersion("2026-10-20")).toBe(version + 2);
    expect(await historyCount(a)).toBe(histories + 1);
    expect((await getReservation(store, a))?.bufferMinutes).toBe(30);
  });
});

describe("バッファの切り替えの保存：途中で失敗したら何も残らない（INV-2）", () => {
  it("仮予約 P 13:00–15:00 に付く第二キープ K 15:30–17:30 があるときに P のバッファを30分にする切り替えで、書く直前に毎回 DAY#2026-10-20 の版番号が進み、やり直しの上限（2回）を超える：混み合っている（busy）。P・K の META、履歴、下書きは変わらず、DAY#2026-10-20 は版番号だけが進む", async () => {
    const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    const k = await applyApproved("second-hold", "2026-10-20T15:30", "2026-10-20T17:30");
    const before = await scanAll();
    const day20Before = await storedIntervals("2026-10-20");
    const version = await dayVersion("2026-10-20");
    let calls = 0;

    const result = await switchBuffer(p, 30, {
      maxAttempts: 2,
      beforeWrite: async () => {
        calls += 1;
        await bumpDay("2026-10-20");
      },
    });

    expect(result).toEqual({ ok: false, reason: "busy" });
    expect(calls).toBe(2);
    const after = await scanAll();
    expect(sortedItems(after.filter((item) => item["pk"] !== "DAY#2026-10-20"))).toEqual(
      sortedItems(before.filter((item) => item["pk"] !== "DAY#2026-10-20")),
    );
    expect(await dayVersion("2026-10-20")).toBe(version + 2);
    expect(await storedIntervals("2026-10-20")).toEqual(day20Before);
    expect((await getReservation(store, p))?.bufferMinutes).toBe(60);
    expect((await getReservation(store, k))?.provisionalIds).toEqual([p]);
  });
});

describe("バッファの切り替えの保存：個人情報は下書き・履歴・日ごとのアイテムに入らない（INV-10）", () => {
  it("本予約と、第二キープが付いた仮予約のバッファを切り替えたあと：お客様の情報と撮影の内容（自由記述）の値は PII のアイテムにだけあり、META・DAY#・HIST#・DRAFT# のどのアイテムにもない", async () => {
    const a = await applyApproved("firm", "2026-10-21T09:00", "2026-10-21T12:00");
    const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    await applyApproved("second-hold", "2026-10-20T15:30", "2026-10-20T17:30");
    await switchOk(a, 30);
    await switchOk(p, 30);

    const items = await scanAll();
    const notPii = items.filter((item) => item["sk"] !== "PII");
    expect(notPii.some((item) => String(item["sk"]).startsWith("DRAFT#"))).toBe(true);
    expect(notPii.some((item) => String(item["sk"]).startsWith("HIST#"))).toBe(true);
    expect(notPii.some((item) => String(item["pk"]).startsWith("DAY#"))).toBe(true);
    for (const item of notPii) {
      const strings = stringsIn(item);
      for (const personal of personalValues) {
        for (const s of strings) {
          expect(s, itemKey(item)).not.toContain(personal);
        }
      }
    }
  });
});
