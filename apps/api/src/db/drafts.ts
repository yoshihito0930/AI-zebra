// 下書きの読み出しと、送信済み・送らないの保存（docs/design-docs/dynamodb-keys.md の下書きのアイテムと、
// 未送信の下書きの GSI。admin-api.md「下書き（3回目）」）。下書きは文面と個人情報を持たない。メールは送らない（INV-6）
// - 下書きのアイテムは、操作の保存（operations.ts の buildWrite）が書いたもの。属性名はそこに合わせる
//   （kind・values・status・operation・operationReservationId・createdAt・gsi1pk・gsi1sk）。
//   送信済み・送らないにしたら、statusChangedAt（UTC）と statusChangedBy（管理者の id）を足し、gsi1pk・gsi1sk を消す
// - DB から読んだ値は、使う前に形を確かめる（INV-4。読み方の部品は reservations.ts と共有する）
// - ログは出さない（エラーのメッセージにも、属性の名前とキーだけを書き、値は書かない。INV-10）
import {
  ConditionalCheckFailedException,
  GetItemCommand,
  QueryCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { AdminDraftKind, AdminDraftStatus } from "@zebra/contracts";
import type { DateTime } from "luxon";
import { readCustomerNames, reservationMetaKey } from "./admin-list.ts";
import type { OperationDraft } from "./operations.ts";
import {
  type Item,
  type ReservationStore,
  batchGetAll,
  malformed,
  parseReservationMeta,
  readInstant,
  readMap,
  readNumber,
  readString,
  readStringList,
  readYen,
  utcIso,
} from "./reservations.ts";

/** 保存された下書き1件 */
export interface StoredDraft {
  /** 下書きのアイテムの sk（DRAFT#<作った日時（UTC）>#<連番>）。あて先の予約の id（draft.reservationId）と合わせて下書きを決める */
  sk: string;
  /** 種類、あて先の予約の id、差し込む値（下書きを作ったときの値） */
  draft: OperationDraft;
  status: AdminDraftStatus;
  createdAt: DateTime;
  /** 送信済み・送らないにした日時と管理者の id。未送信なら持たない */
  statusChange?: { at: DateTime; adminUserId: string };
}

/** 未送信の下書きを、作った順（古い順）に返す（GSI：gsi1pk = DRAFT#UNSENT、gsi1sk = 作った日時） */
export async function listUnsentDrafts(store: ReservationStore): Promise<StoredDraft[]> {
  const drafts: StoredDraft[] = [];
  let startKey: Item | undefined;
  do {
    const res = await store.client.send(
      new QueryCommand({
        TableName: store.tableName,
        IndexName: UNSENT_INDEX_NAME,
        KeyConditionExpression: "gsi1pk = :pk",
        ExpressionAttributeValues: { ":pk": { S: UNSENT_GSI_PK } },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of res.Items ?? []) {
      const draft = parseDraft(item);
      // GSI は結果整合なので、読んだアイテムの状態でもう一度確かめる
      if (draft.status === "unsent") drafts.push(draft);
    }
    startKey = res.LastEvaluatedKey;
  } while (startKey !== undefined);
  // 作った日時の順（GSI の並び）。同じ日時どうしは、あて先の予約の id と sk の順にして、並びを決める
  return drafts.sort(
    (a, b) =>
      a.createdAt.toMillis() - b.createdAt.toMillis() ||
      compareStrings(a.draft.reservationId, b.draft.reservationId) ||
      compareStrings(a.sk, b.sk),
  );
}

/** その予約の下書きすべて（送信済み・送らないも）を、作った順に返す。なければ空 */
export async function listReservationDrafts(
  store: ReservationStore,
  reservationId: string,
): Promise<StoredDraft[]> {
  const drafts: StoredDraft[] = [];
  let startKey: Item | undefined;
  do {
    const res = await store.client.send(
      new QueryCommand({
        TableName: store.tableName,
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        ExpressionAttributeValues: {
          ":pk": { S: reservationPk(reservationId) },
          ":prefix": { S: DRAFT_SK_PREFIX },
        },
        ConsistentRead: true,
        ExclusiveStartKey: startKey,
      }),
    );
    drafts.push(...(res.Items ?? []).map(parseDraft));
    startKey = res.LastEvaluatedKey;
  } while (startKey !== undefined);
  // sk（DRAFT#<作った日時（UTC）>#<連番>）の文字列の順が、作った順
  return drafts.sort((a, b) => compareStrings(a.sk, b.sk));
}

/** 下書き1件を読む。その予約の下書きになければ null */
export async function getDraft(
  store: ReservationStore,
  reservationId: string,
  sk: string,
): Promise<StoredDraft | null> {
  // 下書きでないアイテム（META・PII・履歴など）は、下書きとしては読まない
  if (!sk.startsWith(DRAFT_SK_PREFIX)) return null;
  const item = await getItem(store, reservationPk(reservationId), sk);
  return item === undefined ? null : parseDraft(item);
}

/** 送信済み（sent）・送らない（skipped）にする下書き */
export interface DraftStatusChange {
  reservationId: string;
  sk: string;
  status: "sent" | "skipped";
}

export interface SaveDraftStatusOptions {
  /** 操作の日時（INV-7。UTC で保存する） */
  now: DateTime;
  adminUserId: string;
}

/**
 * - not-found：その予約の下書きがない
 * - draft-not-unsent：未送信でない（送信済み・送らないにしたあとは、未送信に戻さず、ほかの状態にもしない）
 */
export type SaveDraftStatusResult =
  { ok: true } | { ok: false; reason: "not-found" | "draft-not-unsent" };

/**
 * 下書きの状態と、その日時・管理者の id を書き、未送信の一覧の GSI の属性を消す。
 * 下書きの状態が未送信であることを条件に書く
 */
export async function saveDraftStatus(
  store: ReservationStore,
  change: DraftStatusChange,
  options: SaveDraftStatusOptions,
): Promise<SaveDraftStatusResult> {
  if (!options.now.isValid) throw new RangeError("現在時刻が不正");
  if (!change.sk.startsWith(DRAFT_SK_PREFIX)) return { ok: false, reason: "not-found" };
  const pk = reservationPk(change.reservationId);
  try {
    await store.client.send(
      new UpdateItemCommand({
        TableName: store.tableName,
        Key: { pk: { S: pk }, sk: { S: change.sk } },
        UpdateExpression:
          "SET #status = :next, #changedAt = :at, #changedBy = :by REMOVE #gsi1pk, #gsi1sk",
        // 下書きがあり、未送信であること（同時に2つの操作が来ても、片方だけが通る）
        ConditionExpression: "attribute_exists(#pk) AND #status = :unsent",
        ExpressionAttributeNames: {
          "#pk": "pk",
          "#status": "status",
          "#changedAt": "statusChangedAt",
          "#changedBy": "statusChangedBy",
          "#gsi1pk": "gsi1pk",
          "#gsi1sk": "gsi1sk",
        },
        ExpressionAttributeValues: {
          ":next": { S: change.status },
          ":unsent": { S: "unsent" satisfies AdminDraftStatus },
          ":at": { S: utcIso(options.now) },
          ":by": { S: options.adminUserId },
        },
      }),
    );
  } catch (error) {
    if (!(error instanceof ConditionalCheckFailedException)) throw error;
    // 条件に合わなかった：ないのか、未送信でないのかを読み分ける（どちらも何も書いていない）
    const item = await getItem(store, pk, change.sk);
    return { ok: false, reason: item === undefined ? "not-found" : "draft-not-unsent" };
  }
  return { ok: true };
}

/** 未送信の下書きのあて先の予約（一覧に出す、予約の今の開始とお客様の氏名） */
export interface DraftRecipient {
  /** 予約区間の開始（読んだときの META の値。下書きを作ったあとに日時を変えたら、変えたあと） */
  start: DateTime;
  customerName: string;
}

/**
 * 下書きのあて先の予約の、今の開始とお客様の氏名を読む（予約の id から）。META と、PII の氏名だけを読む
 * （PII のほかの欄は読まない。admin-list.ts と同じ）。下書きのある予約は消さないので、ない予約は DB の形の誤り
 */
export async function readDraftRecipients(
  store: ReservationStore,
  reservationIds: readonly string[],
): Promise<Map<string, DraftRecipient>> {
  const ids = [...new Set(reservationIds)];
  const metas = await batchGetAll(store, ids.map(reservationMetaKey));
  const starts = new Map<string, DateTime>();
  for (const item of metas) {
    const id = reservationIdOf(readString(item, "pk", "予約の META"));
    starts.set(id, parseReservationMeta(id, item).start);
  }
  const names = await readCustomerNames(store, ids);
  const recipients = new Map<string, DraftRecipient>();
  for (const id of ids) {
    const start = starts.get(id);
    if (start === undefined) throw malformed(reservationPk(id), "META のアイテム");
    const customerName = names.get(id);
    if (customerName === undefined) throw malformed(reservationPk(id), "PII のアイテム");
    recipients.set(id, { start, customerName });
  }
  return recipients;
}

/** 予約があるか（予約の META があるか）。META の中身は読まない */
export async function reservationExists(
  store: ReservationStore,
  reservationId: string,
): Promise<boolean> {
  const res = await store.client.send(
    new GetItemCommand({
      TableName: store.tableName,
      Key: reservationMetaKey(reservationId),
      ProjectionExpression: "pk",
      ConsistentRead: true,
    }),
  );
  return res.Item !== undefined;
}

// ---- 内部の部品 ----

/** 未送信の下書きの GSI（dynamodb-keys.md「読み出し」。操作の保存が gsi1pk = DRAFT#UNSENT で書く） */
const UNSENT_INDEX_NAME = "gsi1";
const UNSENT_GSI_PK = "DRAFT#UNSENT";

/** 下書きのアイテムの sk の始まり */
const DRAFT_SK_PREFIX = "DRAFT#";

const RESERVATION_PK_PREFIX = "RES#";

function reservationPk(reservationId: string): string {
  return `${RESERVATION_PK_PREFIX}${reservationId}`;
}

function reservationIdOf(pk: string): string {
  if (!pk.startsWith(RESERVATION_PK_PREFIX)) throw malformed("下書きのアイテム", "pk");
  return pk.slice(RESERVATION_PK_PREFIX.length);
}

/** 文字列のコードポイントの順 */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function getItem(store: ReservationStore, pk: string, sk: string): Promise<Item | undefined> {
  const res = await store.client.send(
    new GetItemCommand({
      TableName: store.tableName,
      Key: { pk: { S: pk }, sk: { S: sk } },
      ConsistentRead: true,
    }),
  );
  return res.Item;
}

/** 下書きのアイテムを読む。形が合わなければエラーを投げる（INV-4） */
function parseDraft(item: Item): StoredDraft {
  const pk = readString(item, "pk", "下書きのアイテム");
  const sk = readString(item, "sk", pk);
  const where = `${pk} ${sk}`;
  if (!sk.startsWith(DRAFT_SK_PREFIX)) throw malformed(where, "sk");
  const reservationId = reservationIdOf(pk);

  const parsedStatus = AdminDraftStatus.safeParse(readString(item, "status", where));
  if (!parsedStatus.success) throw malformed(where, "status");
  const status = parsedStatus.data;

  const stored: StoredDraft = {
    sk,
    draft: parseDraftContent(reservationId, item, where),
    status,
    createdAt: readInstant(item, "createdAt", where),
  };
  if (status === "unsent") return stored;
  // 送信済み・送らないにした下書きは、その日時と管理者の id を持つ
  return {
    ...stored,
    statusChange: {
      at: readInstant(item, "statusChangedAt", where),
      adminUserId: readString(item, "statusChangedBy", where),
    },
  };
}

/** 種類と、差し込む値（values）を、操作の保存が書いた形（operations.ts の draftValuesAttribute）から読む */
function parseDraftContent(reservationId: string, item: Item, where: string): OperationDraft {
  const kind = AdminDraftKind.safeParse(readString(item, "kind", where));
  if (!kind.success) throw malformed(where, "kind");
  const values = readMap(item, "values", where);
  switch (kind.data) {
    case "approval":
      return {
        kind: kind.data,
        reservationId,
        confirmedPrice: readYen(values, "confirmedPrice", where),
      };
    case "cancellation": {
      const fee = readMap(values, "cancellationFee", where);
      return {
        kind: kind.data,
        reservationId,
        cancellationFee: {
          ratePercent: readNumber(fee, "ratePercent", where),
          fee: readYen(fee, "fee", where),
        },
      };
    }
    case "move-up-notice":
      return {
        kind: kind.data,
        reservationId,
        remainingProvisionalIds: readStringList(values, "remainingProvisionalIds", where),
      };
    case "rejection":
    case "promotion":
    case "second-hold-ended":
    case "bring-forward-notice":
    case "change":
      return { kind: kind.data, reservationId };
  }
}
