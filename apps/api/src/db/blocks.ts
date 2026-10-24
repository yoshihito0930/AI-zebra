// ブロック枠の保存（管理者が入れる・消す・直す）と読み出し（docs/product-specs/booking.md
// 「管理者による予約の直接入力とブロック枠」の「ブロック枠のバッファ」「ブロック枠を消す・直す」、dynamodb-keys.md）。
// Googleカレンダーの取り込みは扱わない（別の PR）。
// スタブ：形（名前・引数・戻り値）だけを決める。中身は実装担当が書く（docs/TESTING.md 手順4）
import type { DateTime } from "luxon";
import type { ReservationStore } from "./reservations.ts";

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
export function saveAdminBlock(
  store: ReservationStore,
  block: AdminBlockInput,
  options?: SaveBlockOptions,
): Promise<SaveAdminBlockResult> {
  void store;
  void block;
  void options;
  throw new Error("未実装");
}

/**
 * 管理者が入れたブロック枠を直す（日時・バッファ・メモ）。直す前の枠の解放と直したあとの枠の確保を1トランザクションで行う。
 * 直す前のブロック枠の記録は残さない。不可なら何も書かない
 */
export function updateAdminBlock(
  store: ReservationStore,
  id: string,
  block: AdminBlockInput,
  options?: SaveBlockOptions,
): Promise<UpdateAdminBlockResult> {
  void store;
  void id;
  void block;
  void options;
  throw new Error("未実装");
}

/** 管理者が入れたブロック枠を消す。占有区間は空きに戻る。消したブロック枠の記録は残さない。不可なら何も書かない */
export function deleteAdminBlock(
  store: ReservationStore,
  id: string,
  options?: SaveBlockOptions,
): Promise<DeleteAdminBlockResult> {
  void store;
  void id;
  void options;
  throw new Error("未実装");
}

/** ブロック枠を読む。ないときは null */
export function getBlock(store: ReservationStore, id: string): Promise<BlockDetail | null> {
  void store;
  void id;
  throw new Error("未実装");
}
