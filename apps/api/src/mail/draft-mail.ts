// 下書きの文面を作る（docs/product-specs/mail.md「下書きのテンプレート」）。入出力を持たない関数。
// 文面は保存しない・ログに出さない（INV-10）。メールは送らない（INV-6。管理者が Gmail から送る）
import type { ShootingType, Yen } from "@zebra/contracts";
import type { DateTime } from "luxon";
import type { z } from "zod";

/** 撮影内容（スチール撮影・ムービー撮影・楽器の演奏を伴う撮影） */
export type DraftMailShootingType = z.infer<typeof ShootingType>;

/**
 * 下書きの種類と、下書きに差し込む値（下書きを作ったときの値。mail.md「下書きの送り方」）。
 * - approval：承認。approvedAs は、どの承認のテンプレートを使うか（本予約・仮予約・第二キープ）
 * - cancellation：取消。cancellationFee は下書きに差し込んだキャンセル料
 * - move-up-notice：繰り上げの案内。remainingProvisionalIds は、まだ付いている仮予約の id
 */
export type DraftMailContent =
  | { kind: "approval"; approvedAs: "firm" | "provisional" | "second-hold" }
  | { kind: "rejection" }
  | { kind: "promotion" }
  | { kind: "second-hold-ended" }
  | { kind: "cancellation"; cancellationFee: { ratePercent: number; fee: Yen } }
  | { kind: "move-up-notice"; remainingProvisionalIds: readonly string[] }
  | { kind: "bring-forward-notice" }
  | { kind: "change" };

/** 下書きを開いたときの予約の内容（mail.md「文面は、下書きを開いたときの予約の内容で作る」） */
export interface DraftMailReservation {
  /** 予約区間（バッファを含まない）。どのゾーンで渡しても、JST で書く（INV-7） */
  start: DateTime;
  end: DateTime;
  partySize: number;
  equipmentInsurance: boolean;
  customer: {
    name: string;
    photographerName?: string | undefined;
  };
  shooting: {
    types?: readonly DraftMailShootingType[] | undefined;
    details?: string | undefined;
  };
}

export interface DraftMailInput {
  draft: DraftMailContent;
  reservation: DraftMailReservation;
  /** 担当者名（MAIL_STAFF_NAME）。なければ「（担当者名）」と出す */
  staffName?: string | undefined;
  /** 署名（MAIL_SIGNATURE。改行を含む）。なければ「--」の行から下を出さない */
  signature?: string | undefined;
}

/**
 * 作った文面。
 * - text：強調の印を除いた本文（改行は "\n"）
 * - html：強調を赤字・青字・下線の span にし、改行を <br> にした本文。差し込む値は HTML のエスケープをする
 * - attachConsentForm：同意書を Gmail で添付するか（本予約の承認と昇格）
 */
export interface DraftMail {
  subject: string;
  text: string;
  html: string;
  attachConsentForm: boolean;
}

export function renderDraftMail(input: DraftMailInput): DraftMail {
  void input;
  throw new Error("未実装");
}
