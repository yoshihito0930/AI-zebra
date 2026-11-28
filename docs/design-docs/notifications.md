# 受付通知と管理者への通知

フォームからの申込を受け付けたときに、システムが自動で送る2つのメールの、送る部品の形。文面と送るときの決まりは [mail.md](../product-specs/mail.md) の「受付通知」「管理者への新しい申込の通知」。

関連：[core-beliefs.md](core-beliefs.md)（INV-6、INV-7、INV-10）、[TECH_STACK.md](../TECH_STACK.md)（SES、送信元）

## 部品

置き場所は apps/api/src/mail/（自律度「中」）。SES を呼べるのは、このフォルダーの中だけ（lint。INV-6）。

- **文面を作る関数**（入出力を持たない）
  - 受付通知：申込の内容（氏名、受付番号、申込の種類、予約区間）と設定（署名）を受け取り、件名とテキストの本文を返す
  - 管理者への通知：予約の id と設定（管理画面の URL）を受け取り、件名とテキストの本文を返す
  - どちらも、自由な文面を受け取らない（INV-6）。管理者への通知の関数は、お客様の情報を受け取らない（INV-10）
- **送る部品**（`MailSender`。下の形）
  - 本番（lambda.ts）：SES（SESv2 の `SendEmail`）で送る。送信元は `noreply@studiozebra-1st.com`、返信先は `studiozebra1st@gmail.com`
  - 手元（server.ts）：送らずに、送ったことだけを標準出力に出す。出すのはメールの種類と、あて先があるかだけ。件名・本文・あて先は出さない（INV-10）
  - テスト：送ったメールを覚えておく偽物を渡す
- **送る流れ**：申込の処理（apps/api/src/public/applications.ts）が、申込を保存したあとに、受付通知と管理者への通知を順に送る。どちらも送れなくても申込の返事（201）は変えず、エラーの種類だけをログに出す（`receipt-mail-failed`・`admin-notification-failed`）。片方が送れなくても、もう片方は送る

```ts
// apps/api/src/mail/sender.ts（型だけ）
export interface OutgoingMail {
  /** メールの種類。ログにはこれだけを出す */
  readonly kind: "receipt" | "admin-new-application";
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export interface MailSender {
  /** 送れなかったら例外を投げる */
  send(mail: OutgoingMail): Promise<void>;
}
```

- `createApp(store, adminUserId, mail?, mailSender?)` の4つ目の引数で渡す。省略したら送らない（今のテストのため）
- 申込の処理には、`ApplicationDeps` の `mail`（設定）と `mailSender` で渡す

## 設定

`MailSettings`（apps/api/src/mail/settings.ts）に足す。どれも環境変数で渡し、server.ts と lambda.ts が読む。

| 環境変数 | 内容 |
|---|---|
| `MAIL_SIGNATURE` | 受付通知の署名（下書きと同じ設定） |
| `MAIL_ADMIN_TO` | 管理者への通知のあて先。なければ管理者への通知を送らない |
| `ADMIN_APP_URL` | 管理画面の URL（例：手元なら `http://localhost:5174/`）。予約の詳細へのリンクは `{ADMIN_APP_URL}#/reservations/{予約の id}` |

- どの変数も、ない・空・空白だけのときは「ない」と同じに扱う（`MAIL_STAFF_NAME`・`MAIL_SIGNATURE` と同じ。ユーザーの判断）
- `ADMIN_APP_URL` の最後の `/` は、あってもなくてもよい。リンクは、最後の `/` をそろえてから `#/reservations/{予約の id}` を付ける（`http://localhost:5174` でも `http://localhost:5174/` でも `http://localhost:5174/#/reservations/{予約の id}`。ユーザーの判断）
- リポジトリ（コード・テスト・README）には架空の値だけを書く。本番の値は、AWS の準備のときに Lambda の環境変数に入れる
- SES の送信元のドメイン認証（DKIM）と、サンドボックスの解除は、AWS の準備のときに人間が行う（TECH_STACK.md「メールの送信元」）

## テスト

- 文面を作る関数：mail.md の例の各行（describe「受付通知」「管理者への新しい申込の通知」）
- 申込の処理（統合テスト）：受け付けたら、偽物の `MailSender` に2通（受付通知・管理者への通知）が渡ること。断ったら1通も渡らないこと。送れなかったとき（偽物が例外を投げる）も 201 と受付番号が返ること
- INV-6：受付通知の本文に、金額・「確定しました」などの文がないこと。`MailSender` に渡るのは、上の2つの種類だけであること
- INV-10：管理者への通知の件名・本文に、申込のお客様の情報（氏名・メールアドレス・電話番号・撮影の内容）が入らないこと。ログに、あて先・氏名・本文が出ないこと

## まだ決めていないこと

- SES に送れなかったことを、ログから管理者に知らせる仕組み（CloudWatch のアラームなど）。AWS の準備のときに決める
