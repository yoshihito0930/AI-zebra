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

  const content = {
    start: "2026-11-20T13:00:00.000+09:00",
    end: "2026-11-20T16:00:00.000+09:00",
    partySize: 3,
    cycloramaFloorProtection: false,
    equipmentInsurance: true,
    optionIds: ["workshop"],
    confirmedPrice: Yen.parse(18_700),
  };
  const customerInfo = {
    customer: { name: "架空 次郎", phone: "090-0000-0001" },
    shooting: { types: ["still" as const] },
  };

  it("予約の変更：本文（確認した警告を含む）を change に POST し、下書きの一覧を返す", async () => {
    const drafts = accepted([{ kind: "change", reservationId: "res-1" }]);
    const { api, calls } = fakeApi(() => ({ status: 200, body: drafts }));
    const result = await api.change("res-1", {
      ...content,
      acknowledgedWarnings: ["past-24-hours-before-start"],
    });
    expect(calls).toEqual([
      {
        method: "POST",
        url: "/admin/reservations/res-1/change",
        body: { ...content, acknowledgedWarnings: ["past-24-hours-before-start"] },
      },
    ]);
    expect(result).toEqual({ ok: true, value: drafts });
  });

  it("予約の変更：確認していない警告の 409 は、理由と今の警告の一覧を取り出す", async () => {
    const { api } = fakeApi(() => ({
      status: 409,
      body: {
        error: "unacknowledged-warnings",
        warnings: ["late-night-shorter-than-4-hours"],
      },
    }));
    expect(await api.change("res-1", content)).toEqual({
      ok: false,
      failure: {
        kind: "rejected",
        status: 409,
        error: "unacknowledged-warnings",
        warnings: ["late-night-shorter-than-4-hours"],
      },
    });
  });

  it("予約の変更：契約の形でない本文は送らない（INV-4）", async () => {
    const { api, calls } = fakeApi(() => ({ status: 200, body: accepted([]) }));
    await expect(api.change("res-1", { ...content, start: "2026-11-20 13:00" })).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("直接入力：本文を /admin/reservations に POST し、201 の予約の id を返す", async () => {
    const { api, calls } = fakeApi(() => ({ status: 201, body: { reservationId: "res-new" } }));
    const body = { kind: "firm" as const, ...content, ...customerInfo };
    expect(await api.directEntry(body)).toEqual({ ok: true, value: { reservationId: "res-new" } });
    expect(calls).toEqual([{ method: "POST", url: "/admin/reservations", body }]);
  });

  it("バッファの切り替え：分を本文にして buffer に POST する", async () => {
    const { api, calls } = fakeApi(() => ({ status: 200, body: accepted([]) }));
    expect(await api.changeBuffer("res-1", 30)).toEqual({ ok: true, value: accepted([]) });
    expect(calls).toEqual([
      { method: "POST", url: "/admin/reservations/res-1/buffer", body: { bufferMinutes: 30 } },
    ]);
  });

  it("お客様の情報の変更：全部の欄を customer に PUT する。成功は本文なしの 200", async () => {
    const { api, calls } = fakeApi(() => ({ status: 200 }));
    expect(await api.updateCustomer("res-1", customerInfo)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(calls).toEqual([
      { method: "PUT", url: "/admin/reservations/res-1/customer", body: customerInfo },
    ]);
  });

  it("本文なしのはずの返事に本文があれば「思わぬ返事」にする", async () => {
    const { api } = fakeApi(() => ({ status: 200, body: { unexpected: true } }));
    expect(await api.updateCustomer("res-1", customerInfo)).toEqual({
      ok: false,
      failure: { kind: "unexpected", status: 200 },
    });
  });

  it("ブロック枠：入れるは POST（201 とブロック枠の id）、直すは PUT、消すは DELETE（本文なし）", async () => {
    const block = {
      start: "2026-11-10T09:00:00.000+09:00",
      end: "2026-11-10T18:00:00.000+09:00",
      bufferMinutes: 30 as const,
      memo: "設備点検",
    };
    const { api, calls } = fakeApi(({ method }) =>
      method === "POST" ? { status: 201, body: { blockId: "block-new" } } : { status: 200 },
    );
    expect(await api.createBlock(block)).toEqual({ ok: true, value: { blockId: "block-new" } });
    expect(await api.updateBlock("block/1", block)).toEqual({ ok: true, value: undefined });
    expect(await api.deleteBlock("block/1")).toEqual({ ok: true, value: undefined });
    expect(calls).toEqual([
      { method: "POST", url: "/admin/blocks", body: block },
      { method: "PUT", url: "/admin/blocks/block%2F1", body: block },
      { method: "DELETE", url: "/admin/blocks/block%2F1", body: undefined },
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
