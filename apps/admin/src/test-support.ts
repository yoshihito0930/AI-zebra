// テストで使う、API の返事の例とモックの fetch。氏名・連絡先は架空のもの（公開リポジトリのため）
import {
  AdminReservationDetail,
  AdminReservationList,
  type AdminOperationAccepted,
} from "@zebra/contracts";
import { vi } from "vitest";
import { createAdminApi, type AdminApi } from "./api.ts";

export const listResponse = (): AdminReservationList =>
  AdminReservationList.parse({
    reservations: [
      {
        id: "res-firm-1",
        receiptNumber: "ABCD2345",
        status: "firm",
        start: "2026-11-20T13:00:00.000+09:00",
        end: "2026-11-20T15:00:00.000+09:00",
        bufferMinutes: 60,
        route: "form",
        partySize: 3,
        estimateIncludingTax: 11_000,
        confirmedPrice: 11_000,
        customerName: "架空 太郎",
      },
      {
        id: "res-pending-1",
        receiptNumber: "EFGH6789",
        status: "pending-provisional",
        start: "2026-11-05T10:00:00.000+09:00",
        end: "2026-11-05T12:00:00.000+09:00",
        bufferMinutes: 60,
        route: "form",
        partySize: 2,
        estimateIncludingTax: 12_100,
        customerName: "架空 花子",
      },
    ],
    blocks: [
      {
        id: "block-1",
        start: "2026-11-10T09:00:00.000+09:00",
        end: "2026-11-10T18:00:00.000+09:00",
        bufferMinutes: 0,
        route: "admin",
        memo: "設備点検",
      },
    ],
  });

type Detail = AdminReservationDetail;

/** 承認待ち（仮）の詳細。overrides で状態などを差し替える */
export const detailResponse = (
  overrides: { [K in keyof Detail]?: Detail[K] | undefined } = {},
): Detail =>
  AdminReservationDetail.parse({
    id: "res-pending-1",
    receiptNumber: "EFGH6789",
    status: "pending-provisional",
    start: "2026-11-05T10:00:00.000+09:00",
    end: "2026-11-05T12:00:00.000+09:00",
    bufferMinutes: 60,
    route: "form",
    partySize: 2,
    cycloramaFloorProtection: false,
    planId: "A",
    equipmentInsurance: true,
    optionIds: ["glitter"],
    estimate: { subtotalExcludingTax: 11_000, estimateIncludingTax: 12_100 },
    createdAt: "2026-10-30T09:15:00.000+09:00",
    updatedAt: "2026-10-30T09:15:00.000+09:00",
    customer: {
      name: "架空 花子",
      companyName: "架空スタジオ株式会社",
      email: "hanako@example.com",
      phone: "090-0000-0000",
    },
    shooting: { types: ["still", "movie"], details: "商品撮影" },
    history: [
      {
        at: "2026-10-30T09:15:00.000+09:00",
        actor: { kind: "customer" },
        operation: "apply",
        after: {
          status: "pending-provisional",
          start: "2026-11-05T10:00:00.000+09:00",
          end: "2026-11-05T12:00:00.000+09:00",
          bufferMinutes: 60,
        },
      },
    ],
    currentEstimate: { subtotalExcludingTax: 11_000, estimateIncludingTax: 12_100 },
    ...overrides,
  });

export interface FakeResponse {
  status: number;
  body?: unknown;
}

/**
 * モックの fetch。handler が「メソッド パス」（例：GET /admin/reservations?from=…）ごとに返事を決める。
 * 呼ばれた URL と本文は calls で確かめる
 */
export function fakeApi(
  handler: (request: { method: string; url: string; body: unknown }) => FakeResponse,
) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const request = { method, url, body };
    calls.push(request);
    const response = handler(request);
    return new Response(response.body === undefined ? null : JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  });
  const api: AdminApi = createAdminApi(fetchFn);
  return { api, calls, fetchFn };
}

export const accepted = (drafts: AdminOperationAccepted["drafts"]): AdminOperationAccepted => ({
  drafts,
});
