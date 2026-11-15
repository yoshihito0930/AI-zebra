// テストで使うモックの fetch と、申込の例。氏名・連絡先は架空のもの（公開リポジトリのため）
import type { ApplicationRequest } from "@zebra/contracts";
import { vi } from "vitest";
import { createPublicApi } from "./api.ts";

export interface FakeResponse {
  status: number;
  body?: unknown;
}

export interface FakeRequest {
  method: string;
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

/**
 * モックの fetch。handler が呼ばれた URL・本文ごとに返事を決める（Promise を返すと、返事を待たせられる）。
 * 呼ばれた URL と本文は calls で確かめる
 */
export function fakeApi(handler: (request: FakeRequest) => FakeResponse | Promise<FakeResponse>) {
  const calls: FakeRequest[] = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const request = { method, url, body, headers };
    calls.push(request);
    const response = await handler(request);
    return new Response(response.body === undefined ? null : JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  });
  return { api: createPublicApi(fetchFn), calls, fetchFn };
}

/** 期間のすべての日を、予約なしで返す予約状況（bookings で日ごとの予約を足す） */
export function calendarBody(
  from: string,
  to: string,
  bookings: Record<string, { label: string; start: string; end: string }[]> = {},
) {
  const days: { date: string; bookings: unknown[] }[] = [];
  const [year, month] = from.split("-").map(Number) as [number, number];
  const lastDay = Number(to.slice(8));
  for (let day = Number(from.slice(8)); day <= lastDay; day++) {
    const date = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    days.push({ date, bookings: bookings[date] ?? [] });
  }
  return { days };
}

export const sampleApplication = (): ApplicationRequest => ({
  kind: "firm",
  start: "2026-11-25T10:00:00+09:00",
  end: "2026-11-25T12:00:00+09:00",
  partySize: 3,
  cycloramaFloorProtection: false,
  equipmentInsurance: false,
  optionIds: [],
  customer: {
    name: "架空 太郎",
    email: "taro@example.com",
    phone: "090-0000-0000",
    address: "東京都架空区1-2-3",
    photographerName: "架空 次郎",
  },
  shooting: { types: ["still"], details: "商品撮影" },
  agreedToCycloramaRules: true,
  agreedToTerms: true,
});
