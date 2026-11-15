// クリップボードへのコピー。下書きの本文は、Gmail に貼ると色と下線が残るように、
// HTML（text/html）とテキスト（text/plain）の両方を1つの ClipboardItem にして入れる（mail.md「下書きの送り方」）。
// ブラウザの部品（navigator.clipboard、ClipboardItem）は引数で受け取る（テストではモックを渡す。api.ts の fetch と同じ）。
// コピーする中身（文面・あて先）はお客様の情報を含むので、失敗してもログ（console）に出さない（INV-10）

/**
 * ブラウザのクリップボードの部品のうち、使うもの。Item はブラウザでは ClipboardItem（テストでは中身を取り出せる偽物）。
 * どれもない環境がある（http の別のホスト、古いブラウザなど）
 */
export interface ClipboardEnv<Item> {
  clipboard?:
    | {
        write?: ((items: Item[]) => Promise<void>) | undefined;
        writeText?: ((text: string) => Promise<void>) | undefined;
      }
    | undefined;
  ClipboardItem?: (new (items: Record<string, Blob>) => Item) | undefined;
}

/**
 * 本文をコピーした結果
 * - rich：HTML とテキストの両方を入れた（Gmail に貼ると色と下線が残る）
 * - text-only：HTML を入れられず、テキストだけを入れた（色と下線は残らない）
 * - failed：何も入れられなかった
 */
export type RichCopyResult = "rich" | "text-only" | "failed";

export interface Copier {
  /** HTML とテキストの両方を入れる。使えなければテキストだけを入れる */
  copyRich(content: { html: string; text: string }): Promise<RichCopyResult>;
  /** テキストだけを入れる。入れられたら true */
  copyText(text: string): Promise<boolean>;
}

export function createCopier<Item>(env: ClipboardEnv<Item>): Copier {
  const { clipboard, ClipboardItem: MakeItem } = env;

  const copyText = async (text: string): Promise<boolean> => {
    if (clipboard?.writeText === undefined) return false;
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // 許可がない、ページにフォーカスがない、など。中身はログに出さない（INV-10）
      return false;
    }
  };

  return {
    async copyRich({ html, text }) {
      if (clipboard?.write !== undefined && MakeItem !== undefined) {
        try {
          await clipboard.write([
            new MakeItem({
              "text/html": new Blob([html], { type: "text/html" }),
              "text/plain": new Blob([text], { type: "text/plain" }),
            }),
          ]);
          return "rich";
        } catch {
          // HTML を入れられない環境（text/html を受け付けない、など）。テキストだけを試す
        }
      }
      return (await copyText(text)) ? "text-only" : "failed";
    },
    copyText,
  };
}
