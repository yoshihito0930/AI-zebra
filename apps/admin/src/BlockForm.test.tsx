// @vitest-environment jsdom
import { AdminReservationList } from "@zebra/contracts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildBlock } from "./BlockForm.tsx";
import type { ListFilter } from "./list.ts";
import { ReservationListPage } from "./ReservationListPage.tsx";
import { fakeApi, listResponse, type FakeResponse } from "./test-support.ts";

afterEach(() => {
  cleanup();
});

type Call = { method: string; url: string; body: unknown };

const filter: ListFilter = {
  from: "2026-11-01",
  to: "2026-11-30",
  status: "all",
  ignorePeriod: false,
};

/** 管理者が入れたブロック枠（block-1。設備点検）と、Googleカレンダーから取り込んだブロック枠（block-gcal） */
const list = (): AdminReservationList =>
  AdminReservationList.parse({
    ...listResponse(),
    blocks: [
      ...listResponse().blocks,
      {
        id: "block-gcal",
        start: "2026-11-12T10:00:00.000+09:00",
        end: "2026-11-12T12:00:00.000+09:00",
        bufferMinutes: 60,
        route: "google-calendar",
      },
    ],
  });

/** 一覧を開く。書く操作（POST・PUT・DELETE）には responses を順に返す */
const openList = async (responses: FakeResponse[] = []) => {
  let writes = 0;
  const fake = fakeApi(({ method }) => {
    if (method !== "GET") {
      const response = responses[Math.min(writes, responses.length - 1)];
      writes += 1;
      if (response === undefined) throw new Error("返事を用意していない");
      return response;
    }
    return { status: 200, body: list() };
  });
  render(<ReservationListPage api={fake.api} filter={filter} onFilterChange={() => {}} />);
  await screen.findByText("設備点検");
  return fake;
};

const writes = (calls: Call[]) =>
  calls.filter((c) => c.method !== "GET").map((c) => [c.method, c.url, c.body]);
const gets = (calls: Call[]) => calls.filter((c) => c.method === "GET");

const rowOf = (text: string) =>
  within(screen.getByRole("table"))
    .getAllByRole("row")
    .find((row) => row.textContent?.includes(text)) as HTMLElement;

describe("ブロック枠を入れる・直す・消す", () => {
  it("管理者が入れたブロック枠の行にだけ、直す・消すを出す（Googleカレンダーから取り込んだものには出さない）", async () => {
    await openList();
    expect(
      within(rowOf("設備点検"))
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["直す…", "消す…"]);
    expect(within(rowOf("Googleカレンダー")).queryAllByRole("button")).toEqual([]);
    expect(within(rowOf("架空 太郎")).queryAllByRole("button")).toEqual([]);
  });

  it("入れる：区間（JST）・バッファ・メモを送り、一覧を読み直す", async () => {
    const { calls } = await openList([{ status: 201, body: { blockId: "block-new" } }]);
    fireEvent.click(screen.getByRole("button", { name: "ブロック枠を入れる…" }));
    const form = screen.getByRole("form", { name: "ブロック枠を入れる" });
    // バッファの初期値は「なし」
    expect(within(form).getByLabelText("後ろのバッファ")).toHaveProperty("value", "0");
    fireEvent.change(within(form).getByLabelText("開始（JST）"), {
      target: { value: "2026-11-25T00:00" },
    });
    fireEvent.change(within(form).getByLabelText("終わり（JST）"), {
      target: { value: "2026-11-28T00:00" },
    });
    fireEvent.change(within(form).getByLabelText("後ろのバッファ"), { target: { value: "30" } });
    fireEvent.change(within(form).getByLabelText("理由のメモ"), { target: { value: " 休業 " } });
    fireEvent.click(within(form).getByRole("button", { name: "入れる" }));

    expect((await screen.findByRole("status")).textContent).toBe("ブロック枠を入れました。");
    expect(writes(calls)).toEqual([
      [
        "POST",
        "/admin/blocks",
        {
          start: "2026-11-25T00:00:00.000+09:00",
          end: "2026-11-28T00:00:00.000+09:00",
          bufferMinutes: 30,
          memo: "休業",
        },
      ],
    ]);
    await vi.waitFor(() => expect(gets(calls)).toHaveLength(2));
    expect(screen.queryByRole("form", { name: "ブロック枠を入れる" })).toBeNull();
  });

  it("直す：初期値は一覧の行の値。全部を送り、メモを空にすればメモは送らない", async () => {
    const { calls } = await openList([{ status: 200 }]);
    fireEvent.click(within(rowOf("設備点検")).getByRole("button", { name: "直す…" }));
    const form = screen.getByRole("form", { name: "ブロック枠を直す" });
    expect(within(form).getByLabelText("開始（JST）")).toHaveProperty("value", "2026-11-10T09:00");
    expect(within(form).getByLabelText("終わり（JST）")).toHaveProperty(
      "value",
      "2026-11-10T18:00",
    );
    expect(within(form).getByLabelText("後ろのバッファ")).toHaveProperty("value", "0");
    expect(within(form).getByLabelText("理由のメモ")).toHaveProperty("value", "設備点検");

    fireEvent.change(within(form).getByLabelText("終わり（JST）"), {
      target: { value: "2026-11-10T19:00" },
    });
    fireEvent.change(within(form).getByLabelText("後ろのバッファ"), { target: { value: "60" } });
    fireEvent.change(within(form).getByLabelText("理由のメモ"), { target: { value: "" } });
    fireEvent.click(within(form).getByRole("button", { name: "直す" }));

    expect((await screen.findByRole("status")).textContent).toBe("ブロック枠を直しました。");
    expect(writes(calls)).toEqual([
      [
        "PUT",
        "/admin/blocks/block-1",
        {
          start: "2026-11-10T09:00:00.000+09:00",
          end: "2026-11-10T19:00:00.000+09:00",
          bufferMinutes: 60,
        },
      ],
    ]);
    await vi.waitFor(() => expect(gets(calls)).toHaveLength(2));
  });

  it("消す：確かめてから DELETE を送り、一覧を読み直す。やめれば送らない", async () => {
    const { calls } = await openList([{ status: 200 }]);
    fireEvent.click(within(rowOf("設備点検")).getByRole("button", { name: "消す…" }));
    let confirm = screen.getByRole("group", { name: "ブロック枠を消す確認" });
    expect(confirm.textContent).toContain(
      "ブロック枠 2026/11/10(火) 09:00〜18:00（設備点検）を消すと",
    );
    fireEvent.click(within(confirm).getByRole("button", { name: "やめる" }));
    expect(writes(calls)).toEqual([]);

    fireEvent.click(within(rowOf("設備点検")).getByRole("button", { name: "消す…" }));
    confirm = screen.getByRole("group", { name: "ブロック枠を消す確認" });
    fireEvent.click(within(confirm).getByRole("button", { name: "消す" }));
    expect((await screen.findByRole("status")).textContent).toBe("ブロック枠を消しました。");
    expect(writes(calls)).toEqual([["DELETE", "/admin/blocks/block-1", undefined]]);
    await vi.waitFor(() => expect(gets(calls)).toHaveLength(2));
  });

  it("できなかったときは理由を日本語で出す（ブロック枠がない、重なる、90日を超える、取り込んだもの）", async () => {
    const cases: [FakeResponse, string][] = [
      [{ status: 404, body: { error: "not-found" } }, "ブロック枠が見つかりません。"],
      [
        { status: 422, body: { error: "overlaps-existing" } },
        "ほかの予約・ブロック枠と重なっています。",
      ],
      [
        { status: 422, body: { error: "more-than-90-days" } },
        "ブロック枠がかかる日が90日を超えます",
      ],
      [
        { status: 422, body: { error: "not-on-30-minute-boundary" } },
        "時刻が30分単位ではありません。",
      ],
      [
        { status: 409, body: { error: "google-calendar-block" } },
        "Googleカレンダーから取り込んだブロック枠は、直したり消したりできません。",
      ],
    ];
    for (const [response, message] of cases) {
      await openList([response]);
      fireEvent.click(within(rowOf("設備点検")).getByRole("button", { name: "直す…" }));
      const form = screen.getByRole("form", { name: "ブロック枠を直す" });
      fireEvent.click(within(form).getByRole("button", { name: "直す" }));
      const alert = await within(form).findByRole("alert");
      expect(alert.textContent).toContain("直せませんでした。");
      expect(alert.textContent).toContain(message);
      cleanup();
    }
  });

  it("日時がなければ、送らずに知らせる", async () => {
    const { calls } = await openList();
    fireEvent.click(screen.getByRole("button", { name: "ブロック枠を入れる…" }));
    const form = screen.getByRole("form", { name: "ブロック枠を入れる" });
    fireEvent.click(within(form).getByRole("button", { name: "入れる" }));
    expect(within(form).getByRole("alert").textContent).toBe(
      "開始の日時を入れてください。終わりの日時を入れてください。",
    );
    expect(writes(calls)).toEqual([]);
  });
});

describe("ブロック枠の本文", () => {
  it("メモが長すぎれば送らない（500文字まで）", () => {
    expect(
      buildBlock({
        start: "2026-11-10T09:00",
        end: "2026-11-10T18:00",
        bufferMinutes: 0,
        memo: "あ".repeat(501),
      }),
    ).toEqual({ ok: false, messages: ["理由のメモが長すぎます（500文字まで）。"] });
  });
});
