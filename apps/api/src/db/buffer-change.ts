// バッファの切り替えの保存（docs/product-specs/booking.md「バッファを30分に縮める」、reservation-model.md「状態と操作」の
// バッファの切り替え、dynamodb-keys.md「書き込み」、admin-api.md「バッファの切り替え・お客様の情報の変更（2回目b）」）。
// スタブ：形（名前・引数・戻り値）だけを決める。中身は実装担当が書く（docs/TESTING.md 手順4）
import type { SaveOperationOptions, SavedDraft } from "./operations.ts";
import type { ReservationStore } from "./reservations.ts";

/** バッファの切り替え：どの予約のバッファを、何分にするか */
export interface BufferChangeInput {
  reservationId: string;
  bufferMinutes: 30 | 60;
}

/**
 * 保存のオプション。予約への操作の保存（saveReservationOperation）と同じ：現在時刻（更新日時・履歴の日時・下書きの日時。INV-7）、
 * 操作した管理者のユーザー id（履歴の「誰が」）、やり直しの上限、書く直前に呼ぶ関数（テストで同時の書き込みを起こすため）
 */
export type SaveBufferChangeOptions = SaveOperationOptions;

/**
 * 切り替えられない理由
 * - not-found：その id の予約がない
 * - not-changeable：承認済みの仮予約・本予約でない（承認待ち・第二キープ・取消・終了）
 * - overlaps-existing：切り替えたあとの占有区間が、ほかの予約・ブロック枠と重なる（INV-1）
 * - busy：版番号の衝突が続き、やり直しの上限を超えた
 */
export type BufferChangeFailureReason =
  "not-found" | "not-changeable" | "overlaps-existing" | "busy";

/**
 * 切り替えの結果。changed は、今と同じバッファなら false（何も書かない。drafts は空）。
 * drafts は、書いた下書き（縮めて重ならなくなった承認済みの第二キープへの繰り上げ案内だけ。ほかの下書きは作らない）
 */
export type SaveBufferChangeResult =
  | { ok: true; changed: boolean; drafts: readonly SavedDraft[] }
  | { ok: false; reason: BufferChangeFailureReason };

/**
 * バッファの切り替えを保存する。かかる日（切り替えの前と後の占有区間がかかる JST の日）の日ごとのアイテムを読み、
 * booking-core の applyBufferChange で判定し、日ごとのアイテム（条件：版番号が読んだときと同じ）・予約の META の
 * バッファ・仮予約に付かなくなった第二キープの META・履歴（操作は buffer-change、前後のバッファ）・下書きを
 * 1トランザクションで書く（INV-2）。不可なら何も書かない。今と同じバッファなら何も書かない
 */
export function saveBufferChange(
  store: ReservationStore,
  input: BufferChangeInput,
  options: SaveBufferChangeOptions,
): Promise<SaveBufferChangeResult> {
  void store;
  void input;
  void options;
  throw new Error("未実装");
}
