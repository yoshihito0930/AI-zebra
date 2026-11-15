import { AdminReservationList } from "@zebra/contracts";
import { describe, expect, it } from "vitest";
import { loadList, type ListFilter } from "./list.ts";
import { fakeApi, listResponse } from "./test-support.ts";

const period = { from: "2026-11-01", to: "2026-11-30" };
const filter = (overrides: Partial<ListFilter>): ListFilter => ({
  ...period,
  status: "all",
  ignorePeriod: false,
  ...overrides,
});

describe("一覧の絞り込み", () => {
  it("すべて：期間だけを渡し、予約とブロック枠を返す", async () => {
    const { api, calls } = fakeApi(() => ({ status: 200, body: listResponse() }));
    const result = await loadList(api, filter({ ignorePeriod: true }));
    expect(calls.map((c) => c.url)).toEqual(["/admin/reservations?from=2026-11-01&to=2026-11-30"]);
    expect(result).toEqual({ ok: true, value: listResponse() });
  });

  it("1つの状態：期間と状態を渡す", async () => {
    const { api, calls } = fakeApi(() => ({ status: 200, body: { reservations: [], blocks: [] } }));
    await loadList(api, filter({ status: "second-hold" }));
    expect(calls.map((c) => c.url)).toEqual([
      "/admin/reservations?from=2026-11-01&to=2026-11-30&status=second-hold",
    ]);
  });

  it("1つの状態で期間によらない：状態だけを渡す", async () => {
    const { api, calls } = fakeApi(() => ({ status: 200, body: { reservations: [], blocks: [] } }));
    await loadList(api, filter({ status: "firm", ignorePeriod: true }));
    expect(calls.map((c) => c.url)).toEqual(["/admin/reservations?status=firm"]);
  });

  it("承認待ち：期間の一覧を承認待ちの予約だけにし、ブロック枠は出さない", async () => {
    const { api } = fakeApi(() => ({ status: 200, body: listResponse() }));
    const result = await loadList(api, filter({ status: "pending" }));
    expect(result.ok && result.value.reservations.map((r) => r.id)).toEqual(["res-pending-1"]);
    expect(result.ok && result.value.blocks).toEqual([]);
  });

  it("承認待ちで期間によらない：3つの承認待ちの状態をそれぞれ読み、開始の早い順に合わせる", async () => {
    const reservation = (id: string, status: string, start: string) => ({
      id,
      status,
      start,
      end: start.replace("T10", "T12"),
      bufferMinutes: 60,
      route: "form",
      partySize: 1,
      estimateIncludingTax: 5_500,
      customerName: "架空 一郎",
    });
    const byStatus: Record<string, unknown[]> = {
      "pending-provisional": [reservation("p", "pending-provisional", "2026-12-03T10:00:00+09:00")],
      "pending-firm": [reservation("f", "pending-firm", "2026-11-28T10:00:00+09:00")],
      "pending-second-hold": [reservation("s", "pending-second-hold", "2027-01-10T10:00:00+09:00")],
    };
    const { api, calls } = fakeApi(({ url }) => {
      const status = new URL(url, "http://localhost").searchParams.get("status") ?? "";
      return {
        status: 200,
        body: AdminReservationList.parse({ reservations: byStatus[status], blocks: [] }),
      };
    });
    const result = await loadList(api, filter({ status: "pending", ignorePeriod: true }));
    expect(calls.map((c) => c.url).sort()).toEqual([
      "/admin/reservations?status=pending-firm",
      "/admin/reservations?status=pending-provisional",
      "/admin/reservations?status=pending-second-hold",
    ]);
    expect(result.ok && result.value.reservations.map((r) => r.id)).toEqual(["f", "p", "s"]);
  });

  it("どれか1つが失敗したら、その失敗を返す", async () => {
    const { api } = fakeApi(({ url }) =>
      url.includes("pending-firm")
        ? { status: 503, body: { error: "busy" } }
        : { status: 200, body: { reservations: [], blocks: [] } },
    );
    expect(await loadList(api, filter({ status: "pending", ignorePeriod: true }))).toEqual({
      ok: false,
      failure: { kind: "rejected", status: 503, error: "busy" },
    });
  });
});
