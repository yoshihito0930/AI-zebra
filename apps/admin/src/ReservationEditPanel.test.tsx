// @vitest-environment jsdom
import { Yen, type AdminReservationDetail } from "@zebra/contracts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReservationDetailPage } from "./ReservationDetailPage.tsx";
import { accepted, detailResponse, fakeApi, type FakeResponse } from "./test-support.ts";

afterEach(() => {
  cleanup();
});

type Call = { method: string; url: string; body: unknown };

/**
 * 詳細を返し、書く操作（POST・PUT）には responses を順に返す API で、詳細の画面を開く。
 * 書いたあとの詳細の読み直しには detailAfter を返す
 */
const openDetail = async (
  detail: AdminReservationDetail,
  responses: FakeResponse[] = [{ status: 200, body: accepted([]) }],
  detailAfter: AdminReservationDetail = detail,
) => {
  let writes = 0;
  const fake = fakeApi(({ method, url }) => {
    if (method !== "GET") {
      const response = responses[Math.min(writes, responses.length - 1)];
      writes += 1;
      if (response === undefined) throw new Error("返事を用意していない");
      return response;
    }
    // 予約の下書きの一覧（詳細の中と、操作の結果の下書きを開くリンク）は空
    if (url.endsWith("/drafts")) return { status: 200, body: { drafts: [] } };
    return { status: 200, body: writes > 0 ? detailAfter : detail };
  });
  render(<ReservationDetailPage api={fake.api} reservationId={detail.id} />);
  await screen.findByRole("heading", { name: "予約の内容" });
  return fake;
};

const writes = (calls: Call[]) =>
  calls.filter((c) => c.method !== "GET").map((c) => [c.method, c.url, c.body]);

/** 本予約 11/20 13:00〜15:00、3人、プランA、機材保険なし、オプションなし、確定金額 11,000円 */
const firm = (overrides: Partial<AdminReservationDetail> = {}): AdminReservationDetail =>
  detailResponse({
    id: "res-firm-1",
    status: "firm",
    start: "2026-11-20T13:00:00.000+09:00",
    end: "2026-11-20T15:00:00.000+09:00",
    partySize: 3,
    equipmentInsurance: false,
    optionIds: [],
    estimate: {
      subtotalExcludingTax: Yen.parse(10_000),
      estimateIncludingTax: Yen.parse(11_000),
    },
    confirmedPrice: Yen.parse(11_000),
    currentEstimate: undefined,
    cancellationFeeIfCancelledNow: { ratePercent: 50, fee: Yen.parse(5_500) },
    ...overrides,
  });

const editPanel = () => screen.getByRole("region", { name: "直す" });

const openChangeForm = () => {
  fireEvent.click(within(editPanel()).getByRole("button", { name: "予約を変更…" }));
  return screen.getByRole("form", { name: "予約の変更" });
};

describe("詳細から直す：出すもの", () => {
  it("変更とバッファの切り替えは承認済みの仮予約・本予約だけ。お客様の情報はどの状態でも直せる", async () => {
    const editButtons = async (detail: AdminReservationDetail) => {
      await openDetail(detail);
      const names = within(editPanel())
        .queryAllByRole("button")
        .map((b) => b.textContent);
      cleanup();
      return names;
    };
    const withBuffer = ["予約を変更…", "お客様の情報・撮影の内容を直す…", "切り替える"];
    const customerOnly = ["お客様の情報・撮影の内容を直す…"];
    expect(await editButtons(firm())).toEqual(withBuffer);
    expect(await editButtons(firm({ status: "provisional" }))).toEqual(withBuffer);
    expect(await editButtons(detailResponse())).toEqual(customerOnly);
    expect(
      await editButtons(firm({ status: "second-hold", provisionalIds: ["res-prov-1"] })),
    ).toEqual(customerOnly);
    expect(
      await editButtons(firm({ status: "cancelled", cancellationFeeIfCancelledNow: undefined })),
    ).toEqual(customerOnly);
  });
});

describe("予約の変更", () => {
  it("初期値は今の予約の値（日時は JST）。人数だけを変えても、今の日時を送る", async () => {
    const { calls } = await openDetail(firm(), [
      { status: 200, body: accepted([{ kind: "change", reservationId: "res-firm-1" }]) },
    ]);
    const form = openChangeForm();
    expect(within(form).getByLabelText("開始（JST）")).toHaveProperty("value", "2026-11-20T13:00");
    expect(within(form).getByLabelText("終わり（JST）")).toHaveProperty(
      "value",
      "2026-11-20T15:00",
    );
    expect(within(form).getByLabelText("人数")).toHaveProperty("value", "3");
    expect(within(form).getByLabelText("確定金額（税込・円）")).toHaveProperty("value", "11000");
    expect(within(form).getByRole("note", { name: "見積" }).textContent).toBe(
      "見積（今の料金表）：11,000円（税込。税抜 10,000円）・プランA",
    );

    fireEvent.change(within(form).getByLabelText("人数"), { target: { value: "4" } });
    fireEvent.click(within(form).getByRole("button", { name: "変更する" }));
    const result = await screen.findByRole("status", { name: "操作の結果" });
    expect(writes(calls)).toEqual([
      [
        "POST",
        "/admin/reservations/res-firm-1/change",
        {
          start: "2026-11-20T13:00:00.000+09:00",
          end: "2026-11-20T15:00:00.000+09:00",
          partySize: 4,
          cycloramaFloorProtection: false,
          equipmentInsurance: false,
          optionIds: [],
          confirmedPrice: 11_000,
        },
      ],
    ]);
    expect(result.textContent).toContain("予約を変更しました。");
    expect(result.textContent).toContain("変更のお知らせ、あて先の予約：この予約");
    // 成功したら詳細を読み直し、フォームを閉じる
    expect(calls.filter((c) => c.method === "GET" && !c.url.endsWith("/drafts"))).toHaveLength(2);
    expect(screen.queryByRole("form", { name: "予約の変更" })).toBeNull();
  });

  it("何も変えずに送ろうとしたら、送らずに知らせる（変更のお知らせの下書きを作らないため）。確定金額だけを変えれば送る", async () => {
    const { calls } = await openDetail(firm());
    const form = openChangeForm();
    fireEvent.click(within(form).getByRole("button", { name: "変更する" }));
    expect(screen.getByRole("alert").textContent).toBe("変えたところがありません。");
    expect(writes(calls)).toEqual([]);

    fireEvent.change(within(form).getByLabelText("確定金額（税込・円）"), {
      target: { value: "10000" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "変更する" }));
    await screen.findByRole("status", { name: "操作の結果" });
    expect(writes(calls)).toEqual([
      [
        "POST",
        "/admin/reservations/res-firm-1/change",
        {
          start: "2026-11-20T13:00:00.000+09:00",
          end: "2026-11-20T15:00:00.000+09:00",
          partySize: 3,
          cycloramaFloorProtection: false,
          equipmentInsurance: false,
          optionIds: [],
          confirmedPrice: 10_000,
        },
      ],
    ]);
  });

  it("内容を変えると、見積を計算し直して確定金額の初期値にする（booking.md の延長の例：16,500円）", async () => {
    const { calls } = await openDetail(firm());
    const form = openChangeForm();
    fireEvent.change(within(form).getByLabelText("終わり（JST）"), {
      target: { value: "2026-11-20T16:00" },
    });
    expect(within(form).getByRole("note", { name: "見積" }).textContent).toContain("16,500円");
    expect(within(form).getByLabelText("確定金額（税込・円）")).toHaveProperty("value", "16500");

    fireEvent.click(within(form).getByLabelText("機材保険"));
    fireEvent.click(within(form).getByLabelText("6人以上のワークショップでの利用"));
    expect(within(form).getByLabelText("確定金額（税込・円）")).toHaveProperty("value", "19800");

    // 管理者が直した確定金額は、内容を変えても見積で上書きしない
    fireEvent.change(within(form).getByLabelText("確定金額（税込・円）"), {
      target: { value: "18000" },
    });
    fireEvent.change(within(form).getByLabelText("人数"), { target: { value: "4" } });
    expect(within(form).getByLabelText("確定金額（税込・円）")).toHaveProperty("value", "18000");

    fireEvent.click(within(form).getByRole("button", { name: "変更する" }));
    await screen.findByRole("status", { name: "操作の結果" });
    expect(writes(calls)).toEqual([
      [
        "POST",
        "/admin/reservations/res-firm-1/change",
        {
          start: "2026-11-20T13:00:00.000+09:00",
          end: "2026-11-20T16:00:00.000+09:00",
          partySize: 4,
          cycloramaFloorProtection: false,
          equipmentInsurance: true,
          optionIds: ["workshop"],
          confirmedPrice: 18_000,
        },
      ],
    ]);
  });

  it("警告（409）を日本語で見せ、確かめたらその警告の一覧を付けて送り直す", async () => {
    const { calls } = await openDetail(firm(), [
      {
        status: 409,
        body: {
          error: "unacknowledged-warnings",
          warnings: ["past-24-hours-before-start", "late-night-shorter-than-4-hours"],
        },
      },
      { status: 200, body: accepted([{ kind: "change", reservationId: "res-firm-1" }]) },
    ]);
    const form = openChangeForm();
    fireEvent.change(within(form).getByLabelText("開始（JST）"), {
      target: { value: "2026-11-16T03:00" },
    });
    fireEvent.change(within(form).getByLabelText("終わり（JST）"), {
      target: { value: "2026-11-16T05:00" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "変更する" }));

    const confirm = await screen.findByRole("group", { name: "警告の確認" });
    expect(
      within(confirm)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      "本予約の締め切り（開始の24時間前）を過ぎています",
      "深夜帯にかかり、4時間より短い予約です",
    ]);
    expect(screen.queryByRole("status", { name: "操作の結果" })).toBeNull();

    fireEvent.click(within(confirm).getByRole("button", { name: "警告を確かめたうえで変更する" }));
    await screen.findByRole("status", { name: "操作の結果" });
    const posted = writes(calls).map(([, , body]) => body as Record<string, unknown>);
    expect(posted).toHaveLength(2);
    // 1回目は確認なし、2回目は返った警告の一覧を付ける。ほかの欄は同じ
    expect(posted[0]).not.toHaveProperty("acknowledgedWarnings");
    expect(posted[1]).toEqual({
      ...posted[0],
      acknowledgedWarnings: ["past-24-hours-before-start", "late-night-shorter-than-4-hours"],
    });
    expect(posted[0]).toMatchObject({
      start: "2026-11-16T03:00:00.000+09:00",
      end: "2026-11-16T05:00:00.000+09:00",
    });
  });

  it("警告を見せたあとに入力を直したら、警告を消して、次は確認なしで送る", async () => {
    const { calls } = await openDetail(firm(), [
      {
        status: 409,
        body: { error: "unacknowledged-warnings", warnings: ["past-24-hours-before-start"] },
      },
      { status: 200, body: accepted([]) },
    ]);
    const form = openChangeForm();
    fireEvent.change(within(form).getByLabelText("開始（JST）"), {
      target: { value: "2026-11-16T13:00" },
    });
    fireEvent.change(within(form).getByLabelText("終わり（JST）"), {
      target: { value: "2026-11-16T15:00" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "変更する" }));
    await screen.findByRole("group", { name: "警告の確認" });

    fireEvent.change(within(form).getByLabelText("人数"), { target: { value: "5" } });
    expect(screen.queryByRole("group", { name: "警告の確認" })).toBeNull();
    fireEvent.click(within(form).getByRole("button", { name: "変更する" }));
    await screen.findByRole("status", { name: "操作の結果" });
    const posted = writes(calls).map(([, , body]) => body as Record<string, unknown>);
    expect(posted[1]).not.toHaveProperty("acknowledgedWarnings");
    expect(posted[1]).toMatchObject({ partySize: 5 });
  });

  it("不可（422）は理由を出して止める。送り直すボタンは出さない", async () => {
    await openDetail(firm(), [{ status: 422, body: { error: "overlaps-existing" } }]);
    const form = openChangeForm();
    fireEvent.change(within(form).getByLabelText("終わり（JST）"), {
      target: { value: "2026-11-20T16:30" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "変更する" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "変更できませんでした。ほかの予約・ブロック枠と重なっています。",
    );
    expect(screen.queryByRole("group", { name: "警告の確認" })).toBeNull();
    expect(screen.queryByRole("status", { name: "操作の結果" })).toBeNull();
  });

  it("入力が正しくなければ、送らずに知らせる", async () => {
    const { calls } = await openDetail(firm());
    const form = openChangeForm();
    fireEvent.change(within(form).getByLabelText("人数"), { target: { value: "0" } });
    fireEvent.change(within(form).getByLabelText("確定金額（税込・円）"), {
      target: { value: "1万" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "変更する" }));
    expect(screen.getByRole("alert").textContent).toBe(
      "人数は、1〜100の整数で入れてください。確定金額は、0以上の整数（円）で入れてください。",
    );
    expect(writes(calls)).toEqual([]);
  });

  it("やめれば送らずに閉じる", async () => {
    const { calls } = await openDetail(firm());
    const form = openChangeForm();
    fireEvent.click(within(form).getByRole("button", { name: "やめる" }));
    expect(screen.queryByRole("form", { name: "予約の変更" })).toBeNull();
    expect(writes(calls)).toEqual([]);
  });
});

describe("バッファの切り替え", () => {
  it("30分に切り替え、成功したら作った下書きの一覧を出す", async () => {
    const { calls } = await openDetail(
      firm({ status: "provisional" }),
      [
        {
          status: 200,
          body: accepted([
            {
              kind: "move-up-notice",
              reservationId: "res-second-1",
              remainingProvisionalIds: [],
            },
          ]),
        },
      ],
      firm({ status: "provisional", bufferMinutes: 30 }),
    );
    const form = screen.getByRole("form", { name: "バッファの切り替え" });
    const button = within(form).getByRole("button", { name: "切り替える" });
    // 今と同じバッファでは押せない
    expect(button).toHaveProperty("disabled", true);
    fireEvent.change(within(form).getByLabelText("予約の後ろのバッファ"), {
      target: { value: "30" },
    });
    fireEvent.click(button);

    const result = await screen.findByRole("status", { name: "操作の結果" });
    expect(writes(calls)).toEqual([
      ["POST", "/admin/reservations/res-firm-1/buffer", { bufferMinutes: 30 }],
    ]);
    expect(result.textContent).toContain("バッファを30分にしました。");
    expect(
      within(result)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      "第二キープの繰り上げの案内、あて先の予約：res-second-1、残っている仮予約なし（繰り上げられます）",
    ]);
    // 読み直した詳細のバッファ
    await vi.waitFor(() =>
      expect(calls.filter((c) => c.method === "GET" && !c.url.endsWith("/drafts"))).toHaveLength(2),
    );
    const bufferTerm = screen.getByText("バッファ", { selector: "dt" });
    expect(bufferTerm.nextElementSibling?.textContent).toBe("30分");
  });

  it("下書きがなければ、ないと出す", async () => {
    await openDetail(firm({ bufferMinutes: 30 }), [{ status: 200, body: accepted([]) }]);
    const form = screen.getByRole("form", { name: "バッファの切り替え" });
    fireEvent.change(within(form).getByLabelText("予約の後ろのバッファ"), {
      target: { value: "60" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "切り替える" }));
    const result = await screen.findByRole("status", { name: "操作の結果" });
    expect(result.textContent).toContain("バッファを1時間にしました。");
    expect(result.textContent).toContain("作ったメールの下書きはありません。");
  });

  it("1時間に戻せない（422）ときは理由を出す", async () => {
    await openDetail(firm({ bufferMinutes: 30 }), [
      { status: 422, body: { error: "overlaps-existing" } },
    ]);
    const form = screen.getByRole("form", { name: "バッファの切り替え" });
    fireEvent.change(within(form).getByLabelText("予約の後ろのバッファ"), {
      target: { value: "60" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "切り替える" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "バッファを切り替えられませんでした。ほかの予約・ブロック枠と重なっています。",
    );
  });
});

describe("お客様の情報・撮影の内容を直す", () => {
  const openCustomerForm = () => {
    fireEvent.click(
      within(editPanel()).getByRole("button", { name: "お客様の情報・撮影の内容を直す…" }),
    );
    return screen.getByRole("form", { name: "お客様の情報・撮影の内容を直す" });
  };

  it("初期値は今の値。全部の欄を送って置き換え、空にした欄は送らない", async () => {
    const { calls } = await openDetail(detailResponse(), [{ status: 200 }]);
    const form = openCustomerForm();
    expect(within(form).getByLabelText("氏名（必須）")).toHaveProperty("value", "架空 花子");
    expect(within(form).getByLabelText("スチール撮影")).toHaveProperty("checked", true);

    fireEvent.change(within(form).getByLabelText("電話番号"), {
      target: { value: "080-0000-0002" },
    });
    fireEvent.change(within(form).getByLabelText("会社名"), { target: { value: "" } });
    fireEvent.click(within(form).getByLabelText("ムービー撮影"));
    fireEvent.change(within(form).getByLabelText("補足事項"), {
      target: { value: "  搬入は裏口から  " },
    });
    fireEvent.click(within(form).getByRole("button", { name: "直す" }));

    const result = await screen.findByRole("status", { name: "操作の結果" });
    expect(writes(calls)).toEqual([
      [
        "PUT",
        "/admin/reservations/res-pending-1/customer",
        {
          customer: { name: "架空 花子", email: "hanako@example.com", phone: "080-0000-0002" },
          shooting: { types: ["still"], details: "商品撮影", notes: "搬入は裏口から" },
        },
      ],
    ]);
    // 下書きは作らないので、下書きの一覧は出さない
    expect(result.textContent).toBe("お客様の情報・撮影の内容を直しました。");
    expect(screen.queryByRole("form", { name: "お客様の情報・撮影の内容を直す" })).toBeNull();
  });

  it("取消した予約でも直せる", async () => {
    const { calls } = await openDetail(
      firm({ status: "cancelled", cancellationFeeIfCancelledNow: undefined }),
      [{ status: 200 }],
    );
    const form = openCustomerForm();
    fireEvent.click(within(form).getByRole("button", { name: "直す" }));
    await screen.findByRole("status", { name: "操作の結果" });
    expect(writes(calls).map(([method, url]) => [method, url])).toEqual([
      ["PUT", "/admin/reservations/res-firm-1/customer"],
    ]);
  });

  it("連絡先が1つもない・氏名がないときは、送らずに知らせる", async () => {
    const { calls } = await openDetail(detailResponse());
    const form = openCustomerForm();
    for (const label of ["氏名（必須）", "メールアドレス", "電話番号"]) {
      fireEvent.change(within(form).getByLabelText(label), { target: { value: " " } });
    }
    fireEvent.click(within(form).getByRole("button", { name: "直す" }));
    expect(screen.getByRole("alert").textContent).toBe(
      "氏名を入れてください。電話番号かメールアドレスのどちらか1つを入れてください。",
    );
    expect(writes(calls)).toEqual([]);
  });

  it("API が断ったときは理由を出す", async () => {
    await openDetail(detailResponse(), [{ status: 404, body: { error: "not-found" } }]);
    const form = openCustomerForm();
    fireEvent.click(within(form).getByRole("button", { name: "直す" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "直せませんでした。予約が見つかりません。",
    );
  });
});
