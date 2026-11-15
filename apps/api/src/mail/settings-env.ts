// 担当者名と署名の設定を、環境変数から読む（docs/design-docs/admin-api.md「担当者名と署名の設定」）。
// server.ts と lambda.ts が使い、createApp の3つ目の引数に渡す。
// - MAIL_STAFF_NAME：担当者名
// - MAIL_SIGNATURE：署名。改行は \n（バックスラッシュと n の2文字）と書く
import type { MailSettings } from "./settings.ts";

export function mailSettingsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): MailSettings {
  void env;
  throw new Error("未実装");
}
