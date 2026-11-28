import { describe, expect, it } from "vitest";
import { mailSettingsFromEnv } from "./settings-env.ts";

// 設定の読み取り（mailSettingsFromEnv）のうち、受付通知と管理者への通知のために足す2つの環境変数の単体テスト。
// 根拠：docs/design-docs/notifications.md「設定」（MAIL_ADMIN_TO・ADMIN_APP_URL を MailSettings に足し、server.ts と
// lambda.ts が環境変数から読む）、docs/product-specs/mail.md「管理者への新しい申込の通知」（設定がなければ、
// 管理者への通知を送らない・リンクの代わりに案内の文を書く）。
// - MailSettings の項目は adminNotificationTo（MAIL_ADMIN_TO）と adminAppUrl（ADMIN_APP_URL）
// - 今までの2つ（MAIL_STAFF_NAME・MAIL_SIGNATURE）の読み取りは、ここでは確かめない
// - 空の文字列・前後の空白の扱いは資料にないので確かめない
// - 架空の値を使う

const adminTo = "kaku.settings.admin@example.com";
const adminAppUrl = "http://localhost:5174/";

describe("設定の読み取り：MAIL_ADMIN_TO・ADMIN_APP_URL（notifications.md「設定」）", () => {
  it("MAIL_ADMIN_TO と ADMIN_APP_URL がある：adminNotificationTo と adminAppUrl に、その値が入る", () => {
    const settings = mailSettingsFromEnv({ MAIL_ADMIN_TO: adminTo, ADMIN_APP_URL: adminAppUrl });

    expect(settings.adminNotificationTo).toBe(adminTo);
    expect(settings.adminAppUrl).toBe(adminAppUrl);
  });

  it("MAIL_ADMIN_TO だけがある：adminNotificationTo に値が入り、adminAppUrl はない", () => {
    const settings = mailSettingsFromEnv({ MAIL_ADMIN_TO: adminTo });

    expect(settings.adminNotificationTo).toBe(adminTo);
    expect(settings.adminAppUrl).toBeUndefined();
  });

  it("ADMIN_APP_URL だけがある：adminAppUrl に値が入り、adminNotificationTo はない", () => {
    const settings = mailSettingsFromEnv({ ADMIN_APP_URL: adminAppUrl });

    expect(settings.adminAppUrl).toBe(adminAppUrl);
    expect(settings.adminNotificationTo).toBeUndefined();
  });

  it("どちらもない：adminNotificationTo も adminAppUrl もない", () => {
    const settings = mailSettingsFromEnv({});

    expect(settings.adminNotificationTo).toBeUndefined();
    expect(settings.adminAppUrl).toBeUndefined();
  });

  it("ほかの設定（MAIL_STAFF_NAME・MAIL_SIGNATURE）と一緒にあっても、2つの値はそのまま入る", () => {
    const settings = mailSettingsFromEnv({
      MAIL_STAFF_NAME: "架空 設定担当",
      MAIL_SIGNATURE: "スタジオ（架空の設定の署名）\\nTEL 090-0000-0404",
      MAIL_ADMIN_TO: adminTo,
      ADMIN_APP_URL: adminAppUrl,
    });

    expect(settings.adminNotificationTo).toBe(adminTo);
    expect(settings.adminAppUrl).toBe(adminAppUrl);
  });
});
