// 手元（server.ts）で使う、受付通知と管理者への通知を送る部品（docs/design-docs/notifications.md「部品」）。
// 送らずに、送ったことだけを標準出力に出す。出すのはメールの種類と、あて先があるかだけ。
// 件名・本文・あて先は出さない（INV-10）
import type { MailSender } from "./sender.ts";

/** 送らずに種類とあて先の有無だけを出す部品を作る。write は出力先（省くと標準出力） */
export function createLocalMailSender(
  write: (line: string) => void = (line) => console.log(line),
): MailSender {
  return {
    send(mail) {
      const to = mail.to.trim() === "" ? "なし" : "あり";
      write(`メール（手元なので送らない）：種類=${mail.kind} あて先=${to}`);
      return Promise.resolve();
    },
  };
}
