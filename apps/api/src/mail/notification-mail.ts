// 受付通知と管理者への新しい申込の通知の文面を作る関数（入出力を持たない）。
// 根拠：docs/product-specs/mail.md「受付通知」「管理者への新しい申込の通知」「日時の書き方」、
// docs/design-docs/notifications.md「部品」、core-beliefs.md（INV-6、INV-7、INV-10）。
// - どちらも自由な文面を受け取らない（INV-6）
// - 管理者への通知は、お客様の情報を受け取らない（INV-10）。予約の id と管理画面の URL だけ
// - テンプレートの文面は mail.md の枠の中身をそのまま写す（行の単位）。テキストだけのメール（強調の印は使わない）
// - 日時の書き方・件名の終わり・差し込む値の置き換え・設定の「ない」の扱いは、下書きと同じ部品（mail-format.ts）
import type { ApplicationRequest } from "@zebra/contracts";
import type { DateTime } from "luxon";
import {
  durationText,
  fillPlaceholders,
  reservationTimeText,
  settingOf,
  SUBJECT_SUFFIX,
} from "./mail-format.ts";

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

// ---- 受付通知（mail.md「受付通知」） ----

/** 件名の「{予約日時}の」に続く部分（「（スタジオゼブラ）」の前まで） */
const RECEIPT_SUBJECT = "お申し込みを受け付けました";

/** 本文（「--」の行より前） */
const RECEIPT_BODY: readonly string[] = [
  "{氏名}様",
  "",
  "この度はスタジオゼブラへお申し込みいただき、ありがとうございます。",
  "下記の内容で、お申し込みを受け付けました。",
  "",
  "受付番号：{受付番号}",
  "お申し込みの種類：{申込の種類}",
  "ご希望の日時：{予約日時}（{利用時間}）",
  "",
  "お申し込みの内容を確認のうえ、担当者からあらためてご連絡いたします。",
  "このメールの時点では、ご予約はまだ確定していません。",
  "",
  "お問い合わせの際は、受付番号をお伝えください。",
  "このメールは自動でお送りしています。ご返信いただくと、スタジオゼブラの担当者に届きます。",
];

/** 署名の部分。{署名} の設定がなければ、「--」の行から下を出さない（担当者名は書かない） */
const RECEIPT_SIGNATURE: readonly string[] = ["", "--", "{署名}"];

/** {申込の種類} */
const KIND_LABELS: Readonly<Record<ApplicationRequest["kind"], string>> = {
  firm: "本予約",
  provisional: "仮予約",
  "second-hold": "第二キープ",
};

/** 受付通知の件名と本文を作る */
export function renderReceiptMail(input: ReceiptMailInput): NotificationMail {
  const signature = settingOf(input.signature);
  const values = new Map<string, string>([
    ["氏名", input.customerName],
    ["受付番号", input.receiptNumber],
    ["申込の種類", KIND_LABELS[input.kind]],
    ["予約日時", reservationTimeText(input.start, input.end)],
    ["利用時間", durationText(input.start, input.end)],
  ]);
  if (signature !== undefined) values.set("署名", signature);
  const lines = signature === undefined ? RECEIPT_BODY : [...RECEIPT_BODY, ...RECEIPT_SIGNATURE];
  return {
    subject: fillPlaceholders(`{予約日時}の${RECEIPT_SUBJECT}${SUBJECT_SUFFIX}`, values),
    text: lines.map((line) => fillPlaceholders(line, values)).join("\n"),
  };
}

// ---- 管理者への新しい申込の通知（mail.md「管理者への新しい申込の通知」） ----

const ADMIN_SUBJECT = `新しいお申し込みがあります${SUBJECT_SUFFIX}`;

const ADMIN_BODY: readonly string[] = [
  "新しいお申し込みがありました。管理画面で内容を確かめ、承認か却下をしてください。",
  "",
  "{予約の URL}",
];

/** ADMIN_APP_URL の設定がないときに、リンクの代わりに書く文 */
const ADMIN_NO_LINK = "管理画面の承認待ちを確かめてください";

/** 管理者への新しい申込の通知の件名と本文を作る */
export function renderAdminNotificationMail(input: AdminNotificationMailInput): NotificationMail {
  // 受け取った値のうち、予約の id と管理画面の URL だけを使う（ほかの値が混ざっていても書かない。INV-10）
  const { reservationId, adminAppUrl } = input;
  const baseUrl = settingOf(adminAppUrl?.trim());
  const values = new Map<string, string>([
    ["予約の URL", baseUrl === undefined ? ADMIN_NO_LINK : reservationUrl(baseUrl, reservationId)],
  ]);
  return {
    subject: ADMIN_SUBJECT,
    text: ADMIN_BODY.map((line) => fillPlaceholders(line, values)).join("\n"),
  };
}

/**
 * 予約の詳細へのリンク：{ADMIN_APP_URL}#/reservations/{予約の id}。
 * ADMIN_APP_URL の最後の / は、あってもなくてもよい（そろえてから付ける。notifications.md「設定」）
 */
function reservationUrl(baseUrl: string, reservationId: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return `${base}#/reservations/${encodeURIComponent(reservationId)}`;
}
