// 予約の申込の保存と読み出し（docs/design-docs/dynamodb-keys.md、reservation-model.md）。
// 保存の層が判定するのは重なり（INV-1）と状態の移り変わりだけ。申込の締め切り・時間の単位・料金の計算など、
// 申込の中身の検証は、その前に API の層で行う（dynamodb-keys.md「書き込み」）。
// 重なりの判定は booking-core（checkAvailability、checkSecondHoldApplication）に任せ、ここには同じ判定を書かない。
// DB から読んだ値は、使う前にここで形を確かめる（INV-4）。形が合わなければ、黙って続けずにエラーを投げる。
// 個人情報（お客様の情報・撮影の内容）は PII のアイテムにだけ置き、META・日ごとのアイテム・履歴には入れない（INV-10）。
// ログは出さない（エラーのメッセージにも、属性の名前とキーだけを書き、値は書かない）。
import { randomUUID } from "node:crypto";
import {
  type AttributeValue,
  BatchGetItemCommand,
  type DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  type TransactWriteItem,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import {
  type ExistingBlock,
  type ExistingReservation,
  checkAvailability,
  checkSecondHoldApplication,
  occupiedRange,
} from "@zebra/booking-core";
import { ReservationStatus, Yen } from "@zebra/contracts";
import { DateTime } from "luxon";

/** 読み書きするテーブル。テストからは DynamoDB Local のクライアントと、テストで作ったテーブルの名前を渡す */
export interface ReservationStore {
  readonly client: DynamoDBClient;
  readonly tableName: string;
}

/** 申込の種類。firm＝本予約申込、provisional＝仮予約申込、second-hold＝第二キープ申込 */
export type ApplicationKind = "firm" | "provisional" | "second-hold";

/** お客様の情報（個人情報。INV-10）。会社名は任意（booking.md「申込フォーム」） */
export interface CustomerInfo {
  readonly name: string;
  readonly companyName?: string;
  readonly email: string;
  readonly phone: string;
  readonly address: string;
  readonly photographerName: string;
}

/** 撮影内容の選択肢：still＝スチール撮影、movie＝ムービー撮影、music＝楽器の演奏を伴う撮影 */
export type ShootingType = "still" | "movie" | "music";

/** 撮影の内容（自由記述の欄は個人情報として扱う。INV-10）。補足事項は任意 */
export interface ShootingInfo {
  readonly types: readonly ShootingType[];
  readonly details: string;
  readonly notes?: string;
}

/** 見積額（calculatePriceFromTable の結果と同じ形。INV-9） */
export interface Estimate {
  readonly subtotalExcludingTax: Yen;
  readonly estimateIncludingTax: Yen;
}

/** フォームからの申込。中身の検証と料金の計算は、API の層で済ませてから渡す */
export interface ReservationApplication {
  readonly kind: ApplicationKind;
  /** 予約区間 [start, end)。どのゾーンで表した DateTime でもよい（保存は UTC。INV-7） */
  readonly start: DateTime;
  readonly end: DateTime;
  readonly partySize: number;
  readonly cycloramaFloorProtection: boolean;
  readonly planId: string;
  readonly equipmentInsurance: boolean;
  readonly optionIds: readonly string[];
  readonly estimate: Estimate;
  readonly customer: CustomerInfo;
  readonly shooting: ShootingInfo;
}

export interface SaveApplicationOptions {
  /** 現在時刻（作成日時・更新日時・履歴の日時。INV-7） */
  readonly now: DateTime;
  /** 読む → 判定 → 書く を試す回数の上限（1 以上）。省略したときの値は実装が決める */
  readonly maxAttempts?: number;
  /**
   * 試すたびに、判定が受付になったあと、TransactWriteItems の直前に呼ぶ（attempt は 1 から）。
   * 判定が不可なら呼ばない。テストで、読んだあとに別の書き込みが入る状況を作るためのもの
   */
  readonly beforeWrite?: (attempt: number) => Promise<void>;
}

/**
 * 申込の保存の結果
 * - 受付：{ ok: true, id }。id は保存した予約の id（この関数が決める）
 * - 不可（枠を確保している予約かブロック枠と重なる）：{ ok: false, reason: "overlaps-existing" }
 * - 不可（第二キープ申込が、どの承認済みの仮予約とも重ならない）：{ ok: false, reason: "no-provisional-to-hold" }
 * - 混み合っている（版番号の衝突が続き、試す回数の上限を超えた）：{ ok: false, reason: "busy" }
 * 不可や混み合っているときは、何も書かない（INV-2）
 */
export type SaveApplicationResult =
  | { readonly ok: true; readonly id: string }
  | {
      readonly ok: false;
      readonly reason: "overlaps-existing" | "no-provisional-to-hold" | "busy";
    };

/**
 * 申込（仮予約・本予約・第二キープ）を保存する。状態は承認待ち（pending-*）、バッファは 60 分、経路はフォーム。
 * かかわる JST の日の日ごとのアイテムを強い整合性で読み、booking-core で重なりを判定し、
 * 日ごとのアイテム・予約（META）・個人情報（PII）・履歴（HIST#…）を 1 回の TransactWriteItems で書く
 */
export async function saveApplication(
  store: ReservationStore,
  application: ReservationApplication,
  options: SaveApplicationOptions,
): Promise<SaveApplicationResult> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("maxAttempts は 1 以上の整数");
  }
  if (!options.now.isValid) {
    throw new RangeError("現在時刻が不正");
  }

  const id = randomUUID();
  const status = PENDING_STATUS[application.kind];
  // 占有区間 [start, end + バッファ)。区間が不正（終了が開始以前など）なら booking-core が RangeError を投げる
  const occupied = occupiedRange(application, APPLICATION_BUFFER_MINUTES);
  const days = jstDaysOf(occupied.start, occupied.end);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 1. かかわる JST の日の日ごとのアイテムを、強い整合性で読む
    const dayStates = await Promise.all(days.map((day) => readDayForWrite(store, day)));

    // 2. booking-core で重なりを判定する（同じ占有区間が2日に入っていても、判定の結果は変わらない）
    const intervals = dayStates.flatMap((state) => state.intervals);
    const judged = judge(application, intervals);
    if (!judged.ok) return judged;

    // 3. 日ごとのアイテム（版番号の条件つき）・META・PII・履歴を、1回の TransactWriteItems で書く
    const newInterval: OccupiedInterval = {
      kind: "reservation",
      id,
      status,
      ...(judged.provisionalIds === undefined ? {} : { provisionalIds: judged.provisionalIds }),
      start: occupied.start,
      end: occupied.end,
    };
    const transactItems: TransactWriteItem[] = [
      ...dayStates.map((state) => dayWriteItem(store, state, newInterval)),
      ...reservationWriteItems(store, id, status, application, judged.provisionalIds, options.now),
    ];

    if (options.beforeWrite !== undefined) await options.beforeWrite(attempt);

    try {
      await store.client.send(new TransactWriteItemsCommand({ TransactItems: transactItems }));
      return { ok: true, id };
    } catch (error) {
      // 4. 条件で失敗した（読んだあとに同じ日に別の書き込みがあった）なら、読み直してやり直す
      if (isRetryableConflict(error)) continue;
      throw error;
    }
  }
  return { ok: false, reason: "busy" };
}

/** 日ごとのアイテムの占有区間（dynamodb-keys.md「アイテム」の intervals の1件） */
export interface OccupiedInterval {
  readonly kind: "reservation" | "block";
  readonly id: string;
  /** 予約だけが持つ */
  readonly status?: ReservationStatus;
  /** 第二キープ（承認待ちを含む）だけが持つ。付く仮予約の id */
  readonly provisionalIds?: readonly string[];
  /** 占有区間 [start, end)（バッファ込み） */
  readonly start: DateTime;
  readonly end: DateTime;
}

/**
 * 期間（JST の日付 YYYY-MM-DD。from と to を含む）の日ごとのアイテムから、占有区間を読み出す（空き状況に使う）。
 * 日をまたいで2日以上のアイテムに入っている占有区間も、1件として返す。並び順は決めない。
 * 予約の META や個人情報は読まない
 */
export async function readOccupiedIntervals(
  store: ReservationStore,
  days: { readonly from: string; readonly to: string },
): Promise<OccupiedInterval[]> {
  const keys = daysBetween(days.from, days.to).map(dayKey);
  const items: Item[] = [];
  for (let i = 0; i < keys.length; i += BATCH_GET_LIMIT) {
    items.push(...(await batchGet(store, keys.slice(i, i + BATCH_GET_LIMIT))));
  }

  // 日をまたぐ占有区間は2日以上のアイテムに入っているので、種類と id で1件にまとめる
  const seen = new Map<string, OccupiedInterval>();
  for (const item of items) {
    const day = readString(item, "pk", "DAY#").slice("DAY#".length);
    for (const interval of parseDayItem(day, item).intervals) {
      const key = `${interval.kind}#${interval.id}`;
      if (!seen.has(key)) seen.set(key, interval);
    }
  }
  return [...seen.values()];
}

/** BatchGetItem で1回に読めるキーの数 */
const BATCH_GET_LIMIT = 100;

/** BatchGetItem の読み残し（UnprocessedKeys）を読み直す回数の上限 */
const BATCH_GET_MAX_RETRIES = 8;

/** 強い整合性の BatchGetItem（1回に BATCH_GET_LIMIT 件まで）。読み残しは読み直す */
export async function batchGet(store: ReservationStore, keys: Item[]): Promise<Item[]> {
  const items: Item[] = [];
  let pending: Item[] = keys;
  for (let retry = 0; pending.length > 0; retry++) {
    if (retry > BATCH_GET_MAX_RETRIES) {
      throw new Error("日ごとのアイテムを読み切れなかった（BatchGetItem の読み残しが続いた）");
    }
    if (retry > 0) await sleep(BATCH_GET_BACKOFF_MS * 2 ** (retry - 1));
    const res = await store.client.send(
      new BatchGetItemCommand({
        RequestItems: { [store.tableName]: { Keys: pending, ConsistentRead: true } },
      }),
    );
    items.push(...(res.Responses?.[store.tableName] ?? []));
    pending = res.UnprocessedKeys?.[store.tableName]?.Keys ?? [];
  }
  return items;
}

const BATCH_GET_BACKOFF_MS = 50;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** JST の日付 from〜to（両端を含む）の一覧。日付の形（YYYY-MM-DD）が不正か、from が to より後なら RangeError */
function daysBetween(from: string, to: string): string[] {
  const first = parseIsoDate(from);
  const last = parseIsoDate(to);
  if (first.toMillis() > last.toMillis()) {
    throw new RangeError("期間の from が to より後");
  }
  const days: string[] = [];
  for (let day = first; day.toMillis() <= last.toMillis(); day = day.plus({ days: 1 })) {
    days.push(day.toISODate() ?? "");
  }
  return days;
}

function parseIsoDate(value: string): DateTime {
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? DateTime.fromISO(value, { zone: JST })
    : DateTime.invalid("not YYYY-MM-DD");
  if (!parsed.isValid) throw new RangeError("日付は YYYY-MM-DD");
  return parsed;
}

/** 履歴の「誰が」 */
export type HistoryActor =
  | { readonly kind: "customer" }
  | { readonly kind: "admin"; readonly userId: string }
  | { readonly kind: "system" };

/** 履歴の操作（reservation-model.md「履歴」） */
export type HistoryOperation =
  | "apply"
  | "approve"
  | "reject"
  | "promote"
  | "end"
  | "cancel"
  | "move-up"
  | "change"
  | "buffer-change"
  | "direct-entry";

/** 履歴に残す、操作の前後の値 */
export interface HistorySnapshot {
  readonly status: ReservationStatus;
  readonly start: DateTime;
  readonly end: DateTime;
  readonly bufferMinutes: 30 | 60;
  readonly confirmedPrice?: Yen;
  readonly provisionalIds?: readonly string[];
  /** 申込の内容（変更の履歴で、中身の前後を残すときに持つ。reservation-model.md「金額」「履歴」） */
  readonly partySize?: number;
  readonly cycloramaFloorProtection?: boolean;
  readonly planId?: string;
  readonly equipmentInsurance?: boolean;
  readonly optionIds?: readonly string[];
}

export interface HistoryEntry {
  /** 操作の日時 */
  readonly at: DateTime;
  readonly actor: HistoryActor;
  readonly operation: HistoryOperation;
  /** 操作の前。申込・直接入力にはない */
  readonly before?: HistorySnapshot;
  readonly after?: HistorySnapshot;
  /** お客様の情報や撮影の内容が変わったときの、変わった項目の名前だけ（中身は書かない） */
  readonly changedFields?: readonly string[];
  /** 変更のときに料金表で計算し直した見積（reservation-model.md「金額」） */
  readonly estimate?: Estimate;
}

/** 予約の詳細（META・PII・履歴） */
export interface ReservationDetail {
  readonly id: string;
  readonly status: ReservationStatus;
  /** 予約区間 [start, end) */
  readonly start: DateTime;
  readonly end: DateTime;
  readonly bufferMinutes: 30 | 60;
  /** 経路：form＝フォームの申込、admin＝管理者の直接入力 */
  readonly route: "form" | "admin";
  readonly partySize: number;
  readonly cycloramaFloorProtection: boolean;
  readonly planId: string;
  readonly equipmentInsurance: boolean;
  readonly optionIds: readonly string[];
  readonly estimate: Estimate;
  /** 確定金額（税込）。承認待ちのあいだはない */
  readonly confirmedPrice?: Yen;
  /** 第二キープ（承認待ちを含む）だけが持つ。付く仮予約の id */
  readonly provisionalIds?: readonly string[];
  readonly createdAt: DateTime;
  readonly updatedAt: DateTime;
  readonly customer: CustomerInfo;
  readonly shooting: ShootingInfo;
  /** 古い順 */
  readonly history: readonly HistoryEntry[];
}

/** 予約の詳細を読み出す（`RES#<id>` を Query）。ない id なら null */
export async function getReservation(
  store: ReservationStore,
  id: string,
): Promise<ReservationDetail | null> {
  const pk = `RES#${id}`;
  const items: Item[] = [];
  let startKey: Item | undefined;
  do {
    const res = await store.client.send(
      new QueryCommand({
        TableName: store.tableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": { S: pk } },
        ConsistentRead: true,
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...(res.Items ?? []));
    startKey = res.LastEvaluatedKey;
  } while (startKey !== undefined);

  const meta = items.find((item) => item["sk"]?.S === "META");
  if (meta === undefined) return null;
  const pii = items.find((item) => item["sk"]?.S === "PII");
  if (pii === undefined) throw malformed(pk, "PII のアイテム");
  // HIST#<日時（UTC）>#<連番> は文字列の順で古い順に並ぶ
  const history = items
    .filter((item) => item["sk"]?.S?.startsWith("HIST#") === true)
    .sort((a, b) => (a["sk"]?.S ?? "").localeCompare(b["sk"]?.S ?? ""))
    .map((item) => parseHistory(item, `${pk} ${item["sk"]?.S ?? ""}`));

  return {
    ...parseReservationMeta(id, meta),
    customer: parseCustomer(readMap(pii, "customer", `${pk} PII`), `${pk} PII`),
    shooting: parseShooting(readMap(pii, "shooting", `${pk} PII`), `${pk} PII`),
    history,
  };
}

/** 予約の META の中身（個人情報と履歴を除いた、予約の詳細） */
export type ReservationMeta = Omit<ReservationDetail, "customer" | "shooting" | "history">;

/** 予約の META のアイテムを読む。形が合わなければエラーを投げる（INV-4） */
export function parseReservationMeta(id: string, meta: Item): ReservationMeta {
  const where = `RES#${id} META`;
  const estimate = readMap(meta, "estimate", where);
  const route = readString(meta, "route", where);
  if (route !== "form" && route !== "admin") throw malformed(where, "route");
  const confirmedPrice =
    meta["confirmedPrice"] === undefined ? undefined : readYen(meta, "confirmedPrice", where);
  const provisionalIds = readOptionalStringList(meta, "provisionalIds", where);
  return {
    id,
    status: readStatus(meta, "status", where),
    start: readInstant(meta, "start", where),
    end: readInstant(meta, "end", where),
    bufferMinutes: readBufferMinutes(meta, "bufferMinutes", where),
    route,
    partySize: readNumber(meta, "partySize", where),
    cycloramaFloorProtection: readBoolean(meta, "cycloramaFloorProtection", where),
    planId: readString(meta, "planId", where),
    equipmentInsurance: readBoolean(meta, "equipmentInsurance", where),
    optionIds: readStringList(meta, "optionIds", where),
    estimate: {
      subtotalExcludingTax: readYen(estimate, "subtotalExcludingTax", where),
      estimateIncludingTax: readYen(estimate, "estimateIncludingTax", where),
    },
    ...(confirmedPrice === undefined ? {} : { confirmedPrice }),
    ...(provisionalIds === undefined ? {} : { provisionalIds }),
    createdAt: readInstant(meta, "createdAt", where),
    updatedAt: readInstant(meta, "updatedAt", where),
  };
}

// ---- 内部の部品 ----

/** maxAttempts を省略したときの、試す回数の上限 */
export const DEFAULT_MAX_ATTEMPTS = 5;

/** 申込のバッファ（reservation-model.md「予約が持つもの」。初期値は60分） */
const APPLICATION_BUFFER_MINUTES = 60;

/** 日の区切りに使うタイムゾーン（INV-7。dynamodb-keys.md「アイテム」） */
export const JST = "Asia/Tokyo";

const PENDING_STATUS = {
  firm: "pending-firm",
  provisional: "pending-provisional",
  "second-hold": "pending-second-hold",
} as const satisfies Record<ApplicationKind, ReservationStatus>;

type Judgement =
  | { readonly ok: true; readonly provisionalIds?: readonly string[] }
  | { readonly ok: false; readonly reason: "overlaps-existing" | "no-provisional-to-hold" };

/** 読んだ占有区間から booking-core の入力を組み立てて判定する。判定そのものは booking-core が行う */
function judge(
  application: ReservationApplication,
  intervals: readonly OccupiedInterval[],
): Judgement {
  const { reservations, blocks } = toBookingCoreInput(intervals);
  const input = {
    start: application.start,
    end: application.end,
    bufferMinutes: APPLICATION_BUFFER_MINUTES,
    reservations,
    blocks,
  } as const;
  if (application.kind === "second-hold") {
    const result = checkSecondHoldApplication(input);
    return result.ok ? { ok: true, provisionalIds: result.provisionalIds } : result;
  }
  return checkAvailability(input);
}

/** 予約区間を表すときのバッファ（分）。占有区間から booking-core の入力に戻すときに使う */
const RESTORED_BUFFER_MINUTES = 30;

/**
 * 日ごとのアイテムの占有区間（バッファ込み）を、booking-core の入力（区間＋バッファ）に直す。
 * 日ごとのアイテムはバッファの長さを持たないので、
 * - ブロック枠：区間＝占有区間、バッファ0分
 * - 予約：区間＝[start, end − 30分)、バッファ30分（booking-core が求める占有区間は、もとの占有区間とちょうど同じ）
 * とする。予約のバッファ（ReservationBufferMinutes）に0分がないため。
 * 同じ占有区間が2日のアイテムに入っていても、判定の結果は変わらないので、そのまま渡す
 */
function toBookingCoreInput(intervals: readonly OccupiedInterval[]): {
  reservations: ExistingReservation[];
  blocks: ExistingBlock[];
} {
  const reservations: ExistingReservation[] = [];
  const blocks: ExistingBlock[] = [];
  for (const interval of intervals) {
    if (interval.kind === "block") {
      blocks.push({ start: interval.start, end: interval.end, bufferMinutes: 0 });
      continue;
    }
    if (interval.status === undefined) {
      throw new Error(`日ごとのアイテムの予約の占有区間に状態がない（id: ${interval.id}）`);
    }
    reservations.push({
      id: interval.id,
      status: interval.status,
      start: interval.start,
      end: interval.end.minus({ minutes: RESTORED_BUFFER_MINUTES }),
      bufferMinutes: RESTORED_BUFFER_MINUTES,
    });
  }
  return { reservations, blocks };
}

/**
 * 占有区間 [start, end) がかかる JST の日付（YYYY-MM-DD）の一覧。
 * 半開区間なので、ちょうど JST の 0:00 で終わるときは、その日は含めない
 */
export function jstDaysOf(start: DateTime, end: DateTime): string[] {
  const days: string[] = [];
  const endMillis = end.toMillis();
  for (
    let day = start.setZone(JST).startOf("day");
    day.toMillis() < endMillis;
    day = day.plus({ days: 1 })
  ) {
    days.push(day.toISODate() ?? "");
  }
  return days;
}

/** 書き込みのために読んだ日ごとのアイテム。version が null ならアイテムはまだない */
export interface DayState {
  readonly day: string;
  readonly version: number | null;
  readonly intervals: readonly OccupiedInterval[];
}

export async function readDayForWrite(store: ReservationStore, day: string): Promise<DayState> {
  const res = await store.client.send(
    new GetItemCommand({
      TableName: store.tableName,
      Key: dayKey(day),
      ConsistentRead: true,
    }),
  );
  if (res.Item === undefined) return { day, version: null, intervals: [] };
  return parseDayItem(day, res.Item);
}

export function dayKey(day: string): Record<string, AttributeValue> {
  return { pk: { S: `DAY#${day}` }, sk: { S: "META" } };
}

/**
 * 日ごとのアイテムへの書き込み。版番号が読んだときと同じ（まだないなら、まだないこと）を条件にし、
 * 版番号を1増やして占有区間を足す。すでにある占有区間は書き換えない
 */
function dayWriteItem(
  store: ReservationStore,
  state: DayState,
  added: OccupiedInterval,
): TransactWriteItem {
  const addedAttribute = intervalAttribute(added);
  if (state.version === null) {
    return {
      Put: {
        TableName: store.tableName,
        Item: {
          ...dayKey(state.day),
          version: { N: "1" },
          intervals: { L: [addedAttribute] },
        },
        ConditionExpression: "attribute_not_exists(pk)",
      },
    };
  }
  return {
    Update: {
      TableName: store.tableName,
      Key: dayKey(state.day),
      UpdateExpression:
        "SET #version = :next, #intervals = list_append(if_not_exists(#intervals, :empty), :added)",
      ConditionExpression: "#version = :read",
      ExpressionAttributeNames: { "#version": "version", "#intervals": "intervals" },
      ExpressionAttributeValues: {
        ":read": { N: String(state.version) },
        ":next": { N: String(state.version + 1) },
        ":empty": { L: [] },
        ":added": { L: [addedAttribute] },
      },
    },
  };
}

/** 予約の META・PII・履歴（申込の1件）の書き込み */
function reservationWriteItems(
  store: ReservationStore,
  id: string,
  status: ReservationStatus,
  application: ReservationApplication,
  provisionalIds: readonly string[] | undefined,
  now: DateTime,
): TransactWriteItem[] {
  const pk = `RES#${id}`;
  const start = utcIso(application.start);
  const at = utcIso(now);
  const provisionalIdsAttribute: Record<string, AttributeValue> =
    provisionalIds === undefined ? {} : { provisionalIds: stringList(provisionalIds) };

  const meta: Record<string, AttributeValue> = {
    pk: { S: pk },
    sk: { S: "META" },
    status: { S: status },
    start: { S: start },
    end: { S: utcIso(application.end) },
    bufferMinutes: { N: String(APPLICATION_BUFFER_MINUTES) },
    route: { S: "form" },
    partySize: { N: String(application.partySize) },
    cycloramaFloorProtection: { BOOL: application.cycloramaFloorProtection },
    planId: { S: application.planId },
    equipmentInsurance: { BOOL: application.equipmentInsurance },
    optionIds: stringList(application.optionIds),
    estimate: {
      M: {
        subtotalExcludingTax: { N: String(application.estimate.subtotalExcludingTax) },
        estimateIncludingTax: { N: String(application.estimate.estimateIncludingTax) },
      },
    },
    ...provisionalIdsAttribute,
    createdAt: { S: at },
    updatedAt: { S: at },
    // 承認待ちの一覧・期限の警告に使う GSI（取消・終了になったら、この2つの属性を消す）
    gsi1pk: { S: `STATUS#${status}` },
    gsi1sk: { S: start },
  };

  const { customer, shooting } = application;
  const pii: Record<string, AttributeValue> = {
    pk: { S: pk },
    sk: { S: "PII" },
    customer: {
      M: {
        name: { S: customer.name },
        ...(customer.companyName === undefined ? {} : { companyName: { S: customer.companyName } }),
        email: { S: customer.email },
        phone: { S: customer.phone },
        address: { S: customer.address },
        photographerName: { S: customer.photographerName },
      },
    },
    shooting: {
      M: {
        types: stringList(shooting.types),
        details: { S: shooting.details },
        ...(shooting.notes === undefined ? {} : { notes: { S: shooting.notes } }),
      },
    },
  };

  const history: Record<string, AttributeValue> = {
    pk: { S: pk },
    sk: { S: historySortKey(at, 1) },
    at: { S: at },
    actor: { M: { kind: { S: "customer" } } },
    operation: { S: "apply" },
    after: {
      M: {
        status: { S: status },
        start: { S: start },
        end: { S: utcIso(application.end) },
        bufferMinutes: { N: String(APPLICATION_BUFFER_MINUTES) },
        ...provisionalIdsAttribute,
      },
    },
  };

  // 予約の id は新しく作るので、同じキーのアイテムはないはず。あれば上書きせずに失敗させる
  const notExists = "attribute_not_exists(pk)";
  return [meta, pii, history].map((item) => ({
    Put: { TableName: store.tableName, Item: item, ConditionExpression: notExists },
  }));
}

/** 履歴のソートキー HIST#<日時（UTC）>#<連番>。連番は同じ日時の履歴を並べるためのもので、1から4桁で埋める */
export function historySortKey(atUtcIso: string, sequence: number): string {
  return `HIST#${atUtcIso}#${String(sequence).padStart(4, "0")}`;
}

/**
 * やり直せる失敗か：トランザクションが、条件（版番号・まだないこと）の失敗か、
 * 同じアイテムへの別のトランザクションとの衝突で取り消された
 */
export function isRetryableConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TransactionConflictException") return true;
  if (error.name !== "TransactionCanceledException") return false;
  const reasons = (error as { CancellationReasons?: readonly { Code?: string }[] })
    .CancellationReasons;
  if (reasons === undefined) return false;
  const codes = reasons.map((reason) => reason.Code ?? "None");
  return (
    codes.some((code) => code === "ConditionalCheckFailed" || code === "TransactionConflict") &&
    codes.every(
      (code) =>
        code === "None" || code === "ConditionalCheckFailed" || code === "TransactionConflict",
    )
  );
}

// ---- 属性の形の変換（DynamoDB の AttributeValue と、普通の値） ----

/** UTC の ISO 8601（INV-7）。どのゾーンで表した DateTime でも、同じ時点の UTC にする */
export function utcIso(dateTime: DateTime): string {
  const iso = dateTime.toUTC().toISO();
  if (iso === null) throw new RangeError("日時が不正");
  return iso;
}

export function stringList(values: readonly string[]): AttributeValue {
  return { L: values.map((value) => ({ S: value })) };
}

export function intervalAttribute(interval: OccupiedInterval): AttributeValue {
  return {
    M: {
      kind: { S: interval.kind },
      id: { S: interval.id },
      ...(interval.status === undefined ? {} : { status: { S: interval.status } }),
      ...(interval.provisionalIds === undefined
        ? {}
        : { provisionalIds: stringList(interval.provisionalIds) }),
      start: { S: utcIso(interval.start) },
      end: { S: utcIso(interval.end) },
    },
  };
}

export type Item = Record<string, AttributeValue>;

/** DB から読んだ値の形が合わないときのエラー。値は書かない（個人情報を含むことがあるため。INV-10） */
export function malformed(where: string, attribute: string): Error {
  return new Error(`DB のアイテムの形が不正（${where} の ${attribute}）`);
}

export function readString(item: Item, attribute: string, where: string): string {
  const value = item[attribute]?.S;
  if (value === undefined) throw malformed(where, attribute);
  return value;
}

function readOptionalString(item: Item, attribute: string, where: string): string | undefined {
  if (item[attribute] === undefined) return undefined;
  return readString(item, attribute, where);
}

function readNumber(item: Item, attribute: string, where: string): number {
  const raw = item[attribute]?.N;
  const value = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isFinite(value)) throw malformed(where, attribute);
  return value;
}

function readBoolean(item: Item, attribute: string, where: string): boolean {
  const value = item[attribute]?.BOOL;
  if (value === undefined) throw malformed(where, attribute);
  return value;
}

function readMap(item: Item, attribute: string, where: string): Item {
  const value = item[attribute]?.M;
  if (value === undefined) throw malformed(where, attribute);
  return value;
}

function readStringList(item: Item, attribute: string, where: string): string[] {
  const list = item[attribute]?.L;
  if (list === undefined) throw malformed(where, attribute);
  return list.map((element) => {
    if (element.S === undefined) throw malformed(where, attribute);
    return element.S;
  });
}

function readOptionalStringList(
  item: Item,
  attribute: string,
  where: string,
): string[] | undefined {
  if (item[attribute] === undefined) return undefined;
  return readStringList(item, attribute, where);
}

function readInstant(item: Item, attribute: string, where: string): DateTime {
  const value = DateTime.fromISO(readString(item, attribute, where), { zone: "utc" });
  if (!value.isValid) throw malformed(where, attribute);
  return value;
}

function readStatus(item: Item, attribute: string, where: string): ReservationStatus {
  const parsed = ReservationStatus.safeParse(readString(item, attribute, where));
  if (!parsed.success) throw malformed(where, attribute);
  return parsed.data;
}

function readYen(item: Item, attribute: string, where: string): Yen {
  const parsed = Yen.safeParse(readNumber(item, attribute, where));
  if (!parsed.success) throw malformed(where, attribute);
  return parsed.data;
}

function readBufferMinutes(item: Item, attribute: string, where: string): 30 | 60 {
  const value = readNumber(item, attribute, where);
  if (value !== 30 && value !== 60) throw malformed(where, attribute);
  return value;
}

function parseDayItem(day: string, item: Item): DayState {
  const where = `DAY#${day}`;
  const version = readNumber(item, "version", where);
  if (!Number.isInteger(version) || version < 1) throw malformed(where, "version");
  const list = item["intervals"] === undefined ? [] : item["intervals"].L;
  if (list === undefined) throw malformed(where, "intervals");
  const intervals = list.map((element) => {
    if (element.M === undefined) throw malformed(where, "intervals");
    return parseInterval(element.M, where);
  });
  return { day, version, intervals };
}

function parseInterval(map: Item, where: string): OccupiedInterval {
  const at = `${where} の intervals`;
  const kind = readString(map, "kind", at);
  if (kind !== "reservation" && kind !== "block") throw malformed(at, "kind");
  const id = readString(map, "id", at);
  const status = map["status"] === undefined ? undefined : readStatus(map, "status", at);
  if (kind === "reservation" && status === undefined) throw malformed(at, "status");
  const provisionalIds = readOptionalStringList(map, "provisionalIds", at);
  const start = readInstant(map, "start", at);
  const end = readInstant(map, "end", at);
  if (end.toMillis() <= start.toMillis()) throw malformed(at, "end");
  return {
    kind,
    id,
    ...(status === undefined ? {} : { status }),
    ...(provisionalIds === undefined ? {} : { provisionalIds }),
    start,
    end,
  };
}

function parseSnapshot(map: Item, where: string): HistorySnapshot {
  const confirmedPrice =
    map["confirmedPrice"] === undefined ? undefined : readYen(map, "confirmedPrice", where);
  const provisionalIds = readOptionalStringList(map, "provisionalIds", where);
  const partySize =
    map["partySize"] === undefined ? undefined : readNumber(map, "partySize", where);
  const cycloramaFloorProtection =
    map["cycloramaFloorProtection"] === undefined
      ? undefined
      : readBoolean(map, "cycloramaFloorProtection", where);
  const planId = readOptionalString(map, "planId", where);
  const equipmentInsurance =
    map["equipmentInsurance"] === undefined
      ? undefined
      : readBoolean(map, "equipmentInsurance", where);
  const optionIds = readOptionalStringList(map, "optionIds", where);
  return {
    status: readStatus(map, "status", where),
    start: readInstant(map, "start", where),
    end: readInstant(map, "end", where),
    bufferMinutes: readBufferMinutes(map, "bufferMinutes", where),
    ...(confirmedPrice === undefined ? {} : { confirmedPrice }),
    ...(provisionalIds === undefined ? {} : { provisionalIds }),
    ...(partySize === undefined ? {} : { partySize }),
    ...(cycloramaFloorProtection === undefined ? {} : { cycloramaFloorProtection }),
    ...(planId === undefined ? {} : { planId }),
    ...(equipmentInsurance === undefined ? {} : { equipmentInsurance }),
    ...(optionIds === undefined ? {} : { optionIds }),
  };
}

function parseActor(map: Item, where: string): HistoryActor {
  const kind = readString(map, "kind", where);
  switch (kind) {
    case "customer":
    case "system":
      return { kind };
    case "admin":
      return { kind, userId: readString(map, "userId", where) };
    default:
      throw malformed(where, "actor.kind");
  }
}

const HISTORY_OPERATIONS: ReadonlySet<string> = new Set<HistoryOperation>([
  "apply",
  "approve",
  "reject",
  "promote",
  "end",
  "cancel",
  "move-up",
  "change",
  "buffer-change",
  "direct-entry",
]);

function parseHistory(item: Item, where: string): HistoryEntry {
  const operation = readString(item, "operation", where);
  if (!HISTORY_OPERATIONS.has(operation)) throw malformed(where, "operation");
  const before =
    item["before"] === undefined ? undefined : parseSnapshot(readMap(item, "before", where), where);
  const after =
    item["after"] === undefined ? undefined : parseSnapshot(readMap(item, "after", where), where);
  const changedFields = readOptionalStringList(item, "changedFields", where);
  const estimateMap = item["estimate"] === undefined ? undefined : readMap(item, "estimate", where);
  const estimate =
    estimateMap === undefined
      ? undefined
      : {
          subtotalExcludingTax: readYen(estimateMap, "subtotalExcludingTax", where),
          estimateIncludingTax: readYen(estimateMap, "estimateIncludingTax", where),
        };
  return {
    at: readInstant(item, "at", where),
    actor: parseActor(readMap(item, "actor", where), where),
    operation: operation as HistoryOperation,
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
    ...(changedFields === undefined ? {} : { changedFields }),
    ...(estimate === undefined ? {} : { estimate }),
  };
}

const SHOOTING_TYPES: ReadonlySet<string> = new Set<ShootingType>(["still", "movie", "music"]);

function parseCustomer(map: Item, where: string): CustomerInfo {
  const companyName = readOptionalString(map, "companyName", where);
  return {
    name: readString(map, "name", where),
    ...(companyName === undefined ? {} : { companyName }),
    email: readString(map, "email", where),
    phone: readString(map, "phone", where),
    address: readString(map, "address", where),
    photographerName: readString(map, "photographerName", where),
  };
}

function parseShooting(map: Item, where: string): ShootingInfo {
  const types = readStringList(map, "types", where);
  if (!types.every((type) => SHOOTING_TYPES.has(type))) throw malformed(where, "types");
  const notes = readOptionalString(map, "notes", where);
  return {
    types: types as ShootingType[],
    details: readString(map, "details", where),
    ...(notes === undefined ? {} : { notes }),
  };
}
