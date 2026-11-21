// 予約ページの連絡先（src/components/StudioContacts.astro）に出す、スタジオの電話番号。
// 電話番号はリポジトリに書かず（このリポジトリは公開する）、組み立てのときの環境変数 PUBLIC_STUDIO_TEL で渡す。
// 本番の値は、AWS の準備のときに組み立ての設定に入れる。手元とテストでは架空の値（例：000-0000-0000）を使う

/** 電話番号の環境変数の名前 */
export const STUDIO_TEL = "PUBLIC_STUDIO_TEL";

export type StudioTel = {
  /** 画面に出す番号（渡した値のまま。例：000-0000-0000） */
  readonly label: string;
  /** tel: のリンク（数字と先頭の + だけにしたもの。例：tel:00000000000） */
  readonly href: string;
};

/**
 * 環境変数の値から、出す電話番号を決める。
 * - ない・空（空白だけを含む）：出さない（undefined）
 * - 数字・ハイフン・先頭の + だけ：出す
 * - それ以外：組み立てを止める（打ち間違いや、番号でないものを公開しないため）
 */
export function parseStudioTel(value: string | undefined): StudioTel | undefined {
  const label = value?.trim() ?? "";
  if (label === "") return undefined;
  if (!/^\+?[0-9][0-9-]*[0-9]$/.test(label)) {
    throw new Error(
      `${STUDIO_TEL} は数字とハイフン（先頭に + を付けてよい）で指定する（例：000-0000-0000）。今の値：${JSON.stringify(value)}`,
    );
  }
  return { label, href: `tel:${label.replaceAll("-", "")}` };
}
