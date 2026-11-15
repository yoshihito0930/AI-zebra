// テストで使う、API の返事の例とモックの fetch。氏名・連絡先は架空のもの（公開リポジトリのため）
import {
  AdminDraftDetail,
  AdminReservationDetail,
  AdminReservationDraftList,
  AdminReservationList,
  AdminUnsentDraftList,
  type AdminOperationAccepted,
} from "@zebra/contracts";
import { vi } from "vitest";
import { createAdminApi, type AdminApi } from "./api.ts";
import { createCopier } from "./clipboard.ts";

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

/** 未送信の下書きの一覧（作った順） */
export const unsentDraftsResponse = (): AdminUnsentDraftList =>
  AdminUnsentDraftList.parse({
    drafts: [
      {
        draftId: "20261030T001500000Z-0001",
        reservationId: "res-pending-1",
        kind: "approval",
        createdAt: "2026-10-30T09:15:00.000+09:00",
        reservationStart: "2026-11-05T10:00:00.000+09:00",
        customerName: "架空 花子",
      },
      {
        draftId: "20261101T030000000Z-0001",
        reservationId: "res-firm-1",
        kind: "cancellation",
        createdAt: "2026-11-01T12:00:00.000+09:00",
        reservationStart: "2026-11-20T13:00:00.000+09:00",
        customerName: "架空 太郎",
      },
    ],
  });

/** 予約の下書きの一覧（送信済み・送らないも含め、作った順） */
export const reservationDraftsResponse = (): AdminReservationDraftList =>
  AdminReservationDraftList.parse({
    drafts: [
      {
        draftId: "20261030T001500000Z-0001",
        kind: "approval",
        status: "sent",
        createdAt: "2026-10-30T09:15:00.000+09:00",
        statusChangedAt: "2026-10-30T10:00:00.000+09:00",
      },
      {
        draftId: "20261031T020000000Z-0001",
        kind: "change",
        status: "skipped",
        createdAt: "2026-10-31T11:00:00.000+09:00",
        statusChangedAt: "2026-10-31T11:30:00.000+09:00",
      },
      {
        draftId: "20261101T030000000Z-0001",
        kind: "change",
        status: "unsent",
        createdAt: "2026-11-01T12:00:00.000+09:00",
      },
    ],
  });

type DraftDetail = AdminDraftDetail;

/** 開いた下書き（仮予約の承認）。overrides で状態などを差し替える。本文の HTML は API と同じ形（差し込む値はエスケープ済み） */
export const draftDetailResponse = (
  overrides: { [K in keyof DraftDetail]?: DraftDetail[K] | undefined } = {},
): DraftDetail =>
  AdminDraftDetail.parse({
    draftId: "20261030T001500000Z-0001",
    reservationId: "res-pending-1",
    kind: "approval",
    status: "unsent",
    createdAt: "2026-10-30T09:15:00.000+09:00",
    to: "hanako@example.com",
    subject: "2026年11月5日(木) 10時00分〜12時00分の仮予約を承りました（スタジオゼブラ）",
    text: "架空 花子様\n\n撮影当日に履いていらっしゃった靴のご使用は禁止です。\nデニム等の色落ちするボトム\nブーツなど\n撮影詳細：A&B <商品>",
    html:
      "架空 花子様<br><br>" +
      '<span style="color:#ff0000">撮影当日に履いていらっしゃった靴のご使用は禁止です。</span><br>' +
      '<span style="color:#0000ff">デニム等の色落ちするボトム</span><br>' +
      '<span style="text-decoration:underline">ブーツなど</span><br>' +
      "撮影詳細：A&amp;B &lt;商品&gt;",
    attachConsentForm: false,
    ...overrides,
  });

/** モックの ClipboardItem。入れた中身（種類ごとの Blob）を取り出せる */
export class FakeClipboardItem {
  constructor(readonly items: Record<string, Blob>) {}
}

/**
 * モックのクリップボード。mode で環境を選ぶ
 * - rich：ClipboardItem と write・writeText が使える
 * - no-clipboard-item：ClipboardItem がない（writeText だけ）
 * - write-rejects：write が失敗する（text/html を受け付けない、など）
 * - none：クリップボードがない
 */
export function fakeClipboard(
  mode: "rich" | "no-clipboard-item" | "write-rejects" | "none" = "rich",
) {
  const write = vi.fn(async (items: FakeClipboardItem[]) => {
    void items;
    if (mode === "write-rejects") throw new DOMException("書けない", "NotAllowedError");
  });
  const writeText = vi.fn(async (text: string) => {
    void text;
  });
  const copier = createCopier({
    clipboard: mode === "none" ? undefined : { write, writeText },
    ClipboardItem: mode === "no-clipboard-item" || mode === "none" ? undefined : FakeClipboardItem,
  });
  /** write で入れた中身：入れた ClipboardItem ごとに、種類（MIME）から [Blob の type, 中身の文字列] */
  const written = async () =>
    Promise.all(
      write.mock.calls
        .flatMap(([items]) => items)
        .map(async (item) =>
          Object.fromEntries(
            await Promise.all(
              Object.entries(item.items).map(
                async ([type, blob]) => [type, [blob.type, await blob.text()]] as const,
              ),
            ),
          ),
        ),
    );
  return { copier, write, writeText, written };
}
