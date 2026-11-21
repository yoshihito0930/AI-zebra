// 下書きの文面に差し込む担当者名と署名の設定（docs/design-docs/admin-api.md「担当者名と署名の設定」、docs/product-specs/mail.md「差し込む値」）。
// 本番の値は Lambda の環境変数で渡し、リポジトリには書かない（担当者の名前や携帯の番号を公開しないため）

/** 担当者名と署名。どちらも省略できる（担当者名がなければ「（担当者名）」、署名がなければ署名を出さない） */
export interface MailSettings {
  /** 担当者名（環境変数 MAIL_STAFF_NAME） */
  readonly staffName?: string;
  /** 署名（環境変数 MAIL_SIGNATURE。改行は \n と書く）。下書きと受付通知で使う */
  readonly signature?: string;
  /** 管理者への新しい申込の通知のあて先（環境変数 MAIL_ADMIN_TO）。なければ送らない（notifications.md「設定」） */
  readonly adminNotificationTo?: string;
  /** 管理画面の URL（環境変数 ADMIN_APP_URL）。管理者への通知の、予約の詳細へのリンクに使う */
  readonly adminAppUrl?: string;
}
