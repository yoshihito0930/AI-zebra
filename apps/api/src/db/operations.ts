// 予約への操作（承認・却下・昇格・取消・繰り上げ・変更）の保存（DynamoDB）。
// 根拠：docs/design-docs/dynamodb-keys.md（日ごとのアイテム、書き込みの手順、下書きのアイテム）、
// reservation-model.md（状態と操作、第二キープと仮予約、金額、履歴）、core-beliefs.md（INV-1、INV-2、INV-6、INV-7、INV-9、INV-10）。
// 判定は booking-core（approveReservation・rejectReservation・applyReservationOperation・applyReservationChange）に任せ、
// この層は「読む → 判定 → 1トランザクションで書く（版番号が読んだときと同じこと）→ 衝突したら読み直す」を行う。
// バッファの切り替え・直接入力・ブロック枠の保存は、この関数では扱わない。
import type { PriceTable, Yen } from "@zebra/contracts";
import type { DateTime } from "luxon";
import type { ReservationStore } from "./reservations.ts";

/** 変更後の申込の内容（日時のほか。見積の再計算とプランの決め直しに使う） */
export interface ReservationChangeContent {
  readonly partySize: number;
  readonly cycloramaFloorProtection: boolean;
  readonly equipmentInsurance: boolean;
  readonly optionIds: readonly string[];
}

/**
 * 管理者の操作。終了（第二キープ）は、昇格に続けてシステムが行うので、ここにはない。
 * - approve：承認。確定金額（税込）は管理者が決める
 * - cancel：取消。キャンセル料の日数は、options.now（管理者が取消を操作した時点）の JST の日で数える
 * - change：変更。確定金額は管理者が決める。見積は料金表で計算し直す
 */
export type ReservationOperationInput =
  | { readonly kind: "approve"; readonly reservationId: string; readonly confirmedPrice: Yen }
  | { readonly kind: "reject"; readonly reservationId: string }
  | { readonly kind: "promote"; readonly reservationId: string }
  | { readonly kind: "cancel"; readonly reservationId: string }
  | { readonly kind: "move-up"; readonly reservationId: string }
  | {
      readonly kind: "change";
      readonly reservationId: string;
      readonly start: DateTime;
      readonly end: DateTime;
      readonly content: ReservationChangeContent;
      readonly confirmedPrice: Yen;
      readonly priceTable: PriceTable;
    };

export interface SaveOperationOptions {
  /** 現在時刻（更新日時・履歴の日時・下書きの日時。取消ではキャンセル料の日数にも使う） */
  readonly now: DateTime;
  /** 操作した管理者のユーザー id（履歴の「誰が」） */
  readonly adminUserId: string;
  /** 読む → 判定 → 書く を試す回数の上限 */
  readonly maxAttempts?: number;
  /** 判定が可になったあと、TransactWriteItems の直前に呼ぶ（attempt は1から）。テストで、読んだあとの書き込みを作るため */
  readonly beforeWrite?: (attempt: number) => Promise<void>;
}

/** 下書きの種類と、差し込む値。reservationId はあて先の予約（アイテムの pk は RES#<この id>） */
export type OperationDraft =
  | { readonly kind: "approval"; readonly reservationId: string; readonly confirmedPrice: Yen }
  | { readonly kind: "rejection"; readonly reservationId: string }
  | { readonly kind: "promotion"; readonly reservationId: string }
  | { readonly kind: "second-hold-ended"; readonly reservationId: string }
  | {
      readonly kind: "cancellation";
      readonly reservationId: string;
      readonly cancellationFee: { readonly ratePercent: number; readonly fee: Yen };
    }
  | {
      readonly kind: "move-up-notice";
      readonly reservationId: string;
      /** ほかに付いていて、まだ繰り上げられない理由になっている仮予約の id */
      readonly remainingProvisionalIds: readonly string[];
    }
  | { readonly kind: "bring-forward-notice"; readonly reservationId: string }
  | { readonly kind: "change"; readonly reservationId: string };

/** 下書きの状態：未送信／送信済み／送らない */
export type DraftStatus = "unsent" | "sent" | "not-sent";

/** 操作と同じトランザクションで書いた下書き */
export interface SavedDraft {
  readonly draft: OperationDraft;
  /** アイテムの sk（DRAFT#<日時（UTC）>#<連番>） */
  readonly sk: string;
  readonly status: DraftStatus;
}

/**
 * できない理由
 * - not-found：その id の予約がない
 * - not-pending：承認・却下で、予約が承認待ちでない
 * - invalid-status：昇格・取消・繰り上げで、その操作ができる状態でない
 * - still-held：繰り上げで、付いている仮予約がまだ仮予約のまま重なっている
 * - overlaps-existing：変更後の占有区間が、ほかの予約・ブロック枠と重なる
 * - not-changeable：変更できない予約（承認済みの仮予約・本予約のほか）
 * - busy：版番号の衝突がやり直しの上限を超えた（混み合っている）
 */
export type SaveOperationFailure =
  | "not-found"
  | "not-pending"
  | "invalid-status"
  | "still-held"
  | "overlaps-existing"
  | "not-changeable"
  | "busy";

export type SaveOperationResult =
  | { readonly ok: true; readonly drafts: readonly SavedDraft[] }
  | { readonly ok: false; readonly reason: SaveOperationFailure };

/**
 * 予約への操作を保存する。予約の META、日ごとのアイテム（操作にかかわる JST の日すべて）、履歴、下書きを
 * 1回の TransactWriteItems で書く（INV-2）。できない操作なら何も書かない。
 */
export function saveReservationOperation(
  store: ReservationStore,
  operation: ReservationOperationInput,
  options: SaveOperationOptions,
): Promise<SaveOperationResult> {
  void store;
  void operation;
  void options;
  throw new Error("未実装");
}
