// 管理者による予約の直接入力の保存（docs/product-specs/booking.md「管理者による予約の直接入力とブロック枠」の
// 「直接入れる予約のルール」、reservation-model.md「状態と操作」の直接入力、dynamodb-keys.md「書き込み」）。
// スタブ：形（名前・引数・戻り値）だけを決める。中身は実装担当が書く（docs/TESTING.md 手順4）
import type { Yen } from "@zebra/contracts";
import type { DateTime } from "luxon";
import type {
  ReservationApplication,
  ReservationStore,
  StoredCustomerInfo,
  StoredShootingInfo,
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
export function saveDirectEntry(
  store: ReservationStore,
  entry: DirectEntry,
  options: SaveDirectEntryOptions,
): Promise<SaveDirectEntryResult> {
  void store;
  void entry;
  void options;
  throw new Error("未実装");
}
