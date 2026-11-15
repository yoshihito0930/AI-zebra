// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReservationDraftList, UnsentDraftListPage } from "./DraftLists.tsx";
import { fakeApi, reservationDraftsResponse, unsentDraftsResponse } from "./test-support.ts";

beforeEach(() => {
  window.location.hash = "";
});
afterEach(() => {
  cleanup();
});

const rowsOf = (table: HTMLElement) =>
  within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.textContent);

describe("未送信の下書きの一覧", () => {
  it("/admin/drafts を読み、作った順に、作った日時・種類・お客様の氏名・予約の開始（JST）を出す", async () => {
    const fake = fakeApi(() => ({ status: 200, body: unsentDraftsResponse() }));
    render(<UnsentDraftListPage api={fake.api} />);
    const table = await screen.findByRole("table", { name: "未送信の下書き" });
    expect(fake.calls.map((c) => c.url)).toEqual(["/admin/drafts"]);
    expect(rowsOf(table)).toEqual([
      "2026/10/30(金) 09:15承認のお知らせ架空 花子2026/11/05(木) 10:00",
      "2026/11/01(日) 12:00取消のお知らせ架空 太郎2026/11/20(金) 13:00",
    ]);
    expect(screen.getByText("未送信 2件（作った順）")).toBeTruthy();
  });

  it("下書きの id が同じでも、あて先の予約が違えば別の行として出す（id は予約の中でだけ重ならない）", async () => {
    const [first] = unsentDraftsResponse().drafts;
    if (first === undefined) throw new Error("例がない");
    const second = { ...first, reservationId: "res-second-1", kind: "move-up-notice" as const };
    const fake = fakeApi(() => ({ status: 200, body: { drafts: [first, second] } }));
    const consoleError = vi.spyOn(console, "error");
    render(<UnsentDraftListPage api={fake.api} />);
    const table = await screen.findByRole("table", { name: "未送信の下書き" });
    expect(
      within(table)
        .getAllByRole("link")
        .map((a) => a.getAttribute("href")),
    ).toEqual([
      `#/reservations/res-pending-1/drafts/${first.draftId}`,
      `#/reservations/res-second-1/drafts/${first.draftId}`,
    ]);
    // React の「key が重なっている」の警告が出ない
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("行から下書きを開く", async () => {
    const fake = fakeApi(() => ({ status: 200, body: unsentDraftsResponse() }));
    render(<UnsentDraftListPage api={fake.api} />);
    const link = await screen.findByRole("link", { name: "取消のお知らせ" });
    expect(link.getAttribute("href")).toBe(
      "#/reservations/res-firm-1/drafts/20261101T030000000Z-0001",
    );
    fireEvent.click(screen.getByText("架空 太郎"));
    expect(window.location.hash).toBe("#/reservations/res-firm-1/drafts/20261101T030000000Z-0001");
  });

  it("未送信の下書きがなければ、そう出す。読めなければ理由を出す", async () => {
    const empty = fakeApi(() => ({ status: 200, body: { drafts: [] } }));
    render(<UnsentDraftListPage api={empty.api} />);
    await screen.findByText("未送信の下書きはありません。");
    cleanup();

    const failing = fakeApi(() => ({ status: 503, body: { error: "busy" } }));
    render(<UnsentDraftListPage api={failing.api} />);
    expect((await screen.findByRole("alert")).textContent).toContain("混み合っています");
  });
});

describe("予約の下書きの一覧", () => {
  it("送信済み・送らないも含め、作った順に、状態とその日時（JST）を出す", async () => {
    const fake = fakeApi(() => ({ status: 200, body: reservationDraftsResponse() }));
    render(<ReservationDraftList api={fake.api} reservationId="res-pending-1" refreshKey={0} />);
    const table = await screen.findByRole("table", { name: "この予約のメールの下書き" });
    expect(fake.calls.map((c) => c.url)).toEqual(["/admin/reservations/res-pending-1/drafts"]);
    expect(rowsOf(table)).toEqual([
      "2026/10/30(金) 09:15承認のお知らせ送信済み2026/10/30(金) 10:00",
      "2026/10/31(土) 11:00変更のお知らせ送らない2026/10/31(土) 11:30",
      "2026/11/01(日) 12:00変更のお知らせ未送信—",
    ]);
  });

  it("行から下書きを開く", async () => {
    const fake = fakeApi(() => ({ status: 200, body: reservationDraftsResponse() }));
    render(<ReservationDraftList api={fake.api} reservationId="res-pending-1" refreshKey={0} />);
    const links = await screen.findAllByRole("link", { name: "変更のお知らせ" });
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "#/reservations/res-pending-1/drafts/20261031T020000000Z-0001",
      "#/reservations/res-pending-1/drafts/20261101T030000000Z-0001",
    ]);
    fireEvent.click(screen.getByText("送信済み"));
    expect(window.location.hash).toBe(
      "#/reservations/res-pending-1/drafts/20261030T001500000Z-0001",
    );
  });

  it("下書きがなければ、そう出す", async () => {
    const fake = fakeApi(() => ({ status: 200, body: { drafts: [] } }));
    render(<ReservationDraftList api={fake.api} reservationId="res-pending-1" refreshKey={0} />);
    await screen.findByText("この予約のメールの下書きはありません。");
  });
});
