// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.tsx";
import { detailResponse, fakeApi, listResponse, type FakeResponse } from "./test-support.ts";

// 今は 2026-11-15（JST）。一覧の期間の初期値は 2026-11-01〜2026-11-30
const now = () => DateTime.fromISO("2026-11-15T10:00:00+09:00");

const renderApp = (handler: Parameters<typeof fakeApi>[0]) => {
  const fake = fakeApi(handler);
  render(<App api={fake.api} now={now} />);
  return fake;
};

const okList = (): FakeResponse => ({ status: 200, body: listResponse() });

beforeEach(() => {
  window.location.hash = "";
});
afterEach(() => {
  cleanup();
});

describe("画面の枠", () => {
  it("手元の開発用（ログインなし）であることを出す", async () => {
    renderApp(okList);
    expect(screen.getByText("手元の開発用（ログインなし）")).toBeTruthy();
    await screen.findByText("架空 太郎");
  });
});

describe("予約の一覧", () => {
  it("初めは今月（JST）の期間で読み、予約とブロック枠を開始の早い順に表にする", async () => {
    const { calls } = renderApp(okList);
    await screen.findByText("架空 太郎");
    expect(calls[0]?.url).toBe("/admin/reservations?from=2026-11-01&to=2026-11-30");

    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("2026/11/05(木) 10:00〜12:00承認待ち（仮）架空 花子2人12,100円未定"),
      expect.stringContaining("2026/11/10(火) 09:00〜18:00ブロック枠設備点検"),
      expect.stringContaining("2026/11/20(金) 13:00〜15:00本予約架空 太郎3人11,000円11,000円"),
    ]);
    expect(screen.getByText("予約 2件・ブロック枠 1件")).toBeTruthy();
  });

  it("予約の行から詳細へ移る", async () => {
    renderApp(({ url }) =>
      url.startsWith("/admin/reservations/") ? { status: 200, body: detailResponse() } : okList(),
    );
    const link = await screen.findByRole("link", { name: "2026/11/05(木) 10:00〜12:00" });
    expect(link.getAttribute("href")).toBe("#/reservations/res-pending-1");

    fireEvent.click(link.closest("tr") as HTMLElement);
    expect(window.location.hash).toBe("#/reservations/res-pending-1");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(await screen.findByRole("heading", { name: "予約の詳細" })).toBeTruthy();
  });

  it("期間と状態を選んで読み直す", async () => {
    const { calls } = renderApp(() => ({ status: 200, body: { reservations: [], blocks: [] } }));
    await screen.findByText("該当する予約・ブロック枠はありません。");

    fireEvent.change(screen.getByLabelText("期間の初日"), { target: { value: "2026-12-01" } });
    fireEvent.change(screen.getByLabelText("期間の末日"), { target: { value: "2026-12-31" } });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "provisional" } });
    fireEvent.click(screen.getByRole("button", { name: "表示" }));

    await screen.findByText("該当する予約・ブロック枠はありません。");
    expect(calls.at(-1)?.url).toBe(
      "/admin/reservations?from=2026-12-01&to=2026-12-31&status=provisional",
    );
  });

  it("「承認待ちをすべて見る」で、期間によらず承認待ちの3つの状態を読む", async () => {
    const { calls } = renderApp(() => ({ status: 200, body: { reservations: [], blocks: [] } }));
    await screen.findByText("該当する予約・ブロック枠はありません。");

    fireEvent.click(screen.getByRole("button", { name: "承認待ちをすべて見る" }));
    await screen.findByText("該当する予約・ブロック枠はありません。");
    expect(
      calls
        .slice(1)
        .map((c) => c.url)
        .sort(),
    ).toEqual([
      "/admin/reservations?status=pending-firm",
      "/admin/reservations?status=pending-provisional",
      "/admin/reservations?status=pending-second-hold",
    ]);
  });

  it("読めなかったときは、理由を日本語で出す", async () => {
    renderApp(() => ({ status: 400, body: { error: "invalid-input" } }));
    expect((await screen.findByRole("alert")).textContent).toBe("入力の形が正しくありません。");
  });
});

describe("受付番号から探す", () => {
  it("見つかったら、その予約の詳細を開く（小文字で入れても大文字にそろえる）", async () => {
    const { calls } = renderApp(({ url }) =>
      url.startsWith("/admin/receipts/")
        ? { status: 200, body: { reservationId: "res-pending-1" } }
        : okList(),
    );
    await screen.findByText("架空 太郎");
    fireEvent.change(screen.getByLabelText("受付番号"), { target: { value: "efgh6789" } });
    fireEvent.click(screen.getByRole("button", { name: "開く" }));

    await vi.waitFor(() => expect(window.location.hash).toBe("#/reservations/res-pending-1"));
    expect(calls.map((c) => c.url)).toContain("/admin/receipts/EFGH6789");
    expect(await screen.findByRole("heading", { name: "予約の詳細" })).toBeTruthy();
  });

  it("ない受付番号は「ありません」と出す", async () => {
    renderApp(({ url }) =>
      url.startsWith("/admin/receipts/") ? { status: 404, body: { error: "not-found" } } : okList(),
    );
    await screen.findByText("架空 太郎");
    fireEvent.change(screen.getByLabelText("受付番号"), { target: { value: "ZZZZ2222" } });
    fireEvent.click(screen.getByRole("button", { name: "開く" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "その受付番号の予約はありません。",
    );
  });

  it("受付番号の形でなければ、API を呼ばずに形を知らせる", async () => {
    const { calls } = renderApp(okList);
    await screen.findByText("架空 太郎");
    fireEvent.change(screen.getByLabelText("受付番号"), { target: { value: "ABC-0001" } });
    fireEvent.click(screen.getByRole("button", { name: "開く" }));
    expect((await screen.findByRole("alert")).textContent).toContain("受付番号は8文字の英数字です");
    expect(calls.filter((c) => c.url.startsWith("/admin/receipts/"))).toEqual([]);
  });
});
