// 受付通知と管理者への新しい申込の通知の文面を作る関数（入出力を持たない）。
// 根拠：docs/product-specs/mail.md「受付通知」「管理者への新しい申込の通知」「日時の書き方」、
// docs/design-docs/notifications.md「部品」、core-beliefs.md（INV-6、INV-7、INV-10）。
// - どちらも自由な文面を受け取らない（INV-6）
// - 管理者への通知は、お客様の情報を受け取らない（INV-10）。予約の id と管理画面の URL だけ
import type { ApplicationRequest } from "@zebra/contracts";
import type { DateTime } from "luxon";

/** 件名とテキストの本文（受付通知も管理者への通知も、テキストだけのメール） */
export interface NotificationMail {
  readonly subject: string;
  readonly text: string;
}

/** 受付通知に差し込む、申込の内容と設定 */
export interface ReceiptMailInput {
  /** お客様の氏名（申込フォームの氏名） */
  readonly customerName: string;
  /** 受付番号（ReceiptNumber の形） */
  readonly receiptNumber: string;
  /** 申込の種類：firm＝本予約、provisional＝仮予約、second-hold＝第二キープ */
  readonly kind: ApplicationRequest["kind"];
  /** 予約区間の開始と終わり。どのゾーンで渡しても、JST で書く（INV-7） */
  readonly start: DateTime;
  readonly end: DateTime;
  /** 署名（MailSettings の signature。改行は "\n"）。なければ「--」の行から下を出さない */
  readonly signature?: string | undefined;
}

/** 管理者への新しい申込の通知に差し込む値。お客様の情報は受け取らない（INV-10） */
export interface AdminNotificationMailInput {
  /** 予約の id */
  readonly reservationId: string;
  /** 管理画面の URL（MailSettings の adminAppUrl。例：http://localhost:5174/）。なければリンクを書かない */
  readonly adminAppUrl?: string | undefined;
}

/** 受付通知の件名と本文を作る */
export function renderReceiptMail(input: ReceiptMailInput): NotificationMail {
  void input;
  throw new Error("未実装");
}

/** 管理者への新しい申込の通知の件名と本文を作る */
export function renderAdminNotificationMail(input: AdminNotificationMailInput): NotificationMail {
  void input;
  throw new Error("未実装");
}
