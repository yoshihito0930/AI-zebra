// 予約の申込の保存と読み出し（docs/design-docs/dynamodb-keys.md、reservation-model.md）。
// 保存の層が判定するのは重なり（INV-1）と状態の移り変わりだけ。申込の締め切り・時間の単位・料金の計算など、
// 申込の中身の検証は、その前に API の層で行う（dynamodb-keys.md「書き込み」）。
// スタブ：形（名前・引数・戻り値の型）だけを決めている。中身は実装の PR で書く（docs/TESTING.md）。
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { ReservationStatus, Yen } from "@zebra/contracts";
import type { DateTime } from "luxon";

/** 読み書きするテーブル。テストからは DynamoDB Local のクライアントと、テストで作ったテーブルの名前を渡す */
export interface ReservationStore {
  readonly client: DynamoDBClient;
  readonly tableName: string;
}

/** 申込の種類。firm＝本予約申込、provisional＝仮予約申込、second-hold＝第二キープ申込 */
export type ApplicationKind = "firm" | "provisional" | "second-hold";

/** お客様の情報（個人情報。INV-10）。会社名は任意（booking.md「申込フォーム」） */
export interface CustomerInfo {
  readonly name: string;
  readonly companyName?: string;
  readonly email: string;
  readonly phone: string;
  readonly address: string;
  readonly photographerName: string;
}

/** 撮影内容の選択肢：still＝スチール撮影、movie＝ムービー撮影、music＝楽器の演奏を伴う撮影 */
export type ShootingType = "still" | "movie" | "music";

/** 撮影の内容（自由記述の欄は個人情報として扱う。INV-10）。補足事項は任意 */
export interface ShootingInfo {
  readonly types: readonly ShootingType[];
  readonly details: string;
  readonly notes?: string;
}

/** 見積額（calculatePriceFromTable の結果と同じ形。INV-9） */
export interface Estimate {
  readonly subtotalExcludingTax: Yen;
  readonly estimateIncludingTax: Yen;
}

/** フォームからの申込。中身の検証と料金の計算は、API の層で済ませてから渡す */
export interface ReservationApplication {
  readonly kind: ApplicationKind;
  /** 予約区間 [start, end)。どのゾーンで表した DateTime でもよい（保存は UTC。INV-7） */
  readonly start: DateTime;
  readonly end: DateTime;
  readonly partySize: number;
  readonly cycloramaFloorProtection: boolean;
  readonly planId: string;
  readonly equipmentInsurance: boolean;
  readonly optionIds: readonly string[];
  readonly estimate: Estimate;
  readonly customer: CustomerInfo;
  readonly shooting: ShootingInfo;
}

export interface SaveApplicationOptions {
  /** 現在時刻（作成日時・更新日時・履歴の日時。INV-7） */
  readonly now: DateTime;
  /** 読む → 判定 → 書く を試す回数の上限（1 以上）。省略したときの値は実装が決める */
  readonly maxAttempts?: number;
  /**
   * 試すたびに、判定が受付になったあと、TransactWriteItems の直前に呼ぶ（attempt は 1 から）。
   * 判定が不可なら呼ばない。テストで、読んだあとに別の書き込みが入る状況を作るためのもの
   */
  readonly beforeWrite?: (attempt: number) => Promise<void>;
}

/**
 * 申込の保存の結果
 * - 受付：{ ok: true, id }。id は保存した予約の id（この関数が決める）
 * - 不可（枠を確保している予約かブロック枠と重なる）：{ ok: false, reason: "overlaps-existing" }
 * - 不可（第二キープ申込が、どの承認済みの仮予約とも重ならない）：{ ok: false, reason: "no-provisional-to-hold" }
 * - 混み合っている（版番号の衝突が続き、試す回数の上限を超えた）：{ ok: false, reason: "busy" }
 * 不可や混み合っているときは、何も書かない（INV-2）
 */
export type SaveApplicationResult =
  | { readonly ok: true; readonly id: string }
  | {
      readonly ok: false;
      readonly reason: "overlaps-existing" | "no-provisional-to-hold" | "busy";
    };

/**
 * 申込（仮予約・本予約・第二キープ）を保存する。状態は承認待ち（pending-*）、バッファは 60 分、経路はフォーム。
 * かかわる JST の日の日ごとのアイテムを強い整合性で読み、booking-core で重なりを判定し、
 * 日ごとのアイテム・予約（META）・個人情報（PII）・履歴（HIST#…）を 1 回の TransactWriteItems で書く
 */
export function saveApplication(
  store: ReservationStore,
  application: ReservationApplication,
  options: SaveApplicationOptions,
): Promise<SaveApplicationResult> {
  void store;
  void application;
  void options;
  throw new Error("未実装");
}

/** 日ごとのアイテムの占有区間（dynamodb-keys.md「アイテム」の intervals の1件） */
export interface OccupiedInterval {
  readonly kind: "reservation" | "block";
  readonly id: string;
  /** 予約だけが持つ */
  readonly status?: ReservationStatus;
  /** 第二キープ（承認待ちを含む）だけが持つ。付く仮予約の id */
  readonly provisionalIds?: readonly string[];
  /** 占有区間 [start, end)（バッファ込み） */
  readonly start: DateTime;
  readonly end: DateTime;
}

/**
 * 期間（JST の日付 YYYY-MM-DD。from と to を含む）の日ごとのアイテムから、占有区間を読み出す（空き状況に使う）。
 * 日をまたいで2日以上のアイテムに入っている占有区間も、1件として返す。並び順は決めない。
 * 予約の META や個人情報は読まない
 */
export function readOccupiedIntervals(
  store: ReservationStore,
  days: { readonly from: string; readonly to: string },
): Promise<OccupiedInterval[]> {
  void store;
  void days;
  throw new Error("未実装");
}

/** 履歴の「誰が」 */
export type HistoryActor =
  | { readonly kind: "customer" }
  | { readonly kind: "admin"; readonly userId: string }
  | { readonly kind: "system" };

/** 履歴の操作（reservation-model.md「履歴」） */
export type HistoryOperation =
  | "apply"
  | "approve"
  | "reject"
  | "promote"
  | "end"
  | "cancel"
  | "advance"
  | "change"
  | "buffer-change"
  | "direct-entry";

/** 履歴に残す、操作の前後の値 */
export interface HistorySnapshot {
  readonly status: ReservationStatus;
  readonly start: DateTime;
  readonly end: DateTime;
  readonly bufferMinutes: 30 | 60;
  readonly confirmedPrice?: Yen;
  readonly provisionalIds?: readonly string[];
}

export interface HistoryEntry {
  /** 操作の日時 */
  readonly at: DateTime;
  readonly actor: HistoryActor;
  readonly operation: HistoryOperation;
  /** 操作の前。申込・直接入力にはない */
  readonly before?: HistorySnapshot;
  readonly after?: HistorySnapshot;
  /** お客様の情報や撮影の内容が変わったときの、変わった項目の名前だけ（中身は書かない） */
  readonly changedFields?: readonly string[];
}

/** 予約の詳細（META・PII・履歴） */
export interface ReservationDetail {
  readonly id: string;
  readonly status: ReservationStatus;
  /** 予約区間 [start, end) */
  readonly start: DateTime;
  readonly end: DateTime;
  readonly bufferMinutes: 30 | 60;
  /** 経路：form＝フォームの申込、admin＝管理者の直接入力 */
  readonly route: "form" | "admin";
  readonly partySize: number;
  readonly cycloramaFloorProtection: boolean;
  readonly planId: string;
  readonly equipmentInsurance: boolean;
  readonly optionIds: readonly string[];
  readonly estimate: Estimate;
  /** 確定金額（税込）。承認待ちのあいだはない */
  readonly confirmedPrice?: Yen;
  /** 第二キープ（承認待ちを含む）だけが持つ。付く仮予約の id */
  readonly provisionalIds?: readonly string[];
  readonly createdAt: DateTime;
  readonly updatedAt: DateTime;
  readonly customer: CustomerInfo;
  readonly shooting: ShootingInfo;
  /** 古い順 */
  readonly history: readonly HistoryEntry[];
}

/** 予約の詳細を読み出す（`RES#<id>` を Query）。ない id なら null */
export function getReservation(
  store: ReservationStore,
  id: string,
): Promise<ReservationDetail | null> {
  void store;
  void id;
  throw new Error("未実装");
}
