// 予約への操作（承認・却下・昇格・取消・繰り上げ・変更）の保存（DynamoDB）。
// 根拠：docs/design-docs/dynamodb-keys.md（日ごとのアイテム、書き込みの手順、下書きのアイテム）、
// reservation-model.md（状態と操作、第二キープと仮予約、金額、履歴）、core-beliefs.md（INV-1、INV-2、INV-6、INV-7、INV-9、INV-10）。
// 判定は booking-core（approveReservation・rejectReservation・applyReservationOperation・applyReservationChange）に任せ、
// この層は「読む → 判定 → 1トランザクションで書く（版番号が読んだときと同じこと）→ 衝突したら読み直す」を行う。
// バッファの切り替え・直接入力・ブロック枠の保存は、この関数では扱わない。
// 属性名・履歴の形は、申込の保存（reservations.ts）と同じにする。個人情報（PII のアイテム）は読まず、書かない（INV-10）。
// ログは出さない（エラーのメッセージにも、属性の名前とキーだけを書き、値は書かない）。
import {
  type AttributeValue,
  GetItemCommand,
  QueryCommand,
  type TransactWriteItem,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import {
  type ExistingBlock,
  type Reservation,
  applyReservationChange,
  applyReservationOperation,
  approveReservation,
  decidePlanId,
  occupiedRange,
  rejectReservation,
} from "@zebra/booking-core";
import type { PriceTable, ReservationStatus, Yen } from "@zebra/contracts";
import type { DateTime } from "luxon";
import {
  DEFAULT_MAX_ATTEMPTS,
  type DayState,
  type Estimate,
  type HistoryOperation,
  type Item,
  JST,
  type OccupiedInterval,
  type ReservationMeta,
  type ReservationStore,
  batchGet,
  dayKey,
  historySortKey,
  intervalAttribute,
  isRetryableConflict,
  jstDaysOf,
  malformed,
  parseReservationMeta,
  readDayForWrite,
  readString,
  stringList,
  utcIso,
} from "./reservations.ts";

/** 変更後の申込の内容（日時のほか。見積の再計算とプランの決め直しに使う） */
export interface ReservationChangeContent {
  readonly partySize: number;
  readonly cycloramaFloorProtection: boolean;
  readonly equipmentInsurance: boolean;
  readonly optionIds: readonly string[];
}

/**
 * 管理者の操作。終了（第二キープ）は、昇格に続けてシステムが行うので、ここにはない。
 * - approve：承認。確定金額（税込）は管理者が決める
 * - cancel：取消。キャンセル料の日数は、options.now（管理者が取消を操作した時点）の JST の日で数える
 * - change：変更。確定金額は管理者が決める。見積は料金表で計算し直す
 */
export type ReservationOperationInput =
  | { readonly kind: "approve"; readonly reservationId: string; readonly confirmedPrice: Yen }
  | { readonly kind: "reject"; readonly reservationId: string }
  | { readonly kind: "promote"; readonly reservationId: string }
  | { readonly kind: "cancel"; readonly reservationId: string }
  | { readonly kind: "move-up"; readonly reservationId: string }
  | {
      readonly kind: "change";
      readonly reservationId: string;
      readonly start: DateTime;
      readonly end: DateTime;
      readonly content: ReservationChangeContent;
      readonly confirmedPrice: Yen;
      readonly priceTable: PriceTable;
    };

export interface SaveOperationOptions {
  /** 現在時刻（更新日時・履歴の日時・下書きの日時。取消ではキャンセル料の日数にも使う） */
  readonly now: DateTime;
  /** 操作した管理者のユーザー id（履歴の「誰が」） */
  readonly adminUserId: string;
  /** 読む → 判定 → 書く を試す回数の上限 */
  readonly maxAttempts?: number;
  /** 判定が可になったあと、TransactWriteItems の直前に呼ぶ（attempt は1から）。テストで、読んだあとの書き込みを作るため */
  readonly beforeWrite?: (attempt: number) => Promise<void>;
}

/** 下書きの種類と、差し込む値。reservationId はあて先の予約（アイテムの pk は RES#<この id>） */
export type OperationDraft =
  | { readonly kind: "approval"; readonly reservationId: string; readonly confirmedPrice: Yen }
  | { readonly kind: "rejection"; readonly reservationId: string }
  | { readonly kind: "promotion"; readonly reservationId: string }
  | { readonly kind: "second-hold-ended"; readonly reservationId: string }
  | {
      readonly kind: "cancellation";
      readonly reservationId: string;
      readonly cancellationFee: { readonly ratePercent: number; readonly fee: Yen };
    }
  | {
      readonly kind: "move-up-notice";
      readonly reservationId: string;
      /** ほかに付いていて、まだ繰り上げられない理由になっている仮予約の id */
      readonly remainingProvisionalIds: readonly string[];
    }
  | { readonly kind: "bring-forward-notice"; readonly reservationId: string }
  | { readonly kind: "change"; readonly reservationId: string };

/** 下書きの状態：未送信／送信済み／送らない */
export type DraftStatus = "unsent" | "sent" | "not-sent";

/** 操作と同じトランザクションで書いた下書き */
export interface SavedDraft {
  readonly draft: OperationDraft;
  /** アイテムの sk（DRAFT#<日時（UTC）>#<連番>） */
  readonly sk: string;
  readonly status: DraftStatus;
}

/**
 * できない理由
 * - not-found：その id の予約がない
 * - not-pending：承認・却下で、予約が承認待ちでない
 * - invalid-status：昇格・取消・繰り上げで、その操作ができる状態でない
 * - still-held：繰り上げで、付いている仮予約がまだ仮予約のまま重なっている
 * - overlaps-existing：変更後の占有区間が、ほかの予約・ブロック枠と重なる
 * - not-changeable：変更できない予約（承認済みの仮予約・本予約のほか）
 * - busy：版番号の衝突がやり直しの上限を超えた（混み合っている）
 */
export type SaveOperationFailure =
  | "not-found"
  | "not-pending"
  | "invalid-status"
  | "still-held"
  | "overlaps-existing"
  | "not-changeable"
  | "busy";

export type SaveOperationResult =
  | { readonly ok: true; readonly drafts: readonly SavedDraft[] }
  | { readonly ok: false; readonly reason: SaveOperationFailure };

/**
 * 予約への操作を保存する。予約の META、日ごとのアイテム（操作にかかわる JST の日すべて）、履歴、下書きを
 * 1回の TransactWriteItems で書く（INV-2）。できない操作なら何も書かない。
 */
export async function saveReservationOperation(
  store: ReservationStore,
  operation: ReservationOperationInput,
  options: SaveOperationOptions,
): Promise<SaveOperationResult> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("maxAttempts は 1 以上の整数");
  }
  if (!options.now.isValid) {
    throw new RangeError("現在時刻が不正");
  }

  // 判定のあとで、読んでいなかった日が要るとわかったときに足す日。
  // 衝突ではないので試す回数には数えないが、足すたびに必ず増えるので、回数に上限を設けて止める
  const extraDays = new Set<string>();
  let expansions = 0;

  for (let attempt = 1; attempt <= maxAttempts;) {
    // 1. 対象の予約の META と、操作にかかわる日の日ごとのアイテム、関係する予約の META を強い整合性で読む
    const read = await readOperationState(store, operation, extraDays);
    if (read.kind === "not-found") return { ok: false, reason: "not-found" };
    if (read.kind === "moved") {
      // 対象の予約を読んだあとに、ほかの書き込みで予約区間が変わった。読み直す（衝突として数える）
      for (const day of read.days) extraDays.add(day);
      attempt += 1;
      continue;
    }
    const { state } = read;

    // 2. booking-core で判定する
    const judged = judge(operation, state, options.now);
    if (!judged.ok) return judged;

    const modified = modifiedReservations(state, judged.after, operation.reservationId);
    const needed = daysToWrite(modified);
    const missing = [...needed.write, ...needed.read].filter((day) => !state.days.has(day));
    if (missing.length > 0) {
      if (expansions >= MAX_DAY_EXPANSIONS) {
        throw new Error("操作にかかわる日を読み切れなかった");
      }
      expansions += 1;
      for (const day of missing) extraDays.add(day);
      continue;
    }

    // 3. 日ごとのアイテム（版番号の条件つき）・META・履歴・下書きを、1回の TransactWriteItems で書く
    const at = utcIso(options.now);
    const { transactItems, savedDrafts } = await buildWrite(store, {
      operation,
      state,
      modified,
      writeDays: needed.write,
      judged,
      at,
      adminUserId: options.adminUserId,
    });

    if (options.beforeWrite !== undefined) await options.beforeWrite(attempt);

    try {
      await store.client.send(new TransactWriteItemsCommand({ TransactItems: transactItems }));
      return { ok: true, drafts: savedDrafts };
    } catch (error) {
      // 4. 条件で失敗した（読んだあとに同じ日・同じ予約に別の書き込みがあった）なら、読み直してやり直す
      if (isRetryableConflict(error)) {
        attempt += 1;
        continue;
      }
      throw error;
    }
  }
  return { ok: false, reason: "busy" };
}

// ---- 内部の部品 ----

/** 判定のあとに読む日を足し直す回数の上限（足りない日は、ふつうは1回で読み切れる） */
const MAX_DAY_EXPANSIONS = 4;

/** TransactWriteItems に入れられるアイテムの数の上限 */
const TRANSACT_WRITE_LIMIT = 100;

/** 予約の META（読んだときの updatedAt の文字列は、書くときの条件に使う） */
interface ReadMeta {
  readonly meta: ReservationMeta;
  readonly updatedAtRaw: string;
}

/** 書き込みのために読んだもの */
interface OperationState {
  /** 読んだ日ごとのアイテム（JST の日付 → 中身） */
  readonly days: ReadonlyMap<string, DayState>;
  /** 対象の予約と、読んだ日にある予約の META（id → 中身）。対象の予約が先頭 */
  readonly metas: ReadonlyMap<string, ReadMeta>;
  readonly blocks: readonly ExistingBlock[];
}

type ReadResult =
  | { readonly kind: "ok"; readonly state: OperationState }
  | { readonly kind: "not-found" }
  | { readonly kind: "moved"; readonly days: readonly string[] };

/**
 * 読む日：対象の予約の占有区間がかかる日と、占有区間の終わりの日（前倒しの案内のため。JST の 0:00 ちょうどで終わるなら次の日）、
 * 変更なら変更後の占有区間がかかる日。そこにある第二キープ（承認待ちを含む）は、昇格・取消で終了・取消になると
 * 前倒しの案内の判定に終わりの日が要るので、その第二キープがかかる日と終わりの日も読む
 */
async function readOperationState(
  store: ReservationStore,
  operation: ReservationOperationInput,
  extraDays: ReadonlySet<string>,
): Promise<ReadResult> {
  const first = await getMeta(store, operation.reservationId);
  if (first === undefined) return { kind: "not-found" };

  const days = new Map<string, DayState>();
  await readDays(store, days, [
    ...reservationDays(first.meta),
    ...changeDays(operation, first.meta),
    ...extraDays,
  ]);
  const secondHoldDays: string[] = [];
  for (const interval of intervalsOf(days)) {
    if (interval.kind === "reservation" && isSecondHoldStatus(interval.status)) {
      secondHoldDays.push(...daysWithEndDay(interval.start, interval.end));
    }
  }
  await readDays(store, days, secondHoldDays);

  // 関係する予約の META は、日ごとのアイテムを読んだあとに読む（読んだ版番号と食い違わないように）
  const ids = new Set<string>([operation.reservationId]);
  const blocks = new Map<string, ExistingBlock>();
  for (const interval of intervalsOf(days)) {
    if (interval.kind === "reservation") {
      ids.add(interval.id);
    } else {
      // 占有区間（バッファ込み）をそのまま区間にし、バッファは0分（reservations.ts の toBookingCoreInput と同じ）
      blocks.set(interval.id, { start: interval.start, end: interval.end, bufferMinutes: 0 });
    }
  }
  const metas = await readMetas(store, [...ids]);
  const target = metas.get(operation.reservationId);
  if (target === undefined) return { kind: "not-found" };
  for (const id of ids) {
    if (!metas.has(id)) throw malformed(`RES#${id}`, "META のアイテム");
  }

  const targetDays = [...reservationDays(target.meta), ...changeDays(operation, target.meta)];
  const unread = targetDays.filter((day) => !days.has(day));
  if (unread.length > 0) return { kind: "moved", days: unread };

  return { kind: "ok", state: { days, metas, blocks: [...blocks.values()] } };
}

async function getMeta(store: ReservationStore, id: string): Promise<ReadMeta | undefined> {
  const res = await store.client.send(
    new GetItemCommand({
      TableName: store.tableName,
      Key: metaKey(id),
      ConsistentRead: true,
    }),
  );
  return res.Item === undefined ? undefined : toReadMeta(id, res.Item);
}

/** 対象の予約が先頭になるように、ids の順で返す。ない id は入れない */
async function readMetas(
  store: ReservationStore,
  ids: readonly string[],
): Promise<Map<string, ReadMeta>> {
  const items: Item[] = [];
  for (let i = 0; i < ids.length; i += BATCH_GET_LIMIT) {
    items.push(...(await batchGet(store, ids.slice(i, i + BATCH_GET_LIMIT).map(metaKey))));
  }
  const byId = new Map<string, Item>();
  for (const item of items) {
    const pk = readString(item, "pk", "RES#");
    byId.set(pk.slice("RES#".length), item);
  }
  const metas = new Map<string, ReadMeta>();
  for (const id of ids) {
    const item = byId.get(id);
    if (item !== undefined) metas.set(id, toReadMeta(id, item));
  }
  return metas;
}

/** BatchGetItem で1回に読めるキーの数 */
const BATCH_GET_LIMIT = 100;

function toReadMeta(id: string, item: Item): ReadMeta {
  return {
    meta: parseReservationMeta(id, item),
    updatedAtRaw: readString(item, "updatedAt", `RES#${id} META`),
  };
}

function metaKey(id: string): Record<string, AttributeValue> {
  return { pk: { S: `RES#${id}` }, sk: { S: "META" } };
}

/** まだ読んでいない日だけを読む */
async function readDays(
  store: ReservationStore,
  days: Map<string, DayState>,
  wanted: Iterable<string>,
): Promise<void> {
  const unread = [...new Set(wanted)].filter((day) => !days.has(day));
  const states = await Promise.all(unread.map((day) => readDayForWrite(store, day)));
  for (const state of states) days.set(state.day, state);
}

function* intervalsOf(days: ReadonlyMap<string, DayState>): Generator<OccupiedInterval> {
  for (const state of days.values()) yield* state.intervals;
}

/** 予約の占有区間がかかる日と、終わりの日 */
function reservationDays(reservation: {
  readonly start: DateTime;
  readonly end: DateTime;
  readonly bufferMinutes: 30 | 60;
}): string[] {
  const occupied = occupiedRange(reservation, reservation.bufferMinutes);
  return daysWithEndDay(occupied.start, occupied.end);
}

/** 占有区間 [start, end) がかかる JST の日と、end の JST の日（0:00 ちょうどで終わるなら次の日。前倒しの案内のため） */
function daysWithEndDay(start: DateTime, end: DateTime): string[] {
  return [...jstDaysOf(start, end), end.setZone(JST).toISODate() ?? ""];
}

/**
 * 変更後の占有区間がかかる日。変更後の区間が不正なら読まない
 * （変更できない予約なら not-changeable を返すなど、不正な区間の扱いは booking-core の判定の順に任せる）
 */
function changeDays(operation: ReservationOperationInput, meta: ReservationMeta): string[] {
  if (operation.kind !== "change") return [];
  let occupied: { start: DateTime; end: DateTime };
  try {
    occupied = occupiedRange({ start: operation.start, end: operation.end }, meta.bufferMinutes);
  } catch (error) {
    if (error instanceof RangeError) return [];
    throw error;
  }
  return jstDaysOf(occupied.start, occupied.end);
}

/** 判定の結果（成功） */
interface Judged {
  readonly ok: true;
  /** 操作のあとの予約（読んだ予約すべて） */
  readonly after: readonly Reservation[];
  readonly drafts: readonly OperationDraft[];
  /** 変更のときだけ：計算し直した見積と、変更後の中身（プランは料金表で決め直したもの） */
  readonly change?: {
    readonly estimate: Estimate;
    readonly content: ReservationChangeContent;
    readonly planId: string;
  };
}

/**
 * booking-core で判定する。理由は booking-core の理由をそのまま返す
 * （承認・却下は not-found・not-pending、昇格・取消・繰り上げは not-found・invalid-status・still-held、
 * 変更は not-found・not-changeable・overlaps-existing。どれも SaveOperationFailure に同じ名前である）
 */
function judge(
  operation: ReservationOperationInput,
  state: OperationState,
  now: DateTime,
): Judged | { readonly ok: false; readonly reason: SaveOperationFailure } {
  const reservations = [...state.metas.values()].map(({ meta }) => toCoreReservation(meta));
  switch (operation.kind) {
    case "approve": {
      const result = approveReservation({
        reservations,
        reservationId: operation.reservationId,
        confirmedAmount: operation.confirmedPrice,
      });
      if (!result.ok) return result;
      return {
        ok: true,
        after: result.reservations,
        drafts: result.drafts.map((draft) => ({
          kind: "approval",
          reservationId: draft.reservationId,
          confirmedPrice: draft.confirmedAmount,
        })),
      };
    }
    case "reject": {
      const result = rejectReservation({ reservations, reservationId: operation.reservationId });
      if (!result.ok) return result;
      return { ok: true, after: result.reservations, drafts: result.drafts };
    }
    case "promote":
    case "move-up":
    case "cancel": {
      const result = applyReservationOperation({
        reservations,
        operation:
          operation.kind === "cancel"
            ? // キャンセル料の日数は、管理者が取消を操作した時点（options.now）で数える（JST の日。booking-core が直す）
              { kind: "cancel", reservationId: operation.reservationId, cancelledAt: now }
            : { kind: operation.kind, reservationId: operation.reservationId },
      });
      if (!result.ok) return result;
      return { ok: true, after: result.reservations, drafts: result.drafts };
    }
    case "change": {
      const result = applyReservationChange({
        reservations,
        blocks: state.blocks,
        priceTable: operation.priceTable,
        change: {
          reservationId: operation.reservationId,
          start: operation.start,
          end: operation.end,
          content: operation.content,
          confirmedAmount: operation.confirmedPrice,
        },
      });
      if (!result.ok) return result;
      return {
        ok: true,
        after: result.reservations,
        drafts: result.drafts,
        change: {
          estimate: result.estimate,
          content: operation.content,
          planId: decidePlanId(operation.priceTable, operation.content),
        },
      };
    }
  }
}

function toCoreReservation(meta: ReservationMeta): Reservation {
  return {
    id: meta.id,
    status: meta.status,
    start: meta.start,
    end: meta.end,
    bufferMinutes: meta.bufferMinutes,
    provisionalIds: meta.provisionalIds ?? [],
    confirmedAmount: meta.confirmedPrice ?? null,
  };
}

/** 操作で書き換える予約（操作の前と後）。対象の予約は、変わったところがなくても書く（変更の中身・更新日時のため） */
interface ModifiedReservation {
  readonly before: Reservation;
  readonly after: Reservation;
  readonly read: ReadMeta;
  readonly isTarget: boolean;
}

function modifiedReservations(
  state: OperationState,
  after: readonly Reservation[],
  targetId: string,
): ModifiedReservation[] {
  const modified: ModifiedReservation[] = [];
  for (const reservation of after) {
    const read = state.metas.get(reservation.id);
    if (read === undefined) throw malformed(`RES#${reservation.id}`, "META のアイテム");
    const before = toCoreReservation(read.meta);
    const isTarget = reservation.id === targetId;
    if (isTarget || changed(before, reservation)) {
      modified.push({ before, after: reservation, read, isTarget });
    }
  }
  return modified;
}

function changed(a: Reservation, b: Reservation): boolean {
  return (
    a.status !== b.status ||
    a.start.toMillis() !== b.start.toMillis() ||
    a.end.toMillis() !== b.end.toMillis() ||
    a.bufferMinutes !== b.bufferMinutes ||
    a.confirmedAmount !== b.confirmedAmount ||
    a.provisionalIds.length !== b.provisionalIds.length ||
    a.provisionalIds.some((id, index) => b.provisionalIds[index] !== id)
  );
}

/**
 * 書く日：書き換える予約の、操作の前と後の占有区間がかかる日（枠を確保している状態のときだけ）。
 * 読む必要がある日：取消・終了になった第二キープの占有区間の終わりの日（前倒しの案内の判定に使ったはずの日）
 */
function daysToWrite(modified: readonly ModifiedReservation[]): {
  write: Set<string>;
  read: Set<string>;
} {
  const write = new Set<string>();
  const read = new Set<string>();
  for (const { before, after } of modified) {
    for (const reservation of [before, after]) {
      if (!holdsSlots(reservation.status)) continue;
      const occupied = occupiedRange(reservation, reservation.bufferMinutes);
      for (const day of jstDaysOf(occupied.start, occupied.end)) write.add(day);
    }
    if (isSecondHoldStatus(before.status) && !holdsSlots(after.status)) {
      for (const day of reservationDays(before)) read.add(day);
    }
  }
  return { write, read };
}

/**
 * 日ごとのアイテム・META・PII に置く状態のうち、枠を確保しているもの（dynamodb-keys.md「アイテム」、INV-1）。
 * 取消・終了は日ごとのアイテムに入れず、META の GSI（STATUS#…）にも入れない
 */
function holdsSlots(status: ReservationStatus): boolean {
  return status !== "cancelled" && status !== "ended";
}

/** 第二キープ（承認待ちを含む）か。付く仮予約の id を持つのは、この状態のときだけ（dynamodb-keys.md「アイテム」） */
function isSecondHoldStatus(status: ReservationStatus | undefined): boolean {
  return status === "second-hold" || status === "pending-second-hold";
}

const HISTORY_OPERATION = {
  approve: "approve",
  reject: "reject",
  promote: "promote",
  cancel: "cancel",
  "move-up": "move-up",
  change: "change",
} as const satisfies Record<ReservationOperationInput["kind"], HistoryOperation>;

interface WriteInput {
  readonly operation: ReservationOperationInput;
  readonly state: OperationState;
  readonly modified: readonly ModifiedReservation[];
  readonly writeDays: ReadonlySet<string>;
  readonly judged: Judged;
  /** 操作の日時（UTC の ISO 8601） */
  readonly at: string;
  readonly adminUserId: string;
}

async function buildWrite(
  store: ReservationStore,
  input: WriteInput,
): Promise<{ transactItems: TransactWriteItem[]; savedDrafts: SavedDraft[] }> {
  const { operation, state, modified, writeDays, judged, at } = input;
  const transactItems: TransactWriteItem[] = [];

  // 日ごとのアイテム：書き換える日は版番号を1増やして書き、読んだだけの日は版番号が変わっていないことを確かめる
  for (const [day, dayState] of state.days) {
    transactItems.push(
      writeDays.has(day)
        ? dayPutItem(store, dayState, nextIntervals(dayState, modified))
        : dayCheckItem(store, dayState),
    );
  }

  // META と履歴
  const historyOperation = HISTORY_OPERATION[operation.kind];
  for (const entry of modified) {
    const content = entry.isTarget ? judged.change : undefined;
    transactItems.push(metaUpdateItem(store, entry, content, at));
    const pk = `RES#${entry.after.id}`;
    const sequence = (await lastSequence(store, pk, `HIST#${at}#`)) + 1;
    transactItems.push(
      putNew(store, {
        pk: { S: pk },
        sk: { S: historySortKey(at, sequence) },
        at: { S: at },
        actor: entry.isTarget
          ? { M: { kind: { S: "admin" }, userId: { S: input.adminUserId } } }
          : // 昇格に続く終了や、仮予約の変更で付かなくなった第二キープは、システムが行う
            { M: { kind: { S: "system" } } },
        operation: {
          S: !entry.isTarget && entry.after.status === "ended" ? "end" : historyOperation,
        },
        before: snapshotAttribute(
          entry.before,
          content === undefined ? undefined : entry.read.meta,
        ),
        after: snapshotAttribute(
          entry.after,
          content === undefined ? undefined : { ...content.content, planId: content.planId },
        ),
        ...(content === undefined ? {} : { estimate: estimateAttribute(content.estimate) }),
      }),
    );
  }

  // 下書き（あて先の予約ごとに、同じ日時の下書きの連番を続ける）
  const savedDrafts: SavedDraft[] = [];
  const sequences = new Map<string, number>();
  for (const draft of judged.drafts) {
    const pk = `RES#${draft.reservationId}`;
    const prefix = `DRAFT#${at}#`;
    const sequence = (sequences.get(pk) ?? (await lastSequence(store, pk, prefix))) + 1;
    sequences.set(pk, sequence);
    const sk = `${prefix}${String(sequence).padStart(SEQUENCE_DIGITS, "0")}`;
    transactItems.push(
      putNew(store, {
        pk: { S: pk },
        sk: { S: sk },
        kind: { S: draft.kind },
        values: draftValuesAttribute(draft),
        status: { S: "unsent" satisfies DraftStatus },
        operation: { S: historyOperation },
        operationReservationId: { S: operation.reservationId },
        createdAt: { S: at },
        // 未送信の下書きの一覧に使う GSI（送信済み・送らないにしたら、この2つの属性を消す）
        gsi1pk: { S: "DRAFT#UNSENT" },
        gsi1sk: { S: at },
      }),
    );
    savedDrafts.push({ draft, sk, status: "unsent" });
  }

  if (transactItems.length > TRANSACT_WRITE_LIMIT) {
    throw new Error("操作の書き込みが TransactWriteItems の上限を超える");
  }
  return { transactItems, savedDrafts };
}

/** 連番の桁数（historySortKey と同じ） */
const SEQUENCE_DIGITS = 4;

/** その予約の、prefix（HIST#<日時># か DRAFT#<日時>#）で始まるアイテムの連番の最大。なければ 0 */
async function lastSequence(store: ReservationStore, pk: string, prefix: string): Promise<number> {
  let last = 0;
  let startKey: Item | undefined;
  do {
    const res = await store.client.send(
      new QueryCommand({
        TableName: store.tableName,
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        ExpressionAttributeValues: { ":pk": { S: pk }, ":prefix": { S: prefix } },
        ProjectionExpression: "#pk, #sk",
        ConsistentRead: true,
        ExclusiveStartKey: startKey,
      }),
    );
    for (const item of res.Items ?? []) {
      const sequence = Number(readString(item, "sk", pk).slice(prefix.length));
      if (!Number.isInteger(sequence) || sequence < 1) throw malformed(pk, "sk");
      if (sequence > last) last = sequence;
    }
    startKey = res.LastEvaluatedKey;
  } while (startKey !== undefined);
  return last;
}

/**
 * 書き換えたあとの日の占有区間。書き換える予約の占有区間は、操作のあとも枠を確保していてその日にかかるなら新しい値にし、
 * そうでなければ除く。ほかの占有区間はそのまま残す
 */
function nextIntervals(
  dayState: DayState,
  modified: readonly ModifiedReservation[],
): OccupiedInterval[] {
  const byId = new Map(modified.map((entry) => [entry.after.id, entry.after]));
  const placed = new Set<string>();
  const next: OccupiedInterval[] = [];
  const place = (reservation: Reservation): void => {
    if (placed.has(reservation.id) || !holdsSlots(reservation.status)) return;
    const occupied = occupiedRange(reservation, reservation.bufferMinutes);
    if (!jstDaysOf(occupied.start, occupied.end).includes(dayState.day)) return;
    placed.add(reservation.id);
    next.push({
      kind: "reservation",
      id: reservation.id,
      status: reservation.status,
      ...(isSecondHoldStatus(reservation.status)
        ? { provisionalIds: reservation.provisionalIds }
        : {}),
      start: occupied.start,
      end: occupied.end,
    });
  };
  for (const interval of dayState.intervals) {
    const reservation = interval.kind === "reservation" ? byId.get(interval.id) : undefined;
    if (reservation === undefined) {
      next.push(interval);
    } else {
      place(reservation);
    }
  }
  for (const entry of modified) place(entry.after);
  return next;
}

/** 日ごとのアイテムを書き直す。版番号が読んだときと同じ（まだないなら、まだないこと）を条件にし、版番号を1増やす */
function dayPutItem(
  store: ReservationStore,
  dayState: DayState,
  intervals: readonly OccupiedInterval[],
): TransactWriteItem {
  return {
    Put: {
      TableName: store.tableName,
      Item: {
        ...dayKey(dayState.day),
        version: { N: String((dayState.version ?? 0) + 1) },
        intervals: { L: intervals.map(intervalAttribute) },
      },
      ...dayCondition(dayState),
    },
  };
}

/** 読んだだけの日：版番号が読んだときと同じ（まだないなら、まだないこと）を確かめる */
function dayCheckItem(store: ReservationStore, dayState: DayState): TransactWriteItem {
  return {
    ConditionCheck: {
      TableName: store.tableName,
      Key: dayKey(dayState.day),
      ...dayCondition(dayState),
    },
  };
}

function dayCondition(dayState: DayState): {
  ConditionExpression: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, AttributeValue>;
} {
  if (dayState.version === null) return { ConditionExpression: "attribute_not_exists(pk)" };
  return {
    ConditionExpression: "#version = :read",
    ExpressionAttributeNames: { "#version": "version" },
    ExpressionAttributeValues: { ":read": { N: String(dayState.version) } },
  };
}

/**
 * 予約の META の書き換え。条件は、更新日時が読んだときと同じこと（読んだあとに、ほかの操作がこの予約を書いていない）。
 * 変更なら、人数・ホリゾントの養生・プラン・機材保険・オプションを新しい値にする。申込のときの見積（estimate）は変えない
 */
function metaUpdateItem(
  store: ReservationStore,
  entry: ModifiedReservation,
  change: Judged["change"],
  at: string,
): TransactWriteItem {
  const { after } = entry;
  const set: Record<string, AttributeValue> = {
    status: { S: after.status },
    start: { S: utcIso(after.start) },
    end: { S: utcIso(after.end) },
    updatedAt: { S: at },
  };
  const remove: string[] = [];
  if (after.confirmedAmount !== null) set["confirmedPrice"] = { N: String(after.confirmedAmount) };
  if (isSecondHoldStatus(after.status)) {
    set["provisionalIds"] = stringList(after.provisionalIds);
  } else {
    remove.push("provisionalIds");
  }
  if (holdsSlots(after.status)) {
    // 承認待ちの一覧・期限の警告に使う GSI
    set["gsi1pk"] = { S: `STATUS#${after.status}` };
    set["gsi1sk"] = { S: utcIso(after.start) };
  } else {
    // 取消・終了は GSI に入れない（dynamodb-keys.md「読み出し」）
    remove.push("gsi1pk", "gsi1sk");
  }
  if (change !== undefined) {
    set["partySize"] = { N: String(change.content.partySize) };
    set["cycloramaFloorProtection"] = { BOOL: change.content.cycloramaFloorProtection };
    set["planId"] = { S: change.planId };
    set["equipmentInsurance"] = { BOOL: change.content.equipmentInsurance };
    set["optionIds"] = stringList(change.content.optionIds);
  }

  const names: Record<string, string> = { "#readUpdatedAt": "updatedAt" };
  const values: Record<string, AttributeValue> = {
    ":readUpdatedAt": { S: entry.read.updatedAtRaw },
  };
  const assignments = Object.entries(set).map(([attribute, value], index) => {
    names[`#s${index}`] = attribute;
    values[`:s${index}`] = value;
    return `#s${index} = :s${index}`;
  });
  const removals = remove.map((attribute, index) => {
    names[`#r${index}`] = attribute;
    return `#r${index}`;
  });
  return {
    Update: {
      TableName: store.tableName,
      Key: metaKey(after.id),
      UpdateExpression:
        `SET ${assignments.join(", ")}` +
        (removals.length > 0 ? ` REMOVE ${removals.join(", ")}` : ""),
      ConditionExpression: "#readUpdatedAt = :readUpdatedAt",
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    },
  };
}

/** 中身の前後（変更の履歴だけ）。プランの id を含む */
interface SnapshotContent {
  readonly partySize: number;
  readonly cycloramaFloorProtection: boolean;
  readonly planId: string;
  readonly equipmentInsurance: boolean;
  readonly optionIds: readonly string[];
}

/** 履歴に残す、操作の前後の値（reservations.ts の HistorySnapshot と同じ属性名）。個人情報は入れない */
function snapshotAttribute(
  reservation: Reservation,
  content: SnapshotContent | undefined,
): AttributeValue {
  return {
    M: {
      status: { S: reservation.status },
      start: { S: utcIso(reservation.start) },
      end: { S: utcIso(reservation.end) },
      bufferMinutes: { N: String(reservation.bufferMinutes) },
      ...(reservation.confirmedAmount === null
        ? {}
        : { confirmedPrice: { N: String(reservation.confirmedAmount) } }),
      ...(isSecondHoldStatus(reservation.status)
        ? { provisionalIds: stringList(reservation.provisionalIds) }
        : {}),
      ...(content === undefined
        ? {}
        : {
            partySize: { N: String(content.partySize) },
            cycloramaFloorProtection: { BOOL: content.cycloramaFloorProtection },
            planId: { S: content.planId },
            equipmentInsurance: { BOOL: content.equipmentInsurance },
            optionIds: stringList(content.optionIds),
          }),
    },
  };
}

function estimateAttribute(estimate: Estimate): AttributeValue {
  return {
    M: {
      subtotalExcludingTax: { N: String(estimate.subtotalExcludingTax) },
      estimateIncludingTax: { N: String(estimate.estimateIncludingTax) },
    },
  };
}

/** 下書きに差し込む値（文面は持たない。dynamodb-keys.md「アイテム」） */
function draftValuesAttribute(draft: OperationDraft): AttributeValue {
  switch (draft.kind) {
    case "approval":
      return { M: { confirmedPrice: { N: String(draft.confirmedPrice) } } };
    case "cancellation":
      return {
        M: {
          cancellationFee: {
            M: {
              ratePercent: { N: String(draft.cancellationFee.ratePercent) },
              fee: { N: String(draft.cancellationFee.fee) },
            },
          },
        },
      };
    case "move-up-notice":
      return { M: { remainingProvisionalIds: stringList(draft.remainingProvisionalIds) } };
    case "rejection":
    case "promotion":
    case "second-hold-ended":
    case "bring-forward-notice":
    case "change":
      return { M: {} };
  }
}

/** 新しいアイテム（履歴・下書き）。同じキーのアイテムがあれば上書きせずに失敗させる（読み直して連番を取り直す） */
function putNew(store: ReservationStore, item: Item): TransactWriteItem {
  return {
    Put: {
      TableName: store.tableName,
      Item: item,
      ConditionExpression: "attribute_not_exists(pk)",
    },
  };
}
