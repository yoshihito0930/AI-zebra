// バッファの切り替えの保存（docs/product-specs/booking.md「バッファを30分に縮める」、reservation-model.md「状態と操作」の
// バッファの切り替え、dynamodb-keys.md「書き込み」、admin-api.md「バッファの切り替え・お客様の情報の変更（2回目b）」）。
// 判定は booking-core（applyBufferChange）に任せ、読む → 判定 → 1トランザクションで書く → 衝突したら読み直す、の流れは
// 予約への操作の保存（operations.ts の saveAdminOperation）をそのまま使う（日ごとのアイテム・META・履歴・下書きの書き方を共有する）。
// 個人情報（PII のアイテム）は読まず、書かない（INV-10）。ログは出さない。
import { type SaveOperationOptions, type SavedDraft, saveAdminOperation } from "./operations.ts";
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
export async function saveBufferChange(
  store: ReservationStore,
  input: BufferChangeInput,
  options: SaveBufferChangeOptions,
): Promise<SaveBufferChangeResult> {
  const result = await saveAdminOperation(
    store,
    {
      kind: "buffer-change",
      reservationId: input.reservationId,
      bufferMinutes: input.bufferMinutes,
    },
    options,
  );
  if (result.ok) return { ok: true, changed: result.changed, drafts: result.drafts };
  switch (result.reason) {
    case "not-found":
    case "not-changeable":
    case "overlaps-existing":
    case "busy":
      return { ok: false, reason: result.reason };
    default:
      // ほかの理由（承認待ちでない、時間の決まり、警告など）は、バッファの切り替えの判定では起きない
      throw new Error("バッファの切り替えでは起きない理由");
  }
}
