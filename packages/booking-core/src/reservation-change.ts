// 予約の変更（docs/product-specs/booking.md「予約の変更」、docs/design-docs/reservation-model.md「状態と操作」「第二キープと仮予約」「金額」）。
// 入出力を持たない純粋な関数。現在時刻は使わない（INV-5、INV-7）。
// 枠と予約の書き込み（INV-2）と、下書きの保存・送信（INV-6）は呼び出す側が行う。
import type { PriceTable, ReservationStatus, Yen } from "@zebra/contracts";
import type { DateTime } from "luxon";
import {
  type ExistingBlock,
  type TimeRange,
  occupiedRangeOf,
  overlaps,
  overlapsAnyHolding,
} from "./availability";
import { calculatePriceFromTable, decidePlanId } from "./price-table-pricing";
import {
  type Reservation,
  type ReservationDraft,
  holdingRanges,
  isSecondHoldStatus,
  occupiedOf,
  provisionalsStillHolding,
  subtractRanges,
} from "./reservation-transitions";

/**
 * 変更後の申込内容のうち、見積の再計算に使うもの。
 * プランは、人数とホリゾントの養生から料金表で決める（booking.md「料金」）
 */
export interface ReservationChangeContent {
  readonly partySize: number;
  readonly cycloramaFloorProtection: boolean;
  readonly equipmentInsurance: boolean;
  /** 料金表のオプションの id */
  readonly optionIds: readonly string[];
}

/** 管理者が行う変更。日時（移動・延長・短縮）と申込内容。日時を変えないときは、今の予約区間をそのまま渡す */
export interface ReservationChange {
  readonly reservationId: string;
  /** 変更後の予約区間 [start, end)。バッファは変えない（バッファの切り替えは別の操作） */
  readonly start: DateTime;
  readonly end: DateTime;
  readonly content: ReservationChangeContent;
  /** 管理者が決めた確定金額（税込）。初期値は、再計算した見積（reservation-model.md「金額」） */
  readonly confirmedAmount: Yen;
}

/** 再計算した見積（税抜の合計と税込の見積額）。calculatePriceFromTable の結果と同じ形 */
export type ReservationChangeEstimate = ReturnType<typeof calculatePriceFromTable>;

/**
 * 変更で作る下書き
 * - change：変更の下書き（変更した予約のお客様へ）
 * - move-up-notice：仮予約を動かして重ならなくなった第二キープ（承認済み）のお客様への繰り上げ案内。
 *   仮予約が取消になったときと同じ形（remainingProvisionalIds は、その第二キープに付いている仮予約のうち、
 *   まだ仮予約のまま重なっているもの）
 */
export type ReservationChangeDraft =
  | { readonly kind: "change"; readonly reservationId: string }
  | Extract<ReservationDraft, { kind: "move-up-notice" }>;

/**
 * 変更が不可の理由
 * - overlaps-existing：変更後の占有区間が、ほかの予約（枠を確保しているもの）かブロック枠の占有区間と重なる（空き判定）
 * - not-found：reservations に reservationId の予約がない
 * - not-changeable：変更できない状態の予約（取消・終了など）。どの状態を変更できるかは例にない
 */
export type ReservationChangeFailureReason = "overlaps-existing" | "not-found" | "not-changeable";

/**
 * 変更の結果。成功なら
 * - reservations：変更のあとの予約すべて（並び順は引数の reservations のまま）。変更した予約は、予約区間と確定金額だけが変わる（状態は変えない）
 *   仮予約を動かして重ならなくなった第二キープ（承認待ちを含む）は、付く仮予約の id からその仮予約を外す（ほかは変えない。reservation-model.md「第二キープと仮予約」）
 * - released：解放する枠。secured：確保する枠。どちらも、枠を確保している予約の占有区間の、変更の前後の差
 *   （開始の早い順。重なる区間・接する区間はつなぐ）。1トランザクションで書く（INV-2）
 * - estimate：変更後の内容で、料金表で再計算した見積
 * - drafts：下書き
 */
export type ReservationChangeResult =
  | {
      readonly ok: true;
      readonly reservations: readonly Reservation[];
      readonly released: readonly TimeRange[];
      readonly secured: readonly TimeRange[];
      readonly estimate: ReservationChangeEstimate;
      readonly drafts: readonly ReservationChangeDraft[];
    }
  | { readonly ok: false; readonly reason: ReservationChangeFailureReason };

/**
 * 予約を変更する。変更後の占有区間で空き判定を通す。自分自身の変更前の占有区間は除いて判定する。
 * 仮予約を動かすときは、その仮予約に付いている第二キープの枠と重なってよい（booking.md「第二キープが付いている仮予約の日時を変える」）
 *
 * 変更できるのは、承認済みの仮予約・本予約だけ。ほかは not-changeable
 * - 承認待ち：承認は申込どおりに行い、日時や内容の変更は承認のあとに行う（booking.md「予約の状態」）
 * - 取消・終了：枠を確保していない
 * - 第二キープ（承認待ちを含む）：自身の変更は例にない（付く仮予約の決め直し・空き判定の例外の扱いが決まっていない）
 *
 * 変更後の予約区間が不正な日時か、終了が開始以前なら RangeError を投げる（occupiedRangeOf）。
 * 30分単位でない区間、料金表にないオプションの id などは、見積を計算できないので RangeError を投げる（calculatePriceFromTable）。
 * 最短・最長の利用時間や締め切りは確かめない（直接入力と同じく、警告は呼び出す側が checkTimeUnitAndDuration などで出す）
 */
export function applyReservationChange(input: {
  readonly reservations: readonly Reservation[];
  readonly blocks: readonly ExistingBlock[];
  readonly priceTable: PriceTable;
  readonly change: ReservationChange;
}): ReservationChangeResult {
  const { reservations, blocks, priceTable, change } = input;
  const target = reservations.find((reservation) => reservation.id === change.reservationId);
  if (target === undefined) {
    return { ok: false, reason: "not-found" };
  }
  if (!isChangeable(target.status)) {
    return { ok: false, reason: "not-changeable" };
  }

  const changed: Reservation = {
    ...target,
    start: change.start,
    end: change.end,
    confirmedAmount: change.confirmedAmount,
  };
  const nextOccupied = occupiedRangeOf(changed, changed.bufferMinutes, "変更後の予約区間");
  const estimate = calculatePriceFromTable(priceTable, {
    planId: decidePlanId(priceTable, {
      partySize: change.content.partySize,
      cycloramaFloorProtection: change.content.cycloramaFloorProtection,
    }),
    start: change.start,
    end: change.end,
    equipmentInsurance: change.content.equipmentInsurance,
    optionIds: change.content.optionIds,
  });

  // 空き判定から除くもの：自分自身の変更前の占有区間と、仮予約なら付いている第二キープ（承認待ちを含む）の枠
  const isOwnSecondHold = (reservation: Reservation): boolean =>
    target.status === "provisional" &&
    isSecondHoldStatus(reservation.status) &&
    reservation.provisionalIds.includes(target.id);
  const others = reservations.filter(
    (reservation) => reservation !== target && !isOwnSecondHold(reservation),
  );
  if (overlapsAnyHolding(nextOccupied, others, blocks)) {
    return { ok: false, reason: "overlaps-existing" };
  }

  // 仮予約を動かして重ならなくなった第二キープ（承認待ちを含む）は、その仮予約に付かなくなる（reservation-model.md「第二キープと仮予約」）
  const detached = new Set(
    reservations.filter(
      (reservation) =>
        isOwnSecondHold(reservation) && !overlaps(nextOccupied, occupiedOf(reservation)),
    ),
  );
  const after = reservations.map((reservation): Reservation => {
    if (reservation === target) {
      return changed;
    }
    if (detached.has(reservation)) {
      return {
        ...reservation,
        provisionalIds: reservation.provisionalIds.filter((id) => id !== target.id),
      };
    }
    return reservation;
  });

  const drafts: ReservationChangeDraft[] = [{ kind: "change", reservationId: target.id }];
  // この変更で重ならなくなった承認済みの第二キープには、仮予約が取消になったときと同じ案内の下書きを作る。
  // 承認待ちの第二キープは、承認待ちのまま（下書きなし。仮予約の取消と同じ）。
  // 変更の前から重なっていなかったもの（バッファの切り替えなどで）は、この変更で重ならなくなったのではないので、案内を作らない
  const targetOccupiedBefore = occupiedOf(target);
  for (const [index, reservation] of reservations.entries()) {
    const secondHold = after[index];
    if (
      secondHold !== undefined &&
      detached.has(reservation) &&
      reservation.status === "second-hold" &&
      overlaps(targetOccupiedBefore, occupiedOf(reservation))
    ) {
      drafts.push({
        kind: "move-up-notice",
        reservationId: secondHold.id,
        remainingProvisionalIds: provisionalsStillHolding(secondHold, after),
      });
    }
  }

  const beforeHolding = holdingRanges(reservations);
  const afterHolding = holdingRanges(after);
  return {
    ok: true,
    reservations: after,
    released: subtractRanges(beforeHolding, afterHolding),
    secured: subtractRanges(afterHolding, beforeHolding),
    estimate,
    drafts,
  };
}

/** 変更できる状態か。承認済みの仮予約・本予約だけ（applyReservationChange の説明） */
function isChangeable(status: ReservationStatus): boolean {
  return status === "provisional" || status === "firm";
}
