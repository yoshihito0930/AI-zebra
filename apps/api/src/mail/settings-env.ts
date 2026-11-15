// 担当者名と署名の設定を、環境変数から読む（docs/design-docs/admin-api.md「担当者名と署名の設定」）。
// server.ts と lambda.ts が使い、createApp の3つ目の引数に渡す。
// - MAIL_STAFF_NAME：担当者名
// - MAIL_SIGNATURE：署名。改行は \n（バックスラッシュと n の2文字）と書く
// 値はログに出さない（担当者の名前や電話番号が入るため。INV-10 の考え方）
import type { MailSettings } from "./settings.ts";

export function mailSettingsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): MailSettings {
  const staffName = nonEmpty(env["MAIL_STAFF_NAME"]);
  const signatureRaw = nonEmpty(env["MAIL_SIGNATURE"]);
  // 環境変数には改行を書きにくいので、\n の2文字を改行に直す
  const signature = signatureRaw?.replaceAll("\\n", "\n");
  return {
    ...(staffName === undefined ? {} : { staffName }),
    ...(signature === undefined ? {} : { signature }),
  };
}

/** ない・空（空白だけを含む）なら undefined。設定がないときと同じに扱う（mail.md「差し込む値」） */
function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}
