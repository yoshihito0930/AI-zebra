// 操作（承認・取消・変更など）の返事の下書きを、開ける下書き（下書きの id）に当てる。
// 操作の返事（AdminOperationAccepted）の下書きは id を持たないので、あて先の予約の下書きの一覧
// （GET /admin/reservations/{id}/drafts。作った順）から、同じ種類のいちばん新しい未送信の下書きを選ぶ
import type { AdminOperationAccepted, AdminReservationDraftList } from "@zebra/contracts";
import type { AdminApi } from "./api.ts";

type OperationDraft = AdminOperationAccepted["drafts"][number];
type ReservationDraft = AdminReservationDraftList["drafts"][number];

/**
 * 操作の返事の下書きごとに、下書きの id（当てられなければ undefined）。
 * 1つの操作が、同じ予約に同じ種類の下書きを2つ以上作ったときは、未送信の同じ種類の下書きの新しいほうから、
 * 返事の並び（作った順）のとおりに当てる。足りなければ、古いほう（返事の前のほう）を当てずにおく
 */
export function matchOperationDrafts(
  drafts: readonly OperationDraft[],
  listOf: (reservationId: string) => readonly ReservationDraft[] | undefined,
): (string | undefined)[] {
  const groupKey = (d: { reservationId: string; kind: string }) => `${d.reservationId} ${d.kind}`;
  const neededCount = new Map<string, number>();
  for (const draft of drafts) {
    neededCount.set(groupKey(draft), (neededCount.get(groupKey(draft)) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return drafts.map((draft) => {
    const key = groupKey(draft);
    const index = seen.get(key) ?? 0;
    seen.set(key, index + 1);
    const candidates = (listOf(draft.reservationId) ?? []).filter(
      (d) => d.kind === draft.kind && d.status === "unsent",
    );
    const offset = candidates.length - (neededCount.get(key) ?? 0);
    return candidates[offset + index]?.draftId;
  });
}

/** あて先の予約ごとに下書きの一覧を読み、操作の返事の下書きに id を当てる。読めなかった予約の下書きは undefined */
export async function findOperationDraftIds(
  api: AdminApi,
  drafts: readonly OperationDraft[],
): Promise<(string | undefined)[]> {
  const reservationIds = [...new Set(drafts.map((d) => d.reservationId))];
  const lists = new Map<string, readonly ReservationDraft[]>();
  await Promise.all(
    reservationIds.map(async (id) => {
      const result = await api.listReservationDrafts(id);
      if (result.ok) lists.set(id, result.value.drafts);
    }),
  );
  return matchOperationDrafts(drafts, (id) => lists.get(id));
}
