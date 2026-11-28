// 本番（lambda.ts）で受付通知と管理者への通知を送る部品（docs/design-docs/notifications.md「部品」）。
// SES（SESv2 の SendEmail）で送る。SES を呼べるのは apps/api/src/mail/ の中だけ（lint。INV-6）。
// - 送信元は noreply@studiozebra-1st.com、返信先は studiozebra1st@gmail.com（TECH_STACK.md「メールの送信元」）。
//   お客様が返信すると Gmail に届く
// - テキストだけのメール（mail.md「受付通知」）。件名・本文は UTF-8
// - 文面は文面を作る関数（notification-mail.ts）が作ったものだけ。ここでは中身を変えない
// - 送れなかったら例外を投げる。SES のエラーのメッセージにはあて先が入ることがあるので、
//   投げ直す例外にはエラーの名前だけを入れ、元の例外は付けない（INV-10）
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import type { MailSender, OutgoingMail } from "./sender.ts";

/** 送信元（TECH_STACK.md「メールの送信元」） */
export const MAIL_FROM = "noreply@studiozebra-1st.com";
/** 返信先（Reply-To） */
export const MAIL_REPLY_TO = "studiozebra1st@gmail.com";

/** SES のクライアントのうち、この部品が使うところ（テストで差し替える） */
export interface SesClient {
  send(command: SendEmailCommand): Promise<unknown>;
}

/** SES で送る部品を作る。client を省くと、環境のリージョン（Lambda では AWS_REGION）の SESv2 のクライアントを使う */
export function createSesMailSender(client: SesClient = new SESv2Client({})): MailSender {
  return {
    async send(mail) {
      try {
        await client.send(sendEmailCommandOf(mail));
      } catch (error) {
        const name = error instanceof Error ? error.name : "unknown";
        // eslint-disable-next-line preserve-caught-error -- INV-10：SES のエラーのメッセージにはあて先が入ることがあるので、元の例外は付けない
        throw new Error(`SES に送れなかった（${mail.kind}、${name}）`);
      }
    },
  };
}

/** 送るメールから、SESv2 の SendEmail の中身を組み立てる */
export function sendEmailCommandOf(mail: OutgoingMail): SendEmailCommand {
  return new SendEmailCommand({
    FromEmailAddress: MAIL_FROM,
    ReplyToAddresses: [MAIL_REPLY_TO],
    Destination: { ToAddresses: [mail.to] },
    Content: {
      Simple: {
        Subject: { Data: mail.subject, Charset: "UTF-8" },
        Body: { Text: { Data: mail.text, Charset: "UTF-8" } },
      },
    },
  });
}
