// 管理画面の予約の一覧の読み出し（docs/design-docs/admin-api.md「予約の一覧」、dynamodb-keys.md「読み出し」）。
// - 期間：期間の日ごとのアイテム（DAY#<JST の日付>）を読み、出てくる予約の META・ブロック枠の META と、
//   表示する氏名のためだけに予約の PII を読む
// - 状態だけ：状態の GSI（gsi1pk = STATUS#<状態>、gsi1sk = 開始日時）を読む
// 出るのは枠を確保している予約（承認待ち・仮予約・本予約・第二キープ）とブロック枠だけ。取消・終了は出ない。
// どちらも開始の早い順（開始が同じなら終わりの早い順、それも同じなら id の順）
// 個人情報は、PII のアイテムから氏名の属性だけを読む（ProjectionExpression。ほかの欄は読まない。INV-10 の考え方）。
// DB から読んだ値は、使う前に形を確かめる（INV-4。META の読み方は reservations.ts・blocks.ts と共有する）。ログは出さない。
import { type AttributeValue, QueryCommand } from "@aws-sdk/client-dynamodb";
import { holdsSlots } from "@zebra/booking-core";
import type { HoldingReservationStatus, ReservationStatus, Yen } from "@zebra/contracts";
import type { DateTime } from "luxon";
import { blockKey, parseBlockMeta } from "./blocks.ts";
import {
  type Item,
  type ReservationMeta,
  type ReservationStore,
  batchGet,
  malformed,
  parseReservationMeta,
  readOccupiedIntervals,
  readString,
} from "./reservations.ts";

/** 一覧の予約1件。個人情報は氏名だけ */
export interface AdminListedReservation {
  id: string;
  /** フォームの申込だけが持つ */
  receiptNumber?: string;
  status: HoldingReservationStatus;
  /** 予約区間（バッファを含まない） */
  start: DateTime;
  end: DateTime;
  bufferMinutes: 30 | 60;
  route: "form" | "admin";
  partySize: number;
  /** 申込（または直接入力）のときの見積額（税込） */
  estimateIncludingTax: Yen;
  /** 承認待ちのあいだはない */
  confirmedPrice?: Yen;
  /** 第二キープ（承認待ちを含む）だけが持つ */
  provisionalIds?: readonly string[];
  customerName: string;
}

/** 一覧のブロック枠1件 */
export interface AdminListedBlock {
  id: string;
  /** ブロック枠の区間（バッファを含まない） */
  start: DateTime;
  end: DateTime;
  bufferMinutes: 0 | 30 | 60;
  route: "admin" | "google-calendar";
  memo?: string;
}

export interface AdminListPeriod {
  /** JST の日付 YYYY-MM-DD。両端を含む。長さ（最長62日）と前後は、API の層で確かめる */
  from: string;
  to: string;
  /** 渡すと、期間の中をその状態で絞る（ブロック枠は返さない） */
  status?: HoldingReservationStatus;
}

export interface AdminList {
  reservations: AdminListedReservation[];
  blocks: AdminListedBlock[];
}

/** 期間の日にかかる予約とブロック枠 */
export async function listAdminReservationsInPeriod(
  store: ReservationStore,
  period: AdminListPeriod,
): Promise<AdminList> {
  // 1. 期間の日ごとのアイテムの占有区間（バッファ込み）。日をまたぐものも1件。
  // 「期間の日にかかる」は占有区間で見るので、バッファだけがかかる日の分も入っている（admin-api.md）
  const intervals = await readOccupiedIntervals(store, period);
  const reservationIds = intervals.filter((i) => i.kind === "reservation").map((i) => i.id);
  // 状態で絞るときは、ブロック枠を返さない（読まない）
  const blockIds =
    period.status === undefined ? intervals.filter((i) => i.kind === "block").map((i) => i.id) : [];

  // 2. 予約とブロック枠の META を BatchGet する
  const metaItems = await batchGetAll(store, [
    ...reservationIds.map(reservationMetaKey),
    ...blockIds.map(blockKey),
  ]);
  const byKey = new Map(metaItems.map((item) => [keyOf(item), item]));

  const metas: HoldingMeta[] = [];
  for (const id of reservationIds) {
    const item = byKey.get(`RES#${id} META`);
    if (item === undefined) throw malformed(`RES#${id}`, "META のアイテム");
    const meta = parseReservationMeta(id, item);
    // 日ごとのアイテムと META は同じトランザクションで書くので、取消・終了が混ざることはないはず。
    // 読む間に別の操作で取消・終了になったものは、一覧に出さない
    if (!isHoldingMeta(meta)) continue;
    if (period.status !== undefined && meta.status !== period.status) continue;
    metas.push(meta);
  }

  const blocks = blockIds.map((id) => {
    const item = byKey.get(`BLK#${id} META`);
    if (item === undefined) throw malformed(`BLK#${id}`, "META のアイテム");
    return toListedBlock(parseBlockMeta(id, item));
  });

  return {
    reservations: (await withCustomerNames(store, metas)).sort(byTime),
    blocks: blocks.sort(byTime),
  };
}

/** その状態の予約（期間によらない） */
export async function listAdminReservationsByStatus(
  store: ReservationStore,
  status: HoldingReservationStatus,
): Promise<AdminListedReservation[]> {
  // 1. 状態の GSI を読む（取消・終了は GSI に入らない。dynamodb-keys.md「読み出し」）
  const items: Item[] = [];
  let startKey: Record<string, AttributeValue> | undefined;
  do {
    const res = await store.client.send(
      new QueryCommand({
        TableName: store.tableName,
        IndexName: STATUS_INDEX_NAME,
        KeyConditionExpression: "gsi1pk = :pk",
        ExpressionAttributeValues: { ":pk": { S: `STATUS#${status}` } },
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...(res.Items ?? []));
    startKey = res.LastEvaluatedKey;
  } while (startKey !== undefined);

  const metas: HoldingMeta[] = [];
  for (const item of items) {
    const pk = readString(item, "pk", "状態の GSI のアイテム");
    if (!pk.startsWith("RES#") || item["sk"]?.S !== "META") {
      throw malformed("状態の GSI のアイテム", "pk・sk");
    }
    const meta = parseReservationMeta(pk.slice("RES#".length), item);
    // GSI は結果整合なので、読んだ時点の META の状態でもう一度確かめる
    if (isHoldingMeta(meta) && meta.status === status) metas.push(meta);
  }

  // 2. 氏名だけを PII から読む。並び順は開始 → 終わり → id（GSI の並びは開始の順だけなので、ここで決める）
  return (await withCustomerNames(store, metas)).sort(byTime);
}

// ---- 内部の部品 ----

/** 状態の GSI の名前（dynamodb-keys.md「読み出し」の gsi1pk・gsi1sk） */
const STATUS_INDEX_NAME = "gsi1";

/** BatchGetItem で1回に読めるキーの数 */
const BATCH_GET_LIMIT = 100;

/** 枠を確保している状態の予約の META */
type HoldingMeta = ReservationMeta & { readonly status: HoldingReservationStatus };

/** 枠を確保している状態か（判定は booking-core の holdsSlots。取消・終了は一覧に出ない） */
function isHoldingStatus(status: ReservationStatus): status is HoldingReservationStatus {
  return holdsSlots(status);
}

function isHoldingMeta(meta: ReservationMeta): meta is HoldingMeta {
  return isHoldingStatus(meta.status);
}

function reservationMetaKey(id: string): Item {
  return { pk: { S: `RES#${id}` }, sk: { S: "META" } };
}

function piiKey(id: string): Item {
  return { pk: { S: `RES#${id}` }, sk: { S: "PII" } };
}

function keyOf(item: Item): string {
  return `${item["pk"]?.S ?? ""} ${item["sk"]?.S ?? ""}`;
}

/** BATCH_GET_LIMIT 件ずつに分けて BatchGet する */
async function batchGetAll(
  store: ReservationStore,
  keys: Item[],
  projection?: Parameters<typeof batchGet>[2],
): Promise<Item[]> {
  const items: Item[] = [];
  for (let i = 0; i < keys.length; i += BATCH_GET_LIMIT) {
    items.push(...(await batchGet(store, keys.slice(i, i + BATCH_GET_LIMIT), projection)));
  }
  return items;
}

/** 予約の PII のアイテムから、氏名（customer.name）だけを読んで付ける。ほかの欄は読まない */
async function withCustomerNames(
  store: ReservationStore,
  metas: readonly HoldingMeta[],
): Promise<AdminListedReservation[]> {
  const piiItems = await batchGetAll(
    store,
    metas.map((meta) => piiKey(meta.id)),
    { expression: "pk, sk, customer.#name", names: { "#name": "name" } },
  );
  const names = new Map<string, string>();
  for (const item of piiItems) {
    const pk = readString(item, "pk", "PII のアイテム");
    const where = `${pk} PII`;
    const customer = item["customer"]?.M;
    if (customer === undefined) throw malformed(where, "customer");
    names.set(pk.slice("RES#".length), readString(customer, "name", where));
  }
  return metas.map((meta) => {
    const customerName = names.get(meta.id);
    if (customerName === undefined) throw malformed(`RES#${meta.id}`, "PII のアイテム");
    return toListedReservation(meta, customerName);
  });
}

function toListedReservation(meta: HoldingMeta, customerName: string): AdminListedReservation {
  return {
    id: meta.id,
    ...(meta.receiptNumber === undefined ? {} : { receiptNumber: meta.receiptNumber }),
    status: meta.status,
    start: meta.start,
    end: meta.end,
    bufferMinutes: meta.bufferMinutes,
    route: meta.route,
    partySize: meta.partySize,
    estimateIncludingTax: meta.estimate.estimateIncludingTax,
    ...(meta.confirmedPrice === undefined ? {} : { confirmedPrice: meta.confirmedPrice }),
    ...(meta.provisionalIds === undefined ? {} : { provisionalIds: meta.provisionalIds }),
    customerName,
  };
}

function toListedBlock(block: ReturnType<typeof parseBlockMeta>): AdminListedBlock {
  return {
    id: block.id,
    start: block.start,
    end: block.end,
    bufferMinutes: block.bufferMinutes,
    route: block.route,
    ...(block.memo === undefined ? {} : { memo: block.memo }),
  };
}

/** 開始の早い順。開始が同じなら終わりの早い順、それも同じなら id の順（文字列のコードポイントの順） */
function byTime(
  a: { readonly id: string; readonly start: DateTime; readonly end: DateTime },
  b: { readonly id: string; readonly start: DateTime; readonly end: DateTime },
): number {
  return (
    a.start.toMillis() - b.start.toMillis() ||
    a.end.toMillis() - b.end.toMillis() ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}
