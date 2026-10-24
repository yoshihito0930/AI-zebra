// 管理者による予約の直接入力の保存（docs/product-specs/booking.md「管理者による予約の直接入力とブロック枠」の
// 「直接入れる予約のルール」、reservation-model.md「状態と操作」の直接入力、dynamodb-keys.md「書き込み」）。
// 判定は booking-core（checkDirectEntry）に任せ、この層は「読む → 判定 → 1トランザクションで書く（版番号が読んだときと同じこと）
// → 衝突したら読み直す」を行う。日ごとのアイテム・予約の META・PII・履歴の書き方は、申込の保存（reservations.ts）と共有する。
// 個人情報（お客様の情報・撮影の内容）は PII のアイテムにだけ置く（INV-10）。ログは出さない。
import { randomUUID } from "node:crypto";
import { checkDirectEntry, type DirectEntryInput, occupiedRange } from "@zebra/booking-core";
import type { ReservationStatus, Yen } from "@zebra/contracts";
import type { DateTime } from "luxon";
import {
  INITIAL_BUFFER_MINUTES,
  type OccupiedInterval,
  type ReservationApplication,
  type ReservationStore,
  type StoredCustomerInfo,
  type StoredShootingInfo,
  dayWriteItem,
  jstDaysOf,
  newReservationWriteItems,
  readDayForWrite,
  toBookingCoreInput,
  writeWithRetry,
} from "./reservations.ts";

/** 直接入れる予約の種類。承認待ちを経ず、仮予約（provisional）・本予約（firm）・第二キープ（second-hold）として入る */
export type DirectEntryKind = "provisional" | "firm" | "second-hold";

/**
 * 管理者が直接入れる予約。予約区間・人数・ホリゾントの養生・プラン・機材保険・オプション・見積は申込と同じ形。
 * 見積（料金表での計算）とプランは、申込と同じく API の層で決めて渡す。バッファは初期値の60分で入る。
 * - confirmedPrice：管理者が確定した金額（税込）
 * - customer：氏名と、電話番号かメールアドレスのどちらか1つが必須。ほかは任意（入れていない欄はない）
 * - shooting：撮影内容・撮影詳細・補足事項はすべて任意
 * 入力の形の確かめ（メールアドレス・電話番号の形、長さの上限）は、API の層で済ませてから渡す
 */
export type DirectEntry = Omit<ReservationApplication, "kind" | "customer" | "shooting"> & {
  kind: DirectEntryKind;
  confirmedPrice: Yen;
  customer: StoredCustomerInfo;
  shooting: StoredShootingInfo;
};

export interface SaveDirectEntryOptions {
  /** 現在時刻（作成日時・更新日時・履歴の日時）。INV-7 */
  now: DateTime;
  /** 操作した管理者のユーザー id（履歴の「誰が」） */
  adminUserId: string;
  /** 版番号の衝突で読み直してやり直す回数の上限（1回目を含む）。超えたら busy */
  maxAttempts?: number;
  /** 読んで判定したあと、書く直前に呼ぶ（テストで同時の書き込みを起こすため）。attempt は1から */
  beforeWrite?: (attempt: number) => Promise<void>;
}

/**
 * 直接入力が不可の理由。保存の層では、例外を認めない決まりだけで止める（締め切りと、深夜帯にかかる予約の最短4時間は
 * 警告なので、管理者の確認を受けて呼ぶ前提で、ここでは止めない）。値の名前は公開 API の契約（ApplicationRejection）と同じ
 * - not-on-30-minute-boundary／shorter-than-2-hours／longer-than-24-hours：時間の単位と利用時間
 * - overlaps-existing：空き判定（承認待ちの仮予約との重なりを含む）
 * - no-provisional-to-hold：第二キープが、どの承認済みの仮予約とも重ならない
 * - busy：版番号の衝突が続き、やり直しの上限を超えた
 */
export type DirectEntryFailureReason =
  | "not-on-30-minute-boundary"
  | "shorter-than-2-hours"
  | "longer-than-24-hours"
  | "overlaps-existing"
  | "no-provisional-to-hold"
  | "busy";

export type SaveDirectEntryResult =
  { ok: true; id: string } | { ok: false; reason: DirectEntryFailureReason };

/**
 * 直接入力を保存する。日ごとのアイテム・予約の META（経路は admin、受付番号なし、確定金額あり）・個人情報・
 * 履歴（操作は direct-entry、誰がは管理者）を1トランザクションで書く（INV-2）。不可なら何も書かない
 */
export async function saveDirectEntry(
  store: ReservationStore,
  entry: DirectEntry,
  options: SaveDirectEntryOptions,
): Promise<SaveDirectEntryResult> {
  if (!options.now.isValid) {
    throw new RangeError("現在時刻が不正");
  }

  // 時間の決まり（30分単位・最短2時間・最長24時間）は、日ごとのアイテムを読む前に確かめる（読む日の数を決める前に、長すぎる区間を止める）。
  // 既存の予約・ブロック枠なしで判定すると、不可になるのは時間の決まりか、第二キープの付く仮予約がない（no-provisional-to-hold）だけ。
  // 付く仮予約があるかは、読んだあとの判定で決まる
  const timeOnly = checkDirectEntry(directEntryInput(entry, options.now, [], []));
  if (!timeOnly.ok && timeOnly.reason !== "no-provisional-to-hold") {
    return { ok: false, reason: timeOnly.reason };
  }

  const id = randomUUID();
  const status = DIRECT_ENTRY_STATUS[entry.kind];
  // 占有区間 [start, end + バッファ)。バッファは初期値の60分（切り替えは別の操作）
  const occupied = occupiedRange(entry, INITIAL_BUFFER_MINUTES);
  const days = jstDaysOf(occupied.start, occupied.end);

  return writeWithRetry<SaveDirectEntryResult>(store, options, async () => {
    // 1. かかわる JST の日の日ごとのアイテムを、強い整合性で読む
    const dayStates = await Promise.all(days.map((day) => readDayForWrite(store, day)));

    // 2. booking-core で判定する。警告（締め切り、深夜帯の最短4時間）は、管理者の確認を受けて呼ぶ前提なので止めない
    const { reservations, blocks } = toBookingCoreInput(
      dayStates.flatMap((state) => state.intervals),
    );
    const judged = checkDirectEntry(directEntryInput(entry, options.now, reservations, blocks));
    if (!judged.ok) return { kind: "stop", result: { ok: false, reason: judged.reason } };

    // 3. 日ごとのアイテム（版番号の条件つき）・META・PII・履歴を、1回の TransactWriteItems で書く
    const provisionalIds = entry.kind === "second-hold" ? judged.provisionalIds : undefined;
    const newInterval: OccupiedInterval = {
      kind: "reservation",
      id,
      status,
      ...(provisionalIds === undefined ? {} : { provisionalIds }),
      start: occupied.start,
      end: occupied.end,
      bufferMinutes: INITIAL_BUFFER_MINUTES,
    };
    return {
      kind: "write",
      transactItems: [
        ...dayStates.map((state) => dayWriteItem(store, state, newInterval)),
        ...newReservationWriteItems(
          store,
          {
            // 受付番号はフォームの申込だけ（dynamodb-keys.md「アイテム」）なので、渡されても書かない
            id,
            status,
            route: "admin",
            start: entry.start,
            end: entry.end,
            partySize: entry.partySize,
            cycloramaFloorProtection: entry.cycloramaFloorProtection,
            planId: entry.planId,
            equipmentInsurance: entry.equipmentInsurance,
            optionIds: entry.optionIds,
            estimate: entry.estimate,
            confirmedPrice: entry.confirmedPrice,
            customer: entry.customer,
            shooting: entry.shooting,
            ...(provisionalIds === undefined ? {} : { provisionalIds }),
            actor: { kind: "admin", userId: options.adminUserId },
            operation: "direct-entry",
          },
          options.now,
        ),
      ],
      result: { ok: true, id },
    };
  });
}

/** 直接入れる予約の種類と、入る状態（承認待ちを経ない） */
const DIRECT_ENTRY_STATUS = {
  provisional: "provisional",
  firm: "firm",
  "second-hold": "second-hold",
} as const satisfies Record<DirectEntryKind, ReservationStatus>;

function directEntryInput(
  entry: DirectEntry,
  enteredAt: DateTime,
  reservations: DirectEntryInput["reservations"],
  blocks: DirectEntryInput["blocks"],
): DirectEntryInput {
  return {
    kind: entry.kind,
    start: entry.start,
    end: entry.end,
    bufferMinutes: INITIAL_BUFFER_MINUTES,
    enteredAt,
    reservations,
    blocks,
  };
}
