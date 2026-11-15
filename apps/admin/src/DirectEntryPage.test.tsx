// @vitest-environment jsdom
import { Yen } from "@zebra/contracts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.tsx";
import { detailResponse, fakeApi, listResponse, type FakeResponse } from "./test-support.ts";

const now = () => DateTime.fromISO("2026-11-15T10:00:00+09:00");

type Call = { method: string; url: string; body: unknown };

/** 直接入力の画面を開く。直接入力の POST には responses を順に返す */
const openDirectEntry = async (responses: FakeResponse[]) => {
  let posts = 0;
  const fake = fakeApi(({ method, url }) => {
    if (method === "POST" && url === "/admin/reservations") {
      const response = responses[Math.min(posts, responses.length - 1)];
      posts += 1;
      if (response === undefined) throw new Error("返事を用意していない");
      return response;
    }
    if (url.startsWith("/admin/reservations/")) {
      return {
        status: 200,
        body: detailResponse({
          id: "res-new",
          status: "firm",
          route: "admin",
          receiptNumber: undefined,
          confirmedPrice: Yen.parse(11_000),
          currentEstimate: undefined,
        }),
      };
    }
    return { status: 200, body: listResponse() };
  });
  render(<App api={fake.api} now={now} />);
  await screen.findByText("架空 太郎");
  expect(screen.getByRole("link", { name: "予約を直接入れる" }).getAttribute("href")).toBe(
    "#/direct-entry",
  );
  window.location.hash = "#/direct-entry";
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  await screen.findByRole("heading", { name: "予約を直接入れる" });
  return fake;
};

const form = () => screen.getByRole("form", { name: "予約の直接入力" });
const change = (label: string, value: string) =>
  fireEvent.change(within(form()).getByLabelText(label), { target: { value } });

/** 本予約 11/20 10:00〜12:00、3人、架空の氏名と電話番号 */
const fillFirm = () => {
  fireEvent.click(within(form()).getByLabelText("本予約"));
  change("開始（JST）", "2026-11-20T10:00");
  change("終わり（JST）", "2026-11-20T12:00");
  change("人数", "3");
  change("氏名（必須）", "架空 次郎");
  change("電話番号", "090-0000-0001");
};

const directEntryPosts = (calls: Call[]) =>
  calls
    .filter((c) => c.method === "POST" && c.url === "/admin/reservations")
    .map((c) => c.body as Record<string, unknown>);

beforeEach(() => {
  window.location.hash = "";
});
afterEach(() => {
  cleanup();
});

describe("予約の直接入力", () => {
  it("見積を確定金額の初期値にして送り、成功したらその予約の詳細を開く", async () => {
    const { calls } = await openDirectEntry([{ status: 201, body: { reservationId: "res-new" } }]);
    fillFirm();
    expect(within(form()).getByRole("note", { name: "見積" }).textContent).toBe(
      "見積（今の料金表）：11,000円（税込。税抜 10,000円）・プランA",
    );
    expect(within(form()).getByLabelText("確定金額（税込・円）")).toHaveProperty("value", "11000");
    fireEvent.click(within(form()).getByRole("button", { name: "入れる" }));

    await vi.waitFor(() => expect(window.location.hash).toBe("#/reservations/res-new"));
    expect(directEntryPosts(calls)).toEqual([
      {
        kind: "firm",
        start: "2026-11-20T10:00:00.000+09:00",
        end: "2026-11-20T12:00:00.000+09:00",
        partySize: 3,
        cycloramaFloorProtection: false,
        equipmentInsurance: false,
        optionIds: [],
        confirmedPrice: 11_000,
        customer: { name: "架空 次郎", phone: "090-0000-0001" },
        shooting: {},
      },
    ]);
    expect(await screen.findByRole("heading", { name: "予約の詳細" })).toBeTruthy();
    expect(calls.map((c) => c.url)).toContain("/admin/reservations/res-new");
  });

  it("第二キープ・ほかの欄も契約の形で送る（深夜帯の見積、確定金額の上書き、撮影の内容）", async () => {
    const { calls } = await openDirectEntry([{ status: 201, body: { reservationId: "res-new" } }]);
    fireEvent.click(within(form()).getByLabelText("第二キープ"));
    expect(form().textContent).toContain("重なっている承認済みの仮予約すべてに付きます");
    change("開始（JST）", "2026-11-20T21:00");
    change("終わり（JST）", "2026-11-21T01:00");
    change("人数", "15");
    fireEvent.click(within(form()).getByLabelText("ホリゾントの養生あり（床面を全面養生する）"));
    fireEvent.click(
      within(form()).getByLabelText("ラメやグリッターを多用した衣装・小道具の持ち込み"),
    );
    // 15人でも全面養生ならプランA：通常 2,500 × 4 + 深夜 3,750 × 4 + 2,000 = 27,000 → 29,700
    expect(within(form()).getByRole("note", { name: "見積" }).textContent).toContain(
      "29,700円（税込。税抜 27,000円）・プランA",
    );
    change("確定金額（税込・円）", "28000");
    change("氏名（必須）", "架空 三郎");
    change("会社名", "架空映像合同会社");
    change("メールアドレス", "saburo@example.com");
    fireEvent.click(within(form()).getByLabelText("楽器の演奏を伴う撮影"));
    change("撮影詳細", "MV の撮影");
    fireEvent.click(within(form()).getByRole("button", { name: "入れる" }));

    await vi.waitFor(() => expect(window.location.hash).toBe("#/reservations/res-new"));
    expect(directEntryPosts(calls)).toEqual([
      {
        kind: "second-hold",
        start: "2026-11-20T21:00:00.000+09:00",
        end: "2026-11-21T01:00:00.000+09:00",
        partySize: 15,
        cycloramaFloorProtection: true,
        equipmentInsurance: false,
        optionIds: ["glitter"],
        confirmedPrice: 28_000,
        customer: {
          name: "架空 三郎",
          companyName: "架空映像合同会社",
          email: "saburo@example.com",
        },
        shooting: { types: ["music"], details: "MV の撮影" },
      },
    ]);
  });

  it("警告（409）を見せ、確かめたらその警告の一覧を付けて送り直す", async () => {
    const { calls } = await openDirectEntry([
      {
        status: 409,
        body: { error: "unacknowledged-warnings", warnings: ["past-provisional-deadline"] },
      },
      { status: 201, body: { reservationId: "res-new" } },
    ]);
    fillFirm();
    fireEvent.click(within(form()).getByLabelText("仮予約"));
    fireEvent.click(within(form()).getByRole("button", { name: "入れる" }));

    const confirm = await screen.findByRole("group", { name: "警告の確認" });
    expect(confirm.textContent).toContain("仮予約・第二キープの締め切りを過ぎています");
    expect(window.location.hash).toBe("#/direct-entry");
    fireEvent.click(within(confirm).getByRole("button", { name: "警告を確かめたうえで入れる" }));

    await vi.waitFor(() => expect(window.location.hash).toBe("#/reservations/res-new"));
    const posted = directEntryPosts(calls);
    expect(posted).toHaveLength(2);
    expect(posted[0]).not.toHaveProperty("acknowledgedWarnings");
    expect(posted[0]).toMatchObject({ kind: "provisional" });
    expect(posted[1]).toEqual({
      ...posted[0],
      acknowledgedWarnings: ["past-provisional-deadline"],
    });
  });

  it("警告の確認をやめれば、送り直さない", async () => {
    const { calls } = await openDirectEntry([
      {
        status: 409,
        body: { error: "unacknowledged-warnings", warnings: ["late-night-shorter-than-4-hours"] },
      },
    ]);
    fillFirm();
    fireEvent.click(within(form()).getByRole("button", { name: "入れる" }));
    const confirm = await screen.findByRole("group", { name: "警告の確認" });
    expect(confirm.textContent).toContain("深夜帯にかかり、4時間より短い予約です");
    fireEvent.click(within(confirm).getByRole("button", { name: "やめる" }));
    expect(screen.queryByRole("group", { name: "警告の確認" })).toBeNull();
    expect(directEntryPosts(calls)).toHaveLength(1);
  });

  it("不可（422）は理由を出して止める", async () => {
    const cases: [FakeResponse, string][] = [
      [{ status: 422, body: { error: "shorter-than-2-hours" } }, "2時間より短い予約はできません。"],
      [
        { status: 422, body: { error: "no-provisional-to-hold" } },
        "第二キープが付く仮予約がありません。",
      ],
      [
        { status: 422, body: { error: "overlaps-existing" } },
        "ほかの予約・ブロック枠と重なっています。",
      ],
    ];
    for (const [response, message] of cases) {
      await openDirectEntry([response]);
      fillFirm();
      fireEvent.click(within(form()).getByRole("button", { name: "入れる" }));
      expect((await screen.findByRole("alert")).textContent).toBe(
        `入れられませんでした。${message}`,
      );
      expect(screen.queryByRole("group", { name: "警告の確認" })).toBeNull();
      expect(window.location.hash).toBe("#/direct-entry");
      cleanup();
      window.location.hash = "";
    }
  });

  it("種類・日時・人数・お客様の情報が足りなければ、送らずに知らせる", async () => {
    const { calls } = await openDirectEntry([]);
    fireEvent.click(within(form()).getByRole("button", { name: "入れる" }));
    const alert = screen.getByRole("alert");
    expect(Array.from(alert.querySelectorAll("p")).map((p) => p.textContent)).toEqual([
      "予約の種類を選んでください。",
      "開始の日時を入れてください。",
      "終わりの日時を入れてください。",
      "人数は、1〜100の整数で入れてください。",
      "確定金額は、0以上の整数（円）で入れてください。",
      "氏名を入れてください。",
      "電話番号かメールアドレスのどちらか1つを入れてください。",
    ]);
    expect(within(form()).getByRole("note", { name: "見積" }).textContent).toBe(
      "開始と終わりの日時を入れると、見積を出します。",
    );
    expect(directEntryPosts(calls)).toEqual([]);
  });
});
