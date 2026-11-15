// @vitest-environment jsdom
import { Yen, type AdminReservationDetail } from "@zebra/contracts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ReservationDetailPage } from "./ReservationDetailPage.tsx";
import { accepted, detailResponse, fakeApi, type FakeResponse } from "./test-support.ts";

afterEach(() => {
  cleanup();
});

/** 詳細を返し、操作には operationResponse を返す API で、詳細の画面を開く */
const openDetail = async (
  detail: AdminReservationDetail,
  operationResponse: FakeResponse = { status: 200, body: accepted([]) },
  detailAfter: AdminReservationDetail = detail,
) => {
  let operated = false;
  const fake = fakeApi(({ method }) => {
    if (method === "POST") {
      operated = true;
      return operationResponse;
    }
    return { status: 200, body: operated ? detailAfter : detail };
  });
  render(<ReservationDetailPage api={fake.api} reservationId={detail.id} />);
  await screen.findByRole("heading", { name: "予約の内容" });
  return fake;
};

const posts = (calls: { method: string; url: string; body: unknown }[]) =>
  calls.filter((c) => c.method === "POST").map((c) => [c.url, c.body]);

const firm = (): AdminReservationDetail =>
  detailResponse({
    id: "res-firm-1",
    status: "firm",
    confirmedPrice: Yen.parse(11_000),
    currentEstimate: undefined,
    cancellationFeeIfCancelledNow: { ratePercent: 50, fee: Yen.parse(5_500) },
  });

describe("予約の詳細", () => {
  it("予約の内容を JST で、金額を円で出す", async () => {
    const { calls } = await openDetail(detailResponse());
    expect(calls[0]?.url).toBe("/admin/reservations/res-pending-1");
    expect(screen.getByText("2026/11/05(木) 10:00〜12:00")).toBeTruthy();
    expect(screen.getByText("承認待ち（仮）")).toBeTruthy();
    expect(screen.getByText("EFGH6789")).toBeTruthy();
    expect(screen.getByText("プランA")).toBeTruthy();
    expect(screen.getByText("ラメやグリッターを多用した衣装・小道具の持ち込み")).toBeTruthy();
    // 申込のときの見積と、今の料金表での見積（同じ額）
    expect(screen.getAllByText("12,100円（税込。税抜 11,000円）")).toHaveLength(2);
    // 作成日時、更新日時、履歴の申込の日時
    expect(screen.getAllByText("2026/10/30(金) 09:15")).toHaveLength(3);
  });

  it("お客様の情報と撮影の内容を出す", async () => {
    await openDetail(detailResponse());
    expect(screen.getByText("架空 花子")).toBeTruthy();
    expect(screen.getByText("hanako@example.com")).toBeTruthy();
    expect(screen.getByText("090-0000-0000")).toBeTruthy();
    expect(screen.getByText("スチール撮影、ムービー撮影")).toBeTruthy();
    expect(screen.getByText("商品撮影")).toBeTruthy();
  });

  it("履歴を古い順に、誰が・何をしたかと変わったものを出す", async () => {
    await openDetail(
      detailResponse({
        status: "provisional",
        confirmedPrice: Yen.parse(12_000),
        currentEstimate: undefined,
        history: [
          ...detailResponse().history,
          {
            at: "2026-10-31T11:00:00.000+09:00",
            actor: { kind: "admin", userId: "dev-admin" },
            operation: "approve",
            before: {
              status: "pending-provisional",
              start: "2026-11-05T10:00:00.000+09:00",
              end: "2026-11-05T12:00:00.000+09:00",
              bufferMinutes: 60,
            },
            after: {
              status: "provisional",
              start: "2026-11-05T10:00:00.000+09:00",
              end: "2026-11-05T12:00:00.000+09:00",
              bufferMinutes: 60,
              confirmedPrice: Yen.parse(12_000),
            },
          },
        ],
      }),
    );
    const rows = within(screen.getByRole("table", { name: "履歴" }))
      .getAllByRole("row")
      .slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      "2026/10/30(金) 09:15お客様申込状態：承認待ち（仮）日時：2026/11/05(木) 10:00〜12:00",
      "2026/10/31(土) 11:00管理者（dev-admin）承認状態：承認待ち（仮） → 仮予約確定金額：未定 → 12,000円",
    ]);
  });

  it("承認待ちなら今の料金表での見積を出し、申込のときと違えば知らせる", async () => {
    await openDetail(
      detailResponse({
        currentEstimate: {
          subtotalExcludingTax: Yen.parse(12_000),
          estimateIncludingTax: Yen.parse(13_200),
        },
      }),
    );
    const section = screen.getByRole("region", { name: "今の料金表での見積" });
    expect(section.textContent).toContain("13,200円（税込。税抜 12,000円）");
    expect(within(section).getByRole("note").textContent).toContain(
      "申込のときの見積（12,100円）と違います",
    );
  });

  it("取消できる状態なら、今取消したときのキャンセル料を出す", async () => {
    await openDetail(firm());
    expect(
      screen.getByRole("region", { name: "今取消したときのキャンセル料" }).textContent,
    ).toContain("5,500円（50%）");
  });

  it("予約がなければ、理由を日本語で出す", async () => {
    const fake = fakeApi(() => ({ status: 404, body: { error: "not-found" } }));
    render(<ReservationDetailPage api={fake.api} reservationId="res-none" />);
    expect((await screen.findByRole("alert")).textContent).toBe("予約が見つかりません。");
  });
});

describe("詳細からの操作", () => {
  it("状態ごとに、できる操作だけを出す", async () => {
    const buttonsOf = async (detail: AdminReservationDetail) => {
      await openDetail(detail);
      const names = within(screen.getByRole("region", { name: "操作" }))
        .queryAllByRole("button")
        .map((b) => b.textContent);
      cleanup();
      return names;
    };
    expect(await buttonsOf(detailResponse())).toEqual(["承認する", "却下…"]);
    expect(
      await buttonsOf(detailResponse({ status: "provisional", currentEstimate: undefined })),
    ).toEqual(["本予約に昇格する", "取消…"]);
    expect(await buttonsOf(firm())).toEqual(["取消…"]);
    expect(
      await buttonsOf(detailResponse({ status: "second-hold", currentEstimate: undefined })),
    ).toEqual(["仮予約に繰り上げる", "取消…"]);
    expect(
      await buttonsOf(detailResponse({ status: "cancelled", currentEstimate: undefined })),
    ).toEqual([]);
  });

  it("承認：確定金額の初期値は申込のときの見積で、そのまま送れる", async () => {
    const { calls } = await openDetail(detailResponse(), {
      status: 200,
      body: accepted([
        { kind: "approval", reservationId: "res-pending-1", confirmedPrice: Yen.parse(12_100) },
      ]),
    });
    expect(screen.getByLabelText("確定金額（税込・円）")).toHaveProperty("value", "12100");
    fireEvent.click(screen.getByRole("button", { name: "承認する" }));

    const result = await screen.findByRole("status", { name: "操作の結果" });
    expect(posts(calls)).toEqual([
      ["/admin/reservations/res-pending-1/approve", { confirmedPrice: 12_100 }],
    ]);
    expect(result.textContent).toContain("承認しました。");
    expect(result.textContent).toContain(
      "承認のお知らせ、あて先の予約：この予約、確定金額 12,100円",
    );
  });

  it("承認：確定金額を直して送れる。成功したら詳細を読み直す", async () => {
    const { calls } = await openDetail(
      detailResponse(),
      { status: 200, body: accepted([]) },
      detailResponse({
        status: "provisional",
        confirmedPrice: Yen.parse(10_000),
        currentEstimate: undefined,
      }),
    );
    fireEvent.change(screen.getByLabelText("確定金額（税込・円）"), { target: { value: "10000" } });
    fireEvent.click(screen.getByRole("button", { name: "承認する" }));

    await screen.findByText("仮予約");
    expect(posts(calls)).toEqual([
      ["/admin/reservations/res-pending-1/approve", { confirmedPrice: 10_000 }],
    ]);
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(2);
    expect(screen.getByText("作ったメールの下書きはありません。")).toBeTruthy();
  });

  it("承認：確定金額が整数の円でなければ、送らずに知らせる", async () => {
    const { calls } = await openDetail(detailResponse());
    for (const value of ["12100.5", "-1", "", "1万"]) {
      fireEvent.change(screen.getByLabelText("確定金額（税込・円）"), { target: { value } });
      fireEvent.click(screen.getByRole("button", { name: "承認する" }));
      expect(screen.getByRole("alert").textContent).toBe(
        "確定金額は、0以上の整数（円）で入れてください。",
      );
    }
    expect(posts(calls)).toEqual([]);
  });

  it("却下：確かめてから送る。やめれば送らない", async () => {
    const { calls } = await openDetail(detailResponse(), {
      status: 200,
      body: accepted([{ kind: "rejection", reservationId: "res-pending-1" }]),
    });
    fireEvent.click(screen.getByRole("button", { name: "却下…" }));
    fireEvent.click(screen.getByRole("button", { name: "やめる" }));
    expect(posts(calls)).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "却下…" }));
    fireEvent.click(screen.getByRole("button", { name: "却下する" }));
    const result = await screen.findByRole("status", { name: "操作の結果" });
    expect(posts(calls)).toEqual([["/admin/reservations/res-pending-1/reject", {}]]);
    expect(result.textContent).toContain("却下のお知らせ");
  });

  it("取消：キャンセル料を見せて確かめてから送り、作った下書きを出す", async () => {
    const { calls } = await openDetail(firm(), {
      status: 200,
      body: accepted([
        {
          kind: "cancellation",
          reservationId: "res-firm-1",
          cancellationFee: { ratePercent: 50, fee: Yen.parse(5_500) },
        },
        { kind: "bring-forward-notice", reservationId: "res-second-1" },
      ]),
    });
    fireEvent.click(screen.getByRole("button", { name: "取消…" }));
    const confirm = screen.getByRole("group", { name: "取消の確認" });
    expect(confirm.textContent).toContain("今取消したときのキャンセル料は 5,500円（50%）です。");
    expect(posts(calls)).toEqual([]);

    fireEvent.click(within(confirm).getByRole("button", { name: "取消する" }));
    const result = await screen.findByRole("status", { name: "操作の結果" });
    expect(posts(calls)).toEqual([["/admin/reservations/res-firm-1/cancel", {}]]);
    const items = within(result)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(items).toEqual([
      "取消のお知らせ、あて先の予約：この予約、キャンセル料 5,500円（50%）",
      "第二キープの前倒しの案内、あて先の予約：res-second-1",
    ]);
    expect(within(result).getByRole("link", { name: "res-second-1" }).getAttribute("href")).toBe(
      "#/reservations/res-second-1",
    );
  });

  it("昇格・繰り上げ：そのまま送る", async () => {
    const promote = await openDetail(
      detailResponse({ status: "provisional", currentEstimate: undefined }),
    );
    fireEvent.click(screen.getByRole("button", { name: "本予約に昇格する" }));
    await screen.findByRole("status", { name: "操作の結果" });
    expect(posts(promote.calls)).toEqual([["/admin/reservations/res-pending-1/promote", {}]]);
    cleanup();

    const moveUp = await openDetail(
      detailResponse({ status: "second-hold", currentEstimate: undefined }),
      {
        status: 200,
        body: accepted([]),
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "仮予約に繰り上げる" }));
    await screen.findByRole("status", { name: "操作の結果" });
    expect(posts(moveUp.calls)).toEqual([["/admin/reservations/res-pending-1/move-up", {}]]);
  });

  it("できなかったとき（409・422 など）は、理由を日本語で出す", async () => {
    const cases: [FakeResponse, string][] = [
      [{ status: 409, body: { error: "not-pending" } }, "承認待ちではないため"],
      [{ status: 409, body: { error: "still-held" } }, "繰り上げられません"],
      [{ status: 503, body: { error: "busy" } }, "混み合っています"],
      [{ status: 500, body: undefined }, "API から思わぬ返事がありました（HTTP 500）"],
    ];
    for (const [response, message] of cases) {
      await openDetail(detailResponse(), response);
      fireEvent.click(screen.getByRole("button", { name: "承認する" }));
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("承認できませんでした。");
      expect(alert.textContent).toContain(message);
      expect(screen.queryByRole("status", { name: "操作の結果" })).toBeNull();
      cleanup();
    }
  });
});
