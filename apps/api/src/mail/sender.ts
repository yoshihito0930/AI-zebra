// 受付通知と管理者への通知を送る部品の形（docs/design-docs/notifications.md「部品」）。型だけ。
// 本番は SES、手元は送らずに種類だけを出す、テストは偽物を渡す。SES を呼べるのは apps/api/src/mail/ の中だけ（INV-6）

/** 送るメール。文面は apps/api/src/mail/ の文面を作る関数だけが作る（自由な文面を受け取る経路を作らない。INV-6） */
export interface OutgoingMail {
  /** メールの種類。ログにはこれだけを出す（INV-10） */
  readonly kind: "receipt" | "admin-new-application";
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export interface MailSender {
  /** 送れなかったら例外を投げる */
  send(mail: OutgoingMail): Promise<void>;
}
