// バッファの切り替え（docs/product-specs/booking.md「バッファを30分に縮める」、reservation-model.md「状態と操作」の
// バッファの切り替え、「第二キープと仮予約」、admin-api.md「バッファの切り替え・お客様の情報の変更（2回目b）」）。
// 予約の変更と同じ扱いで判定する。今の checkBufferChange（availability.ts）は第二キープの例外を扱わないので使わない。
// 空き判定・第二キープの外し方・繰り上げ案内・解放と確保の計算と、切り替えられる状態は、予約の変更（reservation-change.ts）と
// 同じ部品（applyOccupiedChange、isChangeable）を使う（同じ判定を2か所に持たない）。
// 入出力を持たない純粋な関数。現在時刻は使わない（INV-5、INV-7）。枠と予約の書き込み（INV-2）と下書きの保存は呼び出す側が行う。
import type { ExistingBlock, ReservationBufferMinutes, TimeRange } from "./availability.ts";
import { applyOccupiedChange, isChangeable } from "./reservation-change.ts";
import type { Reservation } from "./reservation-transitions.ts";

/** バッファの切り替え：どの予約のバッファを、何分にするか */
export interface BufferChange {
  readonly reservationId: string;
  readonly bufferMinutes: ReservationBufferMinutes;
}

export interface BufferChangeInput {
  /** 判定に使う予約（切り替える予約自身と、その予約に付いている第二キープを含む） */
  readonly reservations: readonly Reservation[];
  readonly blocks: readonly ExistingBlock[];
  readonly change: BufferChange;
}

/**
 * 切り替えで作る下書き。お客様への下書きは作らない。仮予約を縮めて第二キープ（承認済み）と重ならなくなったときの、
 * その第二キープのお客様への繰り上げ案内だけを作る（変更のときと同じ。remainingProvisionalIds は、ほかにまだ付いていて
 * 重なっている仮予約の id）
 */
export interface BufferChangeMoveUpNotice {
  readonly kind: "move-up-notice";
  readonly reservationId: string;
  readonly remainingProvisionalIds: readonly string[];
}
export type BufferChangeDraft = BufferChangeMoveUpNotice;

/**
 * 切り替えの結果。
 * - changed：今と同じバッファなら false（何もしない。reservations は渡したまま、drafts・released・secured は空）
 * - reservations：切り替えたあとの予約の一覧（渡した予約と同じ並び）。変わるのは、切り替えた予約のバッファと、
 *   仮予約に付かなくなった第二キープの付く仮予約の id だけ
 * - released・secured：解放する枠・確保する枠（枠を確保している予約の占有区間の、切り替えの前後の差）
 */
export type BufferChangeResult =
  | {
      readonly ok: true;
      readonly changed: boolean;
      readonly reservations: readonly Reservation[];
      readonly drafts: readonly BufferChangeDraft[];
      readonly released: readonly TimeRange[];
      readonly secured: readonly TimeRange[];
    }
  | { readonly ok: false; readonly reason: BufferChangeFailureReason };

/**
 * 切り替えられない理由
 * - not-found：その id の予約がない
 * - not-changeable：承認済みの仮予約・本予約でない（承認待ち・第二キープ・取消・終了。予約の変更と同じ）
 * - overlaps-existing：切り替えたあとの占有区間が、ほかの予約・ブロック枠と重なる（INV-1）
 */
export type BufferChangeFailureReason = "not-found" | "not-changeable" | "overlaps-existing";

/** バッファを切り替える。締め切りや時間の決まりは確かめない（予約区間は変わらない）。現在時刻は使わない（INV-7） */
export function applyBufferChange(input: BufferChangeInput): BufferChangeResult {
  const { reservations, blocks, change } = input;
  const target = reservations.find((reservation) => reservation.id === change.reservationId);
  if (target === undefined) {
    return { ok: false, reason: "not-found" };
  }
  if (!isChangeable(target.status)) {
    return { ok: false, reason: "not-changeable" };
  }
  // 今と同じバッファなら何もしない（枠は変わらないので、判定もしない。booking.md「バッファを30分に縮める」）
  if (target.bufferMinutes === change.bufferMinutes) {
    return { ok: true, changed: false, reservations, drafts: [], released: [], secured: [] };
  }

  const result = applyOccupiedChange({
    reservations,
    blocks,
    target,
    changed: { ...target, bufferMinutes: change.bufferMinutes },
  });
  if (!result.ok) {
    return result;
  }
  // お客様への下書きは作らない。仮予約を縮めて重ならなくなった承認済みの第二キープへの繰り上げ案内だけ
  return {
    ok: true,
    changed: true,
    reservations: result.reservations,
    drafts: result.moveUpNotices,
    released: result.released,
    secured: result.secured,
  };
}
