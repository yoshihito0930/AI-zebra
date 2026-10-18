// 予約の変更（docs/product-specs/booking.md「予約の変更」、docs/design-docs/reservation-model.md「状態と操作」「第二キープと仮予約」「金額」）。
// 入出力を持たない純粋な関数。現在時刻は使わない（INV-5、INV-7）。
// テストのPR（docs/TESTING.md の手順2）で形だけを決めたスタブ。中身は実装のPRで書く。
import type { PriceTable, Yen } from "@zebra/contracts";
import type { DateTime } from "luxon";
import type { ExistingBlock, TimeRange } from "./availability";
import type { calculatePriceFromTable } from "./price-table-pricing";
import type { Reservation, ReservationDraft } from "./reservation-transitions";

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
 */
export function applyReservationChange(input: {
  readonly reservations: readonly Reservation[];
  readonly blocks: readonly ExistingBlock[];
  readonly priceTable: PriceTable;
  readonly change: ReservationChange;
}): ReservationChangeResult {
  void input;
  throw new Error("未実装");
}
