import { Yen } from "@zebra/contracts";
import { describe, expect, it, vi } from "vitest";
import { createAdminApi } from "./api.ts";
import { accepted, detailResponse, fakeApi, listResponse } from "./test-support.ts";

describe("管理 API の呼び出し", () => {
  it("一覧：期間と状態をクエリで渡し、返事を契約でパースして返す", async () => {
    const { api, calls } = fakeApi(() => ({ status: 200, body: listResponse() }));
    const result = await api.listReservations({
      from: "2026-11-01",
      to: "2026-11-30",
      status: "firm",
    });
    expect(calls).toEqual([
      {
        method: "GET",
        url: "/admin/reservations?from=2026-11-01&to=2026-11-30&status=firm",
        body: undefined,
      },
    ]);
    expect(result).toEqual({ ok: true, value: listResponse() });
  });

  it("一覧：契約の形でないクエリは送らない", async () => {
    const { api, calls } = fakeApi(() => ({ status: 200, body: listResponse() }));
    await expect(api.listReservations({ from: "2026-11-01" })).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("詳細：id をパスに入れて読む", async () => {
    const { api, calls } = fakeApi(() => ({ status: 200, body: detailResponse() }));
    const result = await api.getReservation("res/1");
    expect(calls[0]?.url).toBe("/admin/reservations/res%2F1");
    expect(result.ok).toBe(true);
  });

  it("返事が契約の形でなければ、使わずに「思わぬ返事」にする（INV-4）", async () => {
    const { api } = fakeApi(() => ({
      status: 200,
      body: { ...detailResponse(), extra: "余計なキー" },
    }));
    expect(await api.getReservation("res-pending-1")).toEqual({
      ok: false,
      failure: { kind: "unexpected", status: 200 },
    });
  });

  it("エラーの返事は、理由（と警告）を取り出す", async () => {
    const { api } = fakeApi(() => ({ status: 409, body: { error: "not-pending" } }));
    expect(await api.operate("res-1", "reject")).toEqual({
      ok: false,
      failure: { kind: "rejected", status: 409, error: "not-pending" },
    });
  });

  it("本文が JSON でないエラー（中継先の API が起動していない、など）は「思わぬ返事」にする", async () => {
    const fetchFn = vi.fn(async () => new Response("Internal Server Error", { status: 500 }));
    const api = createAdminApi(fetchFn);
    expect(await api.getReservation("res-1")).toEqual({
      ok: false,
      failure: { kind: "unexpected", status: 500 },
    });
  });

  it("API に届かなければ「接続できない」にする", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const api = createAdminApi(fetchFn);
    expect(await api.lookupReceipt("ABCD2345")).toEqual({
      ok: false,
      failure: { kind: "network" },
    });
  });

  it("承認：確定金額を本文にして POST する", async () => {
    const drafts = accepted([
      { kind: "approval", reservationId: "res-1", confirmedPrice: Yen.parse(12_100) },
    ]);
    const { api, calls } = fakeApi(() => ({ status: 200, body: drafts }));
    const result = await api.approve("res-1", Yen.parse(12_100));
    expect(calls).toEqual([
      {
        method: "POST",
        url: "/admin/reservations/res-1/approve",
        body: { confirmedPrice: 12_100 },
      },
    ]);
    expect(result).toEqual({ ok: true, value: drafts });
  });

  it("却下・昇格・取消・繰り上げ：空の本文で、それぞれのルートに POST する", async () => {
    const { api, calls } = fakeApi(() => ({ status: 200, body: accepted([]) }));
    for (const operation of ["reject", "promote", "cancel", "move-up"] as const) {
      await api.operate("res-1", operation);
    }
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ["POST", "/admin/reservations/res-1/reject", {}],
      ["POST", "/admin/reservations/res-1/promote", {}],
      ["POST", "/admin/reservations/res-1/cancel", {}],
      ["POST", "/admin/reservations/res-1/move-up", {}],
    ]);
  });

  it("受付番号から探す：受付番号をパスに入れ、予約の id を返す", async () => {
    const { api, calls } = fakeApi(() => ({ status: 200, body: { reservationId: "res-1" } }));
    expect(await api.lookupReceipt("ABCD2345")).toEqual({
      ok: true,
      value: { reservationId: "res-1" },
    });
    expect(calls[0]?.url).toBe("/admin/receipts/ABCD2345");
  });
});
