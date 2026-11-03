// ブロック枠の保存（管理者が入れる・消す・直す）と読み出し（docs/product-specs/booking.md
// 「管理者による予約の直接入力とブロック枠」の「ブロック枠のバッファ」「ブロック枠を消す・直す」、dynamodb-keys.md）。
// Googleカレンダーの取り込みは扱わない（別の PR）。
// 判定（30分単位、空き判定）は booking-core（checkAdminBlock）に任せる。最長90日（占有区間がかかる JST の日。直すときは
// 直す前と直したあとの和集合）は、1トランザクションで書く日ごとのアイテムの数の決まりなので、この層で確かめる。
// この層は「読む → 判定 → 1トランザクションで書く（版番号が読んだときと同じこと）→ 衝突したら読み直す」を行う。
// 日ごとのアイテムの読み書き・占有区間の変換・やり直しは、申込と操作の保存（reservations.ts、operations.ts）と共有する。
// ブロック枠には記録（履歴）を持たない（booking.md「ブロック枠を消す・直す」）。ログは出さない
import { randomUUID } from "node:crypto";
import { type AttributeValue, GetItemCommand } from "@aws-sdk/client-dynamodb";
import {
  type AdminBlockRejection,
  type AdminBlockResult,
  checkAdminBlock,
  occupiedRange,
} from "@zebra/booking-core";
import type { DateTime } from "luxon";
import { dayPutItem } from "./operations.ts";
import {
  type DayState,
  type Item,
  type OccupiedInterval,
  type ReservationStore,
  type WriteStep,
  dayWriteItem,
  jstDaysOf,
  malformed,
  readDayForWrite,
  readInstant,
  readNumber,
  readOptionalString,
  readString,
  toBookingCoreInput,
  utcIso,
  writeWithRetry,
} from "./reservations.ts";

/** 管理者が入れるブロック枠のバッファ（分）。「なし／30分／1時間」 */
export type AdminBlockBufferMinutes = 0 | 30 | 60;

/** 管理者が入れる・直したあとのブロック枠。直すときも、日時・バッファ・メモをすべて渡す（memo がなければメモはない） */
export interface AdminBlockInput {
  start: DateTime;
  end: DateTime;
  bufferMinutes: AdminBlockBufferMinutes;
  /** 理由のメモ（休業、清掃など） */
  memo?: string;
}

export interface SaveBlockOptions {
  /** 版番号の衝突で読み直してやり直す回数の上限（1回目を含む）。超えたら busy */
  maxAttempts?: number;
  /** 読んで判定したあと、書く直前に呼ぶ（テストで同時の書き込みを起こすため）。attempt は1から */
  beforeWrite?: (attempt: number) => Promise<void>;
}

/**
 * ブロック枠を入れる・直すのが不可の理由
 * - not-on-30-minute-boundary：開始か終了が30分単位（JST）でない
 * - overlaps-existing：空き判定（直すときは、直す前の自分の占有区間は除く）
 * - more-than-90-days：占有区間がかかる JST の日が90日を超える。直すときは、直す前と直したあとのかかる日を合わせて数える
 * - busy：版番号の衝突が続き、やり直しの上限を超えた
 */
export type SaveAdminBlockFailureReason =
  "not-on-30-minute-boundary" | "overlaps-existing" | "more-than-90-days" | "busy";

/**
 * ブロック枠を消す・直すのが不可の理由（入れるときの理由に加えて）
 * - not-found：その id のブロック枠がない
 * - google-calendar-block：Googleカレンダーから取り込んだブロック枠（id が gcal-…）。管理者は消したり直したりしない
 */
export type ChangeAdminBlockFailureReason = "not-found" | "google-calendar-block";

export type SaveAdminBlockResult =
  { ok: true; id: string } | { ok: false; reason: SaveAdminBlockFailureReason };

export type UpdateAdminBlockResult =
  { ok: true } | { ok: false; reason: SaveAdminBlockFailureReason | ChangeAdminBlockFailureReason };

export type DeleteAdminBlockResult =
  { ok: true } | { ok: false; reason: ChangeAdminBlockFailureReason | "busy" };

/** 読み出したブロック枠。route は、管理者が入れたもの（admin）か、Googleカレンダーから取り込んだもの（google-calendar）か */
export interface BlockDetail {
  id: string;
  route: "admin" | "google-calendar";
  start: DateTime;
  end: DateTime;
  bufferMinutes: AdminBlockBufferMinutes;
  memo?: string;
}

/**
 * 管理者がブロック枠を入れる。30分単位・空き判定・最長90日を確かめ、日ごとのアイテムとブロック枠（BLK#<id> の META）を
 * 1トランザクションで書く（INV-2）。id は gcal- で始まらない。記録（履歴）は残さない。不可なら何も書かない
 */
export async function saveAdminBlock(
  store: ReservationStore,
  block: AdminBlockInput,
  options: SaveBlockOptions = {},
): Promise<SaveAdminBlockResult> {
  const shape = checkShape(block);
  if (!shape.ok) return shape;
  const days = jstDaysOf(shape.occupied.start, shape.occupied.end);
  if (days.length > MAX_BLOCK_DAYS) return { ok: false, reason: "more-than-90-days" };

  // randomUUID は gcal- で始まらない（Googleカレンダーから取り込んだブロック枠の id と重ならない）
  const id = randomUUID();
  const newInterval = blockInterval(id, shape.occupied, block.bufferMinutes);

  return writeWithRetry<SaveAdminBlockResult>(store, options, async () => {
    // 1. かかる JST の日の日ごとのアイテムを、強い整合性で読む
    const dayStates = await readDays(store, days);

    // 2. booking-core で判定する
    const judged = judge(block, dayStates, undefined);
    if (!judged.ok) return stop(judged);

    // 3. 日ごとのアイテム（版番号の条件つき）とブロック枠の META を、1回の TransactWriteItems で書く
    return {
      kind: "write",
      transactItems: [
        ...dayStates.map((state) => dayWriteItem(store, state, newInterval)),
        {
          Put: {
            TableName: store.tableName,
            Item: blockMetaItem(id, block),
            // id は新しく作るので、同じキーのアイテムはないはず。あれば上書きせずに失敗させる
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
      ],
      result: { ok: true, id },
    };
  });
}

/**
 * 管理者が入れたブロック枠を直す（日時・バッファ・メモ）。直す前の枠の解放と直したあとの枠の確保を1トランザクションで行う。
 * 直す前のブロック枠の記録は残さない。不可なら何も書かない
 */
export async function updateAdminBlock(
  store: ReservationStore,
  id: string,
  block: AdminBlockInput,
  options: SaveBlockOptions = {},
): Promise<UpdateAdminBlockResult> {
  return writeWithRetry<UpdateAdminBlockResult>(store, options, async () => {
    // 1. ブロック枠の META と、直す前と直したあとの占有区間がかかる日の日ごとのアイテムを、強い整合性で読む
    const current = await readAdminBlock(store, id);
    if (!current.ok) return stop(current);
    const shape = checkShape(block);
    if (!shape.ok) return stop(shape);

    const beforeDays = jstDaysOf(current.occupied.start, current.occupied.end);
    const afterDays = jstDaysOf(shape.occupied.start, shape.occupied.end);
    // 書き直す日は、直す前と直したあとにかかる日の和集合（両方にかかる日は1日と数える）
    const days = [...new Set([...beforeDays, ...afterDays])];
    if (days.length > MAX_BLOCK_DAYS) return stop({ ok: false, reason: "more-than-90-days" });
    const dayStates = await readDays(store, days);

    // 2. booking-core で判定する。直す前の自分の占有区間は除く
    const judged = judge(block, dayStates, id);
    if (!judged.ok) return stop(judged);

    // 3. 日ごとのアイテム（直す前の占有区間を外し、直したあとの占有区間を入れる）とブロック枠の META を、1回で書く。
    //    META は、読んだときから変わっていないことを条件にする（読んだあとに、ほかの書き込みが直したり消したりしていない）
    const newInterval = blockInterval(id, shape.occupied, block.bufferMinutes);
    const holding = new Set(afterDays);
    return {
      kind: "write",
      transactItems: [
        ...dayStates.map((state) =>
          dayPutItem(
            store,
            state,
            withoutBlock(state, id).concat(holding.has(state.day) ? [newInterval] : []),
          ),
        ),
        {
          Put: {
            TableName: store.tableName,
            Item: blockMetaItem(id, block),
            ...unchangedSinceRead(current.item),
          },
        },
      ],
      result: { ok: true },
    };
  });
}

/** 管理者が入れたブロック枠を消す。占有区間は空きに戻る。消したブロック枠の記録は残さない。不可なら何も書かない */
export async function deleteAdminBlock(
  store: ReservationStore,
  id: string,
  options: SaveBlockOptions = {},
): Promise<DeleteAdminBlockResult> {
  return writeWithRetry<DeleteAdminBlockResult>(store, options, async () => {
    // 1. ブロック枠の META と、占有区間がかかる日の日ごとのアイテムを、強い整合性で読む
    const current = await readAdminBlock(store, id);
    if (!current.ok) return stop(current);
    const dayStates = await readDays(
      store,
      jstDaysOf(current.occupied.start, current.occupied.end),
    );

    // 2. 消すのは枠を空けるだけなので、空き判定はない
    // 3. 日ごとのアイテムから占有区間を外し、ブロック枠の META を消す（読んだときから変わっていないことを条件にする）
    return {
      kind: "write",
      transactItems: [
        ...dayStates.map((state) => dayPutItem(store, state, withoutBlock(state, id))),
        {
          Delete: {
            TableName: store.tableName,
            Key: blockKey(id),
            ...unchangedSinceRead(current.item),
          },
        },
      ],
      result: { ok: true },
    };
  });
}

/** ブロック枠を読む。ないときは null */
export async function getBlock(store: ReservationStore, id: string): Promise<BlockDetail | null> {
  const item = await getBlockItem(store, id);
  return item === undefined ? null : parseBlockMeta(id, item);
}

// ---- 内部の部品 ----

/** ブロック枠の占有区間がかかる JST の日の上限（booking.md「ブロック枠のバッファ」「ブロック枠を消す・直す」） */
const MAX_BLOCK_DAYS = 90;

/** Googleカレンダーから取り込んだブロック枠の id の始まり（dynamodb-keys.md「アイテム」の gcal-<イベントの id>） */
const CALENDAR_BLOCK_ID_PREFIX = "gcal-";

function stop<R>(result: R): WriteStep<R> {
  return { kind: "stop", result };
}

/**
 * 開始・終了が30分単位（JST）か。判定は booking-core（checkAdminBlock）に任せる。
 * 既存の予約・ブロック枠なしで判定すると、不可になるのは30分単位だけ。入れられるなら占有区間を返す。
 * 日ごとのアイテムを読む前に、占有区間（かかる日）を決めるために使う
 */
function checkShape(block: AdminBlockInput): AdminBlockResult {
  return checkAdminBlock({ ...coreRange(block), reservations: [], blocks: [] });
}

/**
 * 読んだ日ごとのアイテムの占有区間で、booking-core の checkAdminBlock を呼ぶ。
 * exceptId があれば、そのブロック枠（直す前の自分）の占有区間を除く
 */
function judge(
  block: AdminBlockInput,
  dayStates: readonly DayState[],
  exceptId: string | undefined,
): { readonly ok: true } | { readonly ok: false; readonly reason: AdminBlockRejection } {
  const intervals = dayStates
    .flatMap((state) => state.intervals)
    .filter((interval) => !(interval.kind === "block" && interval.id === exceptId));
  const result = checkAdminBlock({ ...coreRange(block), ...toBookingCoreInput(intervals) });
  return result.ok ? { ok: true } : result;
}

function coreRange(
  block: AdminBlockInput,
): Pick<AdminBlockInput, "start" | "end" | "bufferMinutes"> {
  return { start: block.start, end: block.end, bufferMinutes: block.bufferMinutes };
}

async function readDays(store: ReservationStore, days: readonly string[]): Promise<DayState[]> {
  return Promise.all(days.map((day) => readDayForWrite(store, day)));
}

function blockInterval(
  id: string,
  occupied: { start: DateTime; end: DateTime },
  bufferMinutes: AdminBlockBufferMinutes,
): OccupiedInterval {
  return { kind: "block", id, start: occupied.start, end: occupied.end, bufferMinutes };
}

/** その日の占有区間から、そのブロック枠の占有区間を外したもの（ほかの占有区間は読んだまま残す） */
function withoutBlock(state: DayState, id: string): OccupiedInterval[] {
  return state.intervals.filter((interval) => !(interval.kind === "block" && interval.id === id));
}

function blockKey(id: string): Record<string, AttributeValue> {
  return { pk: { S: `BLK#${id}` }, sk: { S: "META" } };
}

/** 管理者が入れたブロック枠の META：区間（UTC。INV-7）、バッファ、経路、理由のメモ（dynamodb-keys.md「アイテム」） */
function blockMetaItem(id: string, block: AdminBlockInput): Item {
  return {
    ...blockKey(id),
    start: { S: utcIso(block.start) },
    end: { S: utcIso(block.end) },
    bufferMinutes: { N: String(block.bufferMinutes) },
    route: { S: "admin" },
    ...(block.memo === undefined ? {} : { memo: { S: block.memo } }),
  };
}

/** META が読んだときと同じ（区間・バッファ・メモ）であることの条件。読んだあとに、ほかの書き込みが直したり消したりしていない */
function unchangedSinceRead(read: Item): {
  ConditionExpression: string;
  ExpressionAttributeNames: Record<string, string>;
  ExpressionAttributeValues: Record<string, AttributeValue>;
} {
  const names: Record<string, string> = {};
  const values: Record<string, AttributeValue> = {};
  const conditions: string[] = [];
  for (const [index, attribute] of ["start", "end", "bufferMinutes", "memo"].entries()) {
    names[`#a${index}`] = attribute;
    const value = read[attribute];
    if (value === undefined) {
      conditions.push(`attribute_not_exists(#a${index})`);
    } else {
      values[`:a${index}`] = value;
      conditions.push(`#a${index} = :a${index}`);
    }
  }
  return {
    ConditionExpression: conditions.join(" AND "),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
}

async function getBlockItem(store: ReservationStore, id: string): Promise<Item | undefined> {
  const res = await store.client.send(
    new GetItemCommand({ TableName: store.tableName, Key: blockKey(id), ConsistentRead: true }),
  );
  return res.Item;
}

/** 管理者が消したり直したりできるブロック枠を読む。ない id は not-found、Googleカレンダーから取り込んだものは google-calendar-block */
async function readAdminBlock(
  store: ReservationStore,
  id: string,
): Promise<
  | {
      readonly ok: true;
      readonly item: Item;
      readonly occupied: { start: DateTime; end: DateTime };
    }
  | { readonly ok: false; readonly reason: ChangeAdminBlockFailureReason }
> {
  const item = await getBlockItem(store, id);
  if (item === undefined) return { ok: false, reason: "not-found" };
  // 取り込んだブロック枠は id（gcal-…）で見分ける。取り込みで更新するので、管理者は消したり直したりしない
  if (id.startsWith(CALENDAR_BLOCK_ID_PREFIX))
    return { ok: false, reason: "google-calendar-block" };
  const detail = parseBlockMeta(id, item);
  return { ok: true, item, occupied: occupiedRange(detail, detail.bufferMinutes) };
}

/** ブロック枠の META を読む。形が合わなければエラーを投げる（INV-4） */
function parseBlockMeta(id: string, item: Item): BlockDetail {
  const where = `BLK#${id} META`;
  const route = readString(item, "route", where);
  if (route !== "admin" && route !== "google-calendar") throw malformed(where, "route");
  const bufferMinutes = readNumber(item, "bufferMinutes", where);
  if (bufferMinutes !== 0 && bufferMinutes !== 30 && bufferMinutes !== 60) {
    throw malformed(where, "bufferMinutes");
  }
  const start = readInstant(item, "start", where);
  const end = readInstant(item, "end", where);
  if (end.toMillis() <= start.toMillis()) throw malformed(where, "end");
  const memo = readOptionalString(item, "memo", where);
  return { id, route, start, end, bufferMinutes, ...(memo === undefined ? {} : { memo }) };
}
