// 一覧の絞り込みと、管理 API の一覧（GET /admin/reservations）の呼び分け
import type { AdminReservationList, HoldingReservationStatus } from "@zebra/contracts";
import type { AdminApi, ApiResult } from "./api.ts";
import { compareByTime } from "./format.ts";

/** 状態の絞り込み。pending は承認待ちの3つ（仮・本・第二キープ）をまとめたもの */
export type StatusFilter = "all" | "pending" | HoldingReservationStatus;

export interface ListFilter {
  /** 期間（JST の日付 YYYY-MM-DD。両端を含む） */
  from: string;
  to: string;
  status: StatusFilter;
  /** 期間によらず、状態だけで探す（状態を選んだときだけ効く） */
  ignorePeriod: boolean;
}

export const PENDING_STATUSES = [
  "pending-provisional",
  "pending-firm",
  "pending-second-hold",
] as const satisfies readonly HoldingReservationStatus[];

const isPending = (status: HoldingReservationStatus): boolean =>
  (PENDING_STATUSES as readonly string[]).includes(status);

/**
 * 絞り込みに合う一覧を読む。状態で絞ったときは、ブロック枠は出さない（API も状態を渡すとブロック枠を返さない）
 * - すべて：期間の予約とブロック枠
 * - 1つの状態：期間と状態（期間によらないなら状態だけ）を API に渡す
 * - 承認待ち：期間の一覧を承認待ちで絞る。期間によらないなら、承認待ちの3つの状態をそれぞれ読んで合わせる
 */
export async function loadList(
  api: AdminApi,
  filter: ListFilter,
): Promise<ApiResult<AdminReservationList>> {
  const period = { from: filter.from, to: filter.to };

  if (filter.status === "all") return api.listReservations(period);

  if (filter.status !== "pending") {
    return api.listReservations(
      filter.ignorePeriod ? { status: filter.status } : { ...period, status: filter.status },
    );
  }

  if (!filter.ignorePeriod) {
    const result = await api.listReservations(period);
    if (!result.ok) return result;
    return {
      ok: true,
      value: {
        reservations: result.value.reservations.filter((r) => isPending(r.status)),
        blocks: [],
      },
    };
  }

  const results = await Promise.all(
    PENDING_STATUSES.map((status) => api.listReservations({ status })),
  );
  const reservations: AdminReservationList["reservations"] = [];
  for (const result of results) {
    if (!result.ok) return result;
    reservations.push(...result.value.reservations);
  }
  return { ok: true, value: { reservations: reservations.sort(compareByTime), blocks: [] } };
}
