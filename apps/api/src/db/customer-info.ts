// お客様の情報・撮影の内容の変更の保存（docs/product-specs/booking.md「お客様の情報・撮影の内容を直す」、
// reservation-model.md「状態と操作」「履歴」、admin-api.md「バッファの切り替え・お客様の情報の変更（2回目b）」）。
// スタブ：形（名前・引数・戻り値）だけを決める。中身は実装担当が書く（docs/TESTING.md 手順4）
import type { AdminCustomerField } from "@zebra/contracts";
import type { DateTime } from "luxon";
import type { ReservationStore, StoredCustomerInfo, StoredShootingInfo } from "./reservations.ts";

/**
 * 直したあとのお客様の情報と撮影の内容。全部の欄を渡して置き換える（渡さなかった欄は消える）。
 * 入力の形の確かめ（氏名と、電話番号かメールアドレスのどちらか1つが必須、欄の形と長さの上限）は API の層で済ませてから渡す
 */
export interface CustomerInfoChange {
  reservationId: string;
  customer: StoredCustomerInfo;
  shooting: StoredShootingInfo;
}

export interface SaveCustomerInfoOptions {
  /** 現在時刻（履歴の日時）。INV-7 */
  now: DateTime;
  /** 操作した管理者のユーザー id（履歴の「誰が」） */
  adminUserId: string;
}

/**
 * 保存の結果。changedFields は変わった項目の名前（並びは AdminCustomerField の順）。
 * 空なら、変わった項目がなく何も書いていない
 */
export type SaveCustomerInfoResult =
  { ok: true; changedFields: readonly AdminCustomerField[] } | { ok: false; reason: "not-found" };

/**
 * お客様の情報・撮影の内容の変更を保存する。どの状態の予約でも直せる（空き判定はしない）。
 * 個人情報のアイテム（PII）の置き換えと履歴（操作は customer-info-change、changedFields は変わった項目の名前だけで、
 * 中身は書かない。INV-10）を、予約の META があることを条件に1トランザクションで書く。日ごとのアイテムは読まない・書かない。
 * 予約がなければ not-found で何も書かない。変わった項目がなければ何も書かない
 */
export function saveCustomerInfo(
  store: ReservationStore,
  change: CustomerInfoChange,
  options: SaveCustomerInfoOptions,
): Promise<SaveCustomerInfoResult> {
  void store;
  void change;
  void options;
  throw new Error("未実装");
}
