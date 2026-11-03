// 管理画面の予約の一覧の読み出し（docs/design-docs/admin-api.md「予約の一覧」、dynamodb-keys.md「読み出し」）。
// - 期間：期間の日ごとのアイテム（DAY#<JST の日付>）を読み、出てくる予約の META・ブロック枠の META と、
//   表示する氏名のためだけに予約の PII を読む
// - 状態だけ：状態の GSI（gsi1pk = STATUS#<状態>、gsi1sk = 開始日時）を読む
// 出るのは枠を確保している予約（承認待ち・仮予約・本予約・第二キープ）とブロック枠だけ。取消・終了は出ない。
// どちらも開始の早い順（開始が同じなら終わりの早い順、それも同じなら id の順）
import type { HoldingReservationStatus, Yen } from "@zebra/contracts";
import type { DateTime } from "luxon";
import type { ReservationStore } from "./reservations.ts";

/** 一覧の予約1件。個人情報は氏名だけ */
export interface AdminListedReservation {
  id: string;
  /** フォームの申込だけが持つ */
  receiptNumber?: string;
  status: HoldingReservationStatus;
  /** 予約区間（バッファを含まない） */
  start: DateTime;
  end: DateTime;
  bufferMinutes: 30 | 60;
  route: "form" | "admin";
  partySize: number;
  /** 申込（または直接入力）のときの見積額（税込） */
  estimateIncludingTax: Yen;
  /** 承認待ちのあいだはない */
  confirmedPrice?: Yen;
  /** 第二キープ（承認待ちを含む）だけが持つ */
  provisionalIds?: readonly string[];
  customerName: string;
}

/** 一覧のブロック枠1件 */
export interface AdminListedBlock {
  id: string;
  /** ブロック枠の区間（バッファを含まない） */
  start: DateTime;
  end: DateTime;
  bufferMinutes: 0 | 30 | 60;
  route: "admin" | "google-calendar";
  memo?: string;
}

export interface AdminListPeriod {
  /** JST の日付 YYYY-MM-DD。両端を含む。長さ（最長62日）と前後は、API の層で確かめる */
  from: string;
  to: string;
  /** 渡すと、期間の中をその状態で絞る（ブロック枠は返さない） */
  status?: HoldingReservationStatus;
}

export interface AdminList {
  reservations: AdminListedReservation[];
  blocks: AdminListedBlock[];
}

/** 期間の日にかかる予約とブロック枠 */
export function listAdminReservationsInPeriod(
  store: ReservationStore,
  period: AdminListPeriod,
): Promise<AdminList> {
  void store;
  void period;
  throw new Error("未実装");
}

/** その状態の予約（期間によらない） */
export function listAdminReservationsByStatus(
  store: ReservationStore,
  status: HoldingReservationStatus,
): Promise<AdminListedReservation[]> {
  void store;
  void status;
  throw new Error("未実装");
}
