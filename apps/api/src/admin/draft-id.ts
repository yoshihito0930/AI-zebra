// 管理 API が返す下書きの id（draftId）と、下書きのアイテムの sk の行き来（admin-api.md「下書き（3回目）」：
// 下書きの id は API が決める文字列。管理画面は、一覧で受け取ったものをそのまま使う）。
// - sk は DRAFT#<作った日時（UTC の ISO 8601。例 2026-10-02T03:00:00.000Z）>#<連番>（dynamodb-keys.md）
// - draftId は、sk から「DRAFT#」と日時の区切り（- : .）を除き、「#」を「-」にしたもの（例 20261002T030000000Z-0001）。
//   数字と T・Z・- だけなので、URL のパスにそのまま入れられる。あて先の予約の id と合わせて下書きを決める（sk と同じ）
// - 形の合わない draftId は、どの下書きにもならない（API は 404）

const SK_PATTERN = /^DRAFT#(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z#(\d+)$/;
const DRAFT_ID_PATTERN = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-(\d+)$/;

/** 下書きのアイテムの sk から draftId へ。sk の形が合わなければ（操作の保存が書いた形でなければ）エラー */
export function draftIdOf(sk: string): string {
  const match = SK_PATTERN.exec(sk);
  if (match === null) throw new Error("下書きのアイテムの sk の形が不正");
  const [, year, month, day, hour, minute, second, millisecond, sequence] = match;
  return `${year}${month}${day}T${hour}${minute}${second}${millisecond}Z-${sequence}`;
}

/** draftId から下書きのアイテムの sk へ。形が合わなければ undefined */
export function skOfDraftId(draftId: string): string | undefined {
  const match = DRAFT_ID_PATTERN.exec(draftId);
  if (match === null) return undefined;
  const [, year, month, day, hour, minute, second, millisecond, sequence] = match;
  return `DRAFT#${year}-${month}-${day}T${hour}:${minute}:${second}.${millisecond}Z#${sequence}`;
}
