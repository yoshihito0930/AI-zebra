import { describe, expect, it } from "vitest";
import { createPublicApi } from "./api.ts";
import { calendarBody, fakeApi, sampleApplication } from "./test-support.ts";

describe("予約状況を読む（GET /public/calendar）", () => {
  it("期間を from・to のクエリで送り、返事を契約でパースする", async () => {
    const { api, calls } = fakeApi(() => ({
      status: 200,
      body: calendarBody("2026-11-01", "2026-11-30", {
        "2026-11-20": [
          {
            label: "provisional",
            start: "2026-11-20T09:00:00+09:00",
            end: "2026-11-20T12:00:00+09:00",
          },
        ],
      }),
    }));
    const result = await api.getCalendar({ from: "2026-11-01", to: "2026-11-30" });
    expect(calls).toEqual([
      expect.objectContaining({
        method: "GET",
        url: "/public/calendar?from=2026-11-01&to=2026-11-30",
      }),
    ]);
    expect(result.ok && result.value.days).toHaveLength(30);
    expect(result.ok && result.value.days[19]?.bookings).toEqual([
      {
        label: "provisional",
        start: "2026-11-20T09:00:00+09:00",
        end: "2026-11-20T12:00:00+09:00",
      },
    ]);
  });

  it("契約にない情報（id、承認待ちかどうか、金額）が混ざった返事は使わない（INV-3、INV-4）", async () => {
    const { api } = fakeApi(() => ({
      status: 200,
      body: {
        days: [
          {
            date: "2026-11-20",
            bookings: [
              {
                label: "provisional",
                start: "2026-11-20T09:00:00+09:00",
                end: "2026-11-20T12:00:00+09:00",
                id: "res-1",
                status: "pending-provisional",
                price: 11_000,
              },
            ],
          },
        ],
      },
    }));
    expect(await api.getCalendar({ from: "2026-11-20", to: "2026-11-20" })).toEqual({
      ok: false,
      failure: { kind: "unexpected", status: 200 },
    });
  });

  it("届かなければ network、形の違うエラーなら unexpected", async () => {
    const network = createPublicApi(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await network.getCalendar({ from: "2026-11-01", to: "2026-11-30" })).toEqual({
      ok: false,
      failure: { kind: "network" },
    });
    const { api } = fakeApi(() => ({ status: 500 }));
    expect(await api.getCalendar({ from: "2026-11-01", to: "2026-11-30" })).toEqual({
      ok: false,
      failure: { kind: "unexpected", status: 500 },
    });
  });

  it("baseUrl を前に付ける", async () => {
    const urls: string[] = [];
    const api = createPublicApi(async (url) => {
      urls.push(url);
      return new Response(JSON.stringify({ days: [] }), { status: 200 });
    }, "https://api.example.com");
    await api.getCalendar({ from: "2026-11-01", to: "2026-11-30" });
    expect(urls).toEqual(["https://api.example.com/public/calendar?from=2026-11-01&to=2026-11-30"]);
  });
});

describe("申込を送る（POST /public/applications）", () => {
  it("契約の形の本文を JSON で送り、受付番号と見積額をパースする", async () => {
    const { api, calls } = fakeApi(() => ({
      status: 201,
      body: { receiptNumber: "ABCD2345", estimateIncludingTax: 11_000 },
    }));
    const result = await api.apply(sampleApplication());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toBe("/public/applications");
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
    expect(calls[0]?.body).toEqual(sampleApplication());
    expect(result).toEqual({
      ok: true,
      value: { receiptNumber: "ABCD2345", estimateIncludingTax: 11_000 },
    });
  });

  it("断られたら理由（ApplicationRejection）を返す", async () => {
    const { api } = fakeApi(() => ({ status: 422, body: { error: "overlaps-existing" } }));
    expect(await api.apply(sampleApplication())).toEqual({
      ok: false,
      failure: { kind: "rejected", reason: "overlaps-existing" },
    });
  });

  it("契約にない理由や、受付の返事に余計なキーがあれば unexpected", async () => {
    const unknownReason = fakeApi(() => ({ status: 422, body: { error: "sold-out" } }));
    expect(await unknownReason.api.apply(sampleApplication())).toEqual({
      ok: false,
      failure: { kind: "unexpected", status: 422 },
    });
    const extraKey = fakeApi(() => ({
      status: 201,
      body: { receiptNumber: "ABCD2345", estimateIncludingTax: 11_000, id: "res-1" },
    }));
    expect(await extraKey.api.apply(sampleApplication())).toEqual({
      ok: false,
      failure: { kind: "unexpected", status: 201 },
    });
  });

  it("契約に合わない本文は送らない", async () => {
    const { api, calls } = fakeApi(() => ({ status: 201, body: {} }));
    await expect(api.apply({ ...sampleApplication(), partySize: 15 })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
