// @vitest-environment jsdom
import type { AdminDraftDetail } from "@zebra/contracts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { DraftPage } from "./DraftPage.tsx";
import { draftDetailResponse, fakeApi, fakeClipboard, type FakeResponse } from "./test-support.ts";

const DRAFT_URL = "/admin/reservations/res-pending-1/drafts/20261030T001500000Z-0001";

let consoleSpies: MockInstance[] = [];
beforeEach(() => {
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((name) =>
    vi.spyOn(console, name),
  );
});
afterEach(() => {
  cleanup();
  // 文面・あて先をログに出さない（INV-10）。画面の部品は console を使わない
  for (const spy of consoleSpies) {
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  }
});

/**
 * 下書きを返し、送信済み・送らないには statusResponse を返す API で、下書きの画面を開く。
 * 状態を変えたあとの読み直しには draftAfter を返す
 */
const openDraft = async (
  draft: AdminDraftDetail = draftDetailResponse(),
  options: {
    clipboard?: ReturnType<typeof fakeClipboard>;
    statusResponse?: FakeResponse;
    draftAfter?: AdminDraftDetail;
  } = {},
) => {
  let posted = false;
  const fake = fakeApi(({ method }) => {
    if (method === "POST") {
      posted = true;
      return options.statusResponse ?? { status: 200 };
    }
    return { status: 200, body: posted ? (options.draftAfter ?? draft) : draft };
  });
  const clipboard = options.clipboard ?? fakeClipboard();
  const onStatusChanged = vi.fn();
  const view = render(
    <DraftPage
      api={fake.api}
      copier={clipboard.copier}
      reservationId={draft.reservationId}
      draftId={draft.draftId}
      onStatusChanged={onStatusChanged}
    />,
  );
  await screen.findByRole("heading", { name: "件名" });
  return { ...fake, clipboard, onStatusChanged, container: view.container };
};

const posts = (calls: { method: string; url: string; body: unknown }[]) =>
  calls.filter((c) => c.method === "POST").map((c) => [c.url, c.body]);

describe("下書きを開く", () => {
  it("予約の id と下書きの id で読み、種類・状態・作った日時（JST）・あて先・件名を出す", async () => {
    const { calls } = await openDraft();
    expect(calls.map((c) => c.url)).toEqual([DRAFT_URL]);
    expect(screen.getByText("承認のお知らせ")).toBeTruthy();
    expect(screen.getByText("未送信")).toBeTruthy();
    expect(screen.getByText("2026/10/30(金) 09:15")).toBeTruthy();
    expect(screen.getByText("hanako@example.com")).toBeTruthy();
    expect(
      screen.getByText(
        "2026年11月5日(木) 10時00分〜12時00分の仮予約を承りました（スタジオゼブラ）",
      ),
    ).toBeTruthy();
  });

  it("本文は API の HTML をそのまま描き、赤字・青字・下線の見た目を見せる（エスケープ済みの値は文字のまま）", async () => {
    await openDraft();
    const body = screen.getByRole("document", { name: "本文" });
    const spans = [...body.querySelectorAll("span")].map((s) => [
      s.getAttribute("style"),
      s.textContent,
    ]);
    expect(spans).toEqual([
      ["color:#ff0000", "撮影当日に履いていらっしゃった靴のご使用は禁止です。"],
      ["color:#0000ff", "デニム等の色落ちするボトム"],
      ["text-decoration:underline", "ブーツなど"],
    ]);
    expect(body.querySelectorAll("br")).toHaveLength(5);
    // 差し込んだ値（API がエスケープしたもの）は要素にならず、文字のまま出る
    expect(body.textContent).toContain("撮影詳細：A&B <商品>");
    expect(body.querySelector("商品")).toBeNull();
  });

  it("本文のほか（件名・あて先）は、HTML として描かない", async () => {
    await openDraft(
      draftDetailResponse({ subject: "<b>件名</b>の確かめ", to: "<i>x</i>@example.com" }),
    );
    expect(screen.getByText("<b>件名</b>の確かめ")).toBeTruthy();
    expect(screen.getByText("<i>x</i>@example.com")).toBeTruthy();
    expect(document.querySelector("b")).toBeNull();
    expect(document.querySelector("i")).toBeNull();
  });

  it("メールを送らない：Gmail を開くリンクや mailto を作らない（INV-6）", async () => {
    const { container } = await openDraft();
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["#/drafts", "#/reservations/res-pending-1"]);
    expect(container.querySelector("form")).toBeNull();
  });

  it("メールアドレスのない予約：「メールアドレスがありません（電話で伝える）」と出し、あて先のコピーを出さない", async () => {
    await openDraft(draftDetailResponse({ to: undefined }));
    expect(screen.getByText(/^メールアドレスがありません（電話で伝える）/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "あて先をコピー" })).toBeNull();
  });

  it("同意書を添付する下書き：「同意書を Gmail で添付する」と目立たせる。ほかの下書きでは出さない", async () => {
    await openDraft(draftDetailResponse({ attachConsentForm: true }));
    const notes = screen.getAllByRole("note").map((n) => n.textContent);
    expect(notes).toEqual([expect.stringContaining("同意書を Gmail で添付する")]);
    cleanup();

    await openDraft(draftDetailResponse({ attachConsentForm: false }));
    expect(screen.queryByText(/同意書を Gmail で添付する/)).toBeNull();
  });

  it("下書きがなければ、理由を日本語で出す", async () => {
    const fake = fakeApi(() => ({ status: 404, body: { error: "not-found" } }));
    render(
      <DraftPage
        api={fake.api}
        copier={fakeClipboard().copier}
        reservationId="res-1"
        draftId="d-none"
        onStatusChanged={vi.fn()}
      />,
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "予約か下書きが見つかりません。",
    );
  });
});

describe("下書きをコピーする", () => {
  it("本文をコピー：HTML（text/html）とテキスト（text/plain）の両方を ClipboardItem で入れる", async () => {
    const draft = draftDetailResponse();
    const { clipboard } = await openDraft(draft);
    fireEvent.click(screen.getByRole("button", { name: "本文をコピー" }));

    expect((await screen.findByRole("status")).textContent).toBe(
      "本文をコピーしました（色と下線つき）。Gmail の本文に貼ってください。",
    );
    expect(await clipboard.written()).toEqual([
      {
        "text/html": ["text/html", draft.html],
        "text/plain": ["text/plain", draft.text],
      },
    ]);
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it("本文をコピー：ClipboardItem が使えなければテキストだけを入れ、選んでコピーするよう案内する", async () => {
    const draft = draftDetailResponse();
    const { clipboard } = await openDraft(draft, { clipboard: fakeClipboard("no-clipboard-item") });
    fireEvent.click(screen.getByRole("button", { name: "本文をコピー" }));

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("テキストだけでコピーしました");
    expect(status.textContent).toContain("「本文を選ぶ」を押して");
    expect(clipboard.writeText.mock.calls).toEqual([[draft.text]]);
  });

  it("本文をコピー：クリップボードが使えなければ、選んでコピーするよう知らせる", async () => {
    await openDraft(draftDetailResponse(), { clipboard: fakeClipboard("none") });
    fireEvent.click(screen.getByRole("button", { name: "本文をコピー" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("本文をコピーできませんでした。");
    expect(alert.textContent).toContain("Ctrl+C");
  });

  it("本文を選ぶ：描いた本文を選んだ状態にする（選んでコピーすれば色と下線が残る）", async () => {
    await openDraft();
    fireEvent.click(screen.getByRole("button", { name: "本文を選ぶ" }));
    const selection = window.getSelection();
    expect(selection?.toString()).toContain("撮影当日に履いていらっしゃった靴のご使用は禁止です。");
    expect(selection?.toString()).not.toContain("件名");
  });

  it("件名をコピー・あて先をコピー：テキストで入れる", async () => {
    const draft = draftDetailResponse();
    const { clipboard } = await openDraft(draft);
    fireEvent.click(screen.getByRole("button", { name: "件名をコピー" }));
    expect((await screen.findByRole("status")).textContent).toBe("件名をコピーしました。");
    fireEvent.click(screen.getByRole("button", { name: "あて先をコピー" }));
    await screen.findByText("あて先をコピーしました。");
    expect(clipboard.writeText.mock.calls).toEqual([[draft.subject], ["hanako@example.com"]]);
    expect(clipboard.write).not.toHaveBeenCalled();
  });

  it("件名をコピー：入れられなければ、選んでコピーするよう知らせる", async () => {
    await openDraft(draftDetailResponse(), { clipboard: fakeClipboard("none") });
    fireEvent.click(screen.getByRole("button", { name: "件名をコピー" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "件名をコピーできませんでした。",
    );
  });
});

describe("送信済みにする・送らないにする", () => {
  it("送信済み：確かめてから空の本文で sent に POST し、読み直して状態を出す。やめれば送らない", async () => {
    const { calls, onStatusChanged } = await openDraft(draftDetailResponse(), {
      draftAfter: draftDetailResponse({ status: "sent" }),
    });
    fireEvent.click(screen.getByRole("button", { name: "送信済みにする…" }));
    const confirm = screen.getByRole("group", { name: "送信済みにする確認" });
    expect(confirm.textContent).toContain("Gmail から送りましたか？");
    fireEvent.click(within(confirm).getByRole("button", { name: "やめる" }));
    expect(posts(calls)).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "送信済みにする…" }));
    fireEvent.click(screen.getByRole("button", { name: "送信済みにする" }));
    expect((await screen.findByRole("status")).textContent).toBe(
      "送信済みにしました。未送信の一覧から消えました。",
    );
    expect(posts(calls)).toEqual([[`${DRAFT_URL}/sent`, {}]]);
    await screen.findByText("送信済み");
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
    expect(onStatusChanged).toHaveBeenCalledTimes(1);
    // 送信済みにしたあとは、もう変えられない
    expect(screen.queryByRole("button", { name: "送らないにする…" })).toBeNull();
    expect(screen.getByRole("region", { name: "送ったあと" }).textContent).toContain(
      "この下書きは「送信済み」にしてあります。未送信には戻せません。",
    );
  });

  it("送らない：確かめてから空の本文で skip に POST する", async () => {
    const { calls } = await openDraft(draftDetailResponse(), {
      draftAfter: draftDetailResponse({ status: "skipped" }),
    });
    fireEvent.click(screen.getByRole("button", { name: "送らないにする…" }));
    const confirm = screen.getByRole("group", { name: "送らないにする確認" });
    expect(confirm.textContent).toContain("未送信には戻せません");
    fireEvent.click(within(confirm).getByRole("button", { name: "送らないにする" }));
    await screen.findByText("送らないにしました。未送信の一覧から消えました。");
    expect(posts(calls)).toEqual([[`${DRAFT_URL}/skip`, {}]]);
    expect(screen.getByText("送らない")).toBeTruthy();
  });

  it("メールアドレスのない予約では、電話で伝えたかを確かめる", async () => {
    await openDraft(draftDetailResponse({ to: undefined }));
    fireEvent.click(screen.getByRole("button", { name: "送信済みにする…" }));
    expect(screen.getByRole("group", { name: "送信済みにする確認" }).textContent).toContain(
      "電話で伝えましたか？",
    );
  });

  it("未送信でない下書き（409 draft-not-unsent）：理由を日本語で出し、今の状態を読み直す", async () => {
    const { calls } = await openDraft(draftDetailResponse(), {
      statusResponse: { status: 409, body: { error: "draft-not-unsent" } },
      draftAfter: draftDetailResponse({ status: "skipped" }),
    });
    fireEvent.click(screen.getByRole("button", { name: "送信済みにする…" }));
    fireEvent.click(screen.getByRole("button", { name: "送信済みにする" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("送信済みにできませんでした。");
    expect(alert.textContent).toContain("未送信の下書きではないため");
    await screen.findByText("この下書きは「送らない」にしてあります。未送信には戻せません。");
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
  });

  it("送信済み・送らないの下書きを開いたときは、ボタンを出さない", async () => {
    await openDraft(draftDetailResponse({ status: "sent" }));
    expect(screen.queryByRole("button", { name: "送信済みにする…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "送らないにする…" })).toBeNull();
    // 送ったあとでも、文面は開いてコピーできる
    expect(screen.getByRole("button", { name: "本文をコピー" })).toBeTruthy();
  });
});
