// @vitest-environment jsdom
// 予約ウィジェットの画面のテスト。公開 API は fetch のモックで返し、呼んだ URL と本文を確かめる。
// 氏名・連絡先は架空のもの（公開リポジトリのため）
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DateTime } from "luxon";
import { afterEach, describe, expect, it } from "vitest";
import { BookingWidget } from "./BookingWidget.tsx";
import { calendarBody, fakeApi, type FakeRequest, type FakeResponse } from "./test-support.ts";

// 今は 2026-11-15 10:00（JST）
const now = () => DateTime.fromISO("2026-11-15T10:00:00+09:00");

const NOVEMBER = "/public/calendar?from=2026-11-01&to=2026-11-30";
const DECEMBER = "/public/calendar?from=2026-12-01&to=2026-12-31";

type Bookings = Parameters<typeof calendarBody>[2];

/** 予約状況は月ごとに bookings を返し、申込は onApply が返す */
const handlerOf =
  (bookings: Bookings = {}, onApply?: (request: FakeRequest) => FakeResponse) =>
  (request: FakeRequest): FakeResponse => {
    if (request.method === "POST") {
      return onApply?.(request) ?? { status: 500 };
    }
    const url = new URL(request.url, "http://localhost");
    return {
      status: 200,
      body: calendarBody(
        url.searchParams.get("from") ?? "",
        url.searchParams.get("to") ?? "",
        bookings,
      ),
    };
  };

const renderWidget = (handler: (request: FakeRequest) => FakeResponse | Promise<FakeResponse>) => {
  const fake = fakeApi(handler);
  const view = render(<BookingWidget api={fake.api} now={now} />);
  return { ...fake, ...view };
};

const cellOf = (container: HTMLElement, date: string) => {
  const cell = container.querySelector(`[data-date="${date}"]`);
  if (!(cell instanceof HTMLElement)) throw new Error(`${date} のマスがない`);
  return cell;
};

const itemsOf = (element: HTMLElement) =>
  within(element)
    .queryAllByRole("listitem")
    .map((item) => item.textContent);

afterEach(() => {
  cleanup();
});

describe("月のカレンダー", () => {
  it("読み込み中を出し、今月（JST）の予約状況を読む", async () => {
    const { calls } = renderWidget(handlerOf());
    expect(screen.getByRole("status").textContent).toBe("予約状況を読み込んでいます…");
    expect(screen.getByText("2026年11月")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("予約状況を読み込んでいます…")).toBeNull());
    expect(calls.map((call) => call.url)).toEqual([NOVEMBER]);
  });

  it("日ごとに、表示名と時間を時間の早い順に並べる（表示名と時間のほかは出さない）", async () => {
    const { container } = renderWidget(
      handlerOf({
        "2026-11-20": [
          // わざと順番を崩して返す
          {
            label: "unavailable",
            start: "2026-11-20T18:00:00+09:00",
            end: "2026-11-20T22:00:00+09:00",
          },
          {
            label: "provisional",
            start: "2026-11-20T09:00:00+09:00",
            end: "2026-11-20T12:00:00+09:00",
          },
          { label: "firm", start: "2026-11-20T14:00:00+09:00", end: "2026-11-20T17:00:00+09:00" },
        ],
      }),
    );
    await screen.findByText("仮予約 9:00-12:00");
    const cell = cellOf(container, "2026-11-20");
    expect(itemsOf(cell)).toEqual([
      "仮予約 9:00-12:00",
      "本予約 14:00-17:00",
      "予約不可 18:00-22:00",
    ]);
    expect(cell.textContent).toBe("20仮予約 9:00-12:00本予約 14:00-17:00予約不可 18:00-22:00");
    expect(within(cell).queryByText(/他/)).toBeNull();
    expect(itemsOf(cellOf(container, "2026-11-21"))).toEqual([]);
  });

  it("日をまたぐ予約は、かかる日それぞれに出す", async () => {
    const overnight = {
      label: "firm",
      start: "2026-11-20T22:00:00+09:00",
      end: "2026-11-21T02:00:00+09:00",
    };
    const { container } = renderWidget(
      handlerOf({ "2026-11-20": [overnight], "2026-11-21": [overnight] }),
    );
    await screen.findByText("本予約 22:00-11/21 2:00");
    expect(itemsOf(cellOf(container, "2026-11-21"))).toEqual(["本予約 11/20 22:00-2:00"]);
  });

  it("各日のマスには3件まで出し、残りは「他○件」。押すとその日の予約をすべて並べた一覧を開く", async () => {
    const at = (hour: string, endHour: string, label = "firm") => ({
      label,
      start: `2026-11-20T${hour}:00+09:00`,
      end: `2026-11-20T${endHour}:00+09:00`,
    });
    const { container } = renderWidget(
      handlerOf({
        "2026-11-20": [
          at("19:00", "21:00", "unavailable"),
          at("01:00", "05:00"),
          at("13:00", "15:00", "provisional"),
          at("07:00", "09:00", "second-hold"),
          at("10:00", "12:00"),
        ],
      }),
    );
    await screen.findByText("本予約 1:00-5:00");
    const cell = cellOf(container, "2026-11-20");
    expect(itemsOf(cell)).toEqual([
      "本予約 1:00-5:00",
      "第二キープ 7:00-9:00",
      "本予約 10:00-12:00",
    ]);

    const more = within(cell).getByRole("button", {
      name: "11月20日(金)の予約をすべて見る（他2件）",
    });
    expect(more.textContent).toBe("他2件");
    fireEvent.click(more);

    const dialog = screen.getByRole("dialog", { name: "11月20日(金)の予約" });
    expect(itemsOf(dialog)).toEqual([
      "本予約 1:00-5:00",
      "第二キープ 7:00-9:00",
      "本予約 10:00-12:00",
      "仮予約 13:00-15:00",
      "予約不可 19:00-21:00",
    ]);
    fireEvent.click(within(dialog).getByRole("button", { name: "閉じる" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("次の月・前の月へ移る。今月より前には戻らない", async () => {
    const { calls } = renderWidget(handlerOf());
    await waitFor(() => expect(screen.queryByText("予約状況を読み込んでいます…")).toBeNull());
    const previous = screen.getByRole("button", { name: "← 前の月" }) as HTMLButtonElement;
    expect(previous.disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "次の月 →" }));
    expect(screen.getByText("2026年12月")).toBeTruthy();
    await waitFor(() => expect(calls.at(-1)?.url).toBe(DECEMBER));
    expect(previous.disabled).toBe(false);

    fireEvent.click(previous);
    expect(screen.getByText("2026年11月")).toBeTruthy();
    await waitFor(() => expect(calls.at(-1)?.url).toBe(NOVEMBER));
  });

  it("読めなければエラーを出し、もう一度読める", async () => {
    let fail = true;
    const { calls } = renderWidget((request) => (fail ? { status: 500 } : handlerOf()(request)));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "予約状況を読み込めませんでした",
    );
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "もう一度読み込む" }));
    await waitFor(() => expect(screen.queryByText(/予約状況を読み込めませんでした/)).toBeNull());
    expect(calls.map((call) => call.url)).toEqual([NOVEMBER, NOVEMBER]);
  });

  it("第二キープは「仮予約」と重なるときだけであること、予約の間は1時間空けることを、カレンダーとフォームで案内する", async () => {
    renderWidget(handlerOf());
    expect(
      screen.getAllByText(
        "第二キープを申込めるのは、カレンダーの「仮予約」の時間と重なるときだけです。",
      ),
    ).toHaveLength(2);
    expect(screen.getAllByText(/予約と予約の間は1時間空けてください/)).toHaveLength(2);
    await waitFor(() => expect(screen.queryByText("予約状況を読み込んでいます…")).toBeNull());
  });

  it("日付を押すと、申込フォームの利用日になる", async () => {
    const { container } = renderWidget(handlerOf());
    await waitFor(() => expect(screen.queryByText("予約状況を読み込んでいます…")).toBeNull());
    fireEvent.click(
      within(cellOf(container, "2026-11-25")).getByRole("button", {
        name: "11月25日(水)を利用日に選ぶ",
      }),
    );
    expect((screen.getByLabelText(/^利用日/) as HTMLInputElement).value).toBe("2026-11-25");
  });
});

/** 申込フォームを、2026-11-25 10:00〜12:00・3人・養生なしの本予約で埋める */
function fillForm(
  overrides: {
    date?: string;
    start?: string;
    end?: string;
    kind?: "本予約" | "仮予約" | null;
  } = {},
) {
  fireEvent.change(screen.getByLabelText(/^利用日/), {
    target: { value: overrides.date ?? "2026-11-25" },
  });
  fireEvent.change(screen.getByLabelText(/^開始/), {
    target: { value: overrides.start ?? "10:00" },
  });
  fireEvent.change(screen.getByLabelText(/^終了/), { target: { value: overrides.end ?? "12:00" } });
  if (overrides.kind !== null) {
    fireEvent.click(screen.getByLabelText(new RegExp(`^${overrides.kind ?? "本予約"}`)));
  }
  fireEvent.change(screen.getByLabelText(/^ご利用人数/), { target: { value: "3" } });
  fireEvent.click(screen.getByLabelText("なし"));
  fireEvent.click(screen.getByLabelText("スチール撮影"));
  fireEvent.change(screen.getByLabelText(/^撮影詳細/), { target: { value: "商品撮影" } });
  fireEvent.change(screen.getByLabelText(/^氏名/), { target: { value: "架空 太郎" } });
  fireEvent.change(screen.getByLabelText(/^メールアドレス/), {
    target: { value: "taro@example.com" },
  });
  fireEvent.change(screen.getByLabelText(/^電話番号/), { target: { value: "090-0000-0000" } });
  fireEvent.change(screen.getByLabelText(/^住所/), { target: { value: "東京都架空区1-2-3" } });
  fireEvent.change(screen.getByLabelText(/^カメラマン氏名/), { target: { value: "架空 次郎" } });
  fireEvent.click(screen.getByLabelText(/ホリゾントルールを確認しました/));
  fireEvent.click(screen.getByLabelText(/利用規約に同意します/));
}

const submitButton = () => screen.getByRole("button", { name: /申込む$/ }) as HTMLButtonElement;

const accepted = (): FakeResponse => ({
  status: 201,
  body: { receiptNumber: "ABCD2345", estimateIncludingTax: 11_000 },
});

describe("申込フォーム", () => {
  it("入力に応じて見積額（税込）を出す", async () => {
    renderWidget(handlerOf());
    expect(screen.getByText(/利用日時・人数・ホリゾントの養生を選ぶと表示します/)).toBeTruthy();
    fillForm();
    expect(screen.getByText("ご利用：11/25(水) 10:00〜12:00（2時間）")).toBeTruthy();
    expect(screen.getByText("11,000円")).toBeTruthy();
    expect(screen.getByText(/プランA/)).toBeTruthy();

    // 機材保険とオプションを足すと変わる（10,000 + 1,000 + 2,000 = 13,000 → 14,300）
    fireEvent.click(screen.getByLabelText("機材保険を付ける"));
    fireEvent.click(screen.getByLabelText("6人以上のワークショップでの利用"));
    expect(screen.getByText("14,300円")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("予約状況を読み込んでいます…")).toBeNull());
  });

  it("契約の形の本文を送り、受け付けたら受付番号と見積額を出して、カレンダーを読み直す", async () => {
    const { calls } = renderWidget(handlerOf({}, accepted));
    await waitFor(() => expect(screen.queryByText("予約状況を読み込んでいます…")).toBeNull());
    fillForm();
    fireEvent.change(screen.getByLabelText(/^会社名/), {
      target: { value: "架空スタジオ株式会社" },
    });
    fireEvent.click(submitButton());

    expect(await screen.findByRole("heading", { name: "お申込みを受け付けました" })).toBeTruthy();
    expect(screen.getByText("ABCD2345")).toBeTruthy();
    expect(screen.getByText("11,000円")).toBeTruthy();

    const posts = calls.filter((call) => call.method === "POST");
    expect(posts.map((call) => call.url)).toEqual(["/public/applications"]);
    expect(posts[0]?.body).toEqual({
      kind: "firm",
      start: "2026-11-25T10:00:00+09:00",
      end: "2026-11-25T12:00:00+09:00",
      partySize: 3,
      cycloramaFloorProtection: false,
      equipmentInsurance: false,
      optionIds: [],
      customer: {
        name: "架空 太郎",
        companyName: "架空スタジオ株式会社",
        email: "taro@example.com",
        phone: "090-0000-0000",
        address: "東京都架空区1-2-3",
        photographerName: "架空 次郎",
      },
      shooting: { types: ["still"], details: "商品撮影" },
      agreedToCycloramaRules: true,
      agreedToTerms: true,
    });
    await waitFor(() =>
      expect(calls.filter((call) => call.method === "GET").map((call) => call.url)).toEqual([
        NOVEMBER,
        NOVEMBER,
      ]),
    );
  });

  it("日をまたぐ利用は、終了を翌日の日時（オフセット付き）で送る", async () => {
    const { calls } = renderWidget(handlerOf({}, accepted));
    fillForm({ start: "22:00", end: "02:00" });
    expect(screen.getByText("ご利用：11/25(水) 22:00〜11/26(木) 2:00（4時間）")).toBeTruthy();
    fireEvent.click(submitButton());
    await screen.findByRole("heading", { name: "お申込みを受け付けました" });
    const post = calls.find((call) => call.method === "POST")?.body as {
      start: string;
      end: string;
    };
    expect([post.start, post.end]).toEqual([
      "2026-11-25T22:00:00+09:00",
      "2026-11-26T02:00:00+09:00",
    ]);
  });

  it("断られたら理由を日本語で出す", async () => {
    renderWidget(handlerOf({}, () => ({ status: 422, body: { error: "overlaps-existing" } })));
    fillForm();
    fireEvent.click(submitButton());
    expect(
      await screen.findByText(
        "ご希望の時間は、ほかの予約と重なっています（予約と予約の間は1時間空けます）。カレンダーで空いている時間をお選びください。",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "お申込みを受け付けました" })).toBeNull();
  });

  it("混み合っている（busy）・届かないときも知らせる", async () => {
    renderWidget(handlerOf({}, () => ({ status: 503, body: { error: "busy" } })));
    fillForm();
    fireEvent.click(submitButton());
    expect(await screen.findByText(/ただいま混み合っています/)).toBeTruthy();
    cleanup();

    renderWidget(handlerOf({}, () => ({ status: 502 })));
    fillForm();
    fireEvent.click(submitButton());
    expect(await screen.findByText(/送信できませんでした/)).toBeTruthy();
  });

  it("ホリゾントルールの確認と利用規約への同意がないと送信できない", async () => {
    renderWidget(handlerOf({}, accepted));
    fillForm();
    expect(submitButton().disabled).toBe(false);
    fireEvent.click(screen.getByLabelText(/利用規約に同意します/));
    expect(submitButton().disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/利用規約に同意します/));
    fireEvent.click(screen.getByLabelText(/ホリゾントルールを確認しました/));
    expect(submitButton().disabled).toBe(true);
    await waitFor(() => expect(screen.queryByText("予約状況を読み込んでいます…")).toBeNull());
  });

  it("足りない・正しくない欄があれば、送らずに欄の名前を出す", async () => {
    const { calls } = renderWidget(handlerOf({}, accepted));
    fillForm();
    fireEvent.change(screen.getByLabelText(/^メールアドレス/), {
      target: { value: "taro.example.com" },
    });
    fireEvent.change(screen.getByLabelText(/^氏名/), { target: { value: "  " } });
    fireEvent.click(submitButton());
    const alert = await screen.findByText("入力が足りない・正しくない欄があります。");
    expect(itemsOf(alert.parentElement as HTMLElement)).toEqual(["氏名", "メールアドレス"]);
    expect(calls.filter((call) => call.method === "POST")).toEqual([]);
  });

  it("利用時間の決まりに合わない日時は、送る前に知らせて送信できない", async () => {
    renderWidget(handlerOf({}, accepted));
    fillForm({ start: "03:00", end: "05:00" });
    expect(
      screen.getByText("深夜帯（23:00〜翌8:00）に少しでもかかるご利用は、4時間からです。"),
    ).toBeTruthy();
    expect(submitButton().disabled).toBe(true);
    await waitFor(() => expect(screen.queryByText("予約状況を読み込んでいます…")).toBeNull());
  });

  it("仮予約の期限（利用日の7日前の18:00）を過ぎた日時では、仮予約は選べない", async () => {
    renderWidget(handlerOf());
    // 11/22 の仮予約の期限は 11/15 18:00（今は 11/15 10:00）→ 選べる
    fillForm({ date: "2026-11-22", kind: "仮予約" });
    const provisional = screen.getByLabelText(/^仮予約/) as HTMLInputElement;
    expect(provisional.disabled).toBe(false);
    expect(provisional.parentElement?.textContent).toBe("仮予約（期限 11/15(日) 18:00）");
    // 11/21 の仮予約の期限は 11/14 18:00 → 過ぎている
    fireEvent.change(screen.getByLabelText(/^利用日/), { target: { value: "2026-11-21" } });
    expect(provisional.disabled).toBe(true);
    expect(provisional.parentElement?.textContent).toBe(
      "仮予約（期限 11/14(土) 18:00を過ぎたため選べません）",
    );
    expect(screen.getByText(/仮予約の期限（利用日の7日前の18:00）を過ぎているため/)).toBeTruthy();
    expect(submitButton().disabled).toBe(true);
    await waitFor(() => expect(screen.queryByText("予約状況を読み込んでいます…")).toBeNull());
  });

  it("希望日時が「仮予約」と重なるときは、第二キープとして申込むことを案内し、第二キープで送る", async () => {
    const { calls } = renderWidget(
      handlerOf(
        {
          "2026-11-25": [
            {
              label: "provisional",
              start: "2026-11-25T09:00:00+09:00",
              end: "2026-11-25T13:00:00+09:00",
            },
          ],
        },
        accepted,
      ),
    );
    await screen.findByText("仮予約 9:00-13:00");
    fillForm({ kind: null });
    expect(screen.getByText(/ご希望の時間は「仮予約」と重なっています。/).textContent).toContain(
      "第二キープとして申込みます。",
    );
    expect(screen.queryByLabelText(/^本予約/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "第二キープとして申込む" }));
    await screen.findByRole("heading", { name: "お申込みを受け付けました" });
    expect(calls.find((call) => call.method === "POST")?.body).toMatchObject({
      kind: "second-hold",
    });
  });

  it("希望日時が「本予約」と重なるときは、送る前に知らせて送信できない", async () => {
    renderWidget(
      handlerOf({
        "2026-11-25": [
          { label: "firm", start: "2026-11-25T11:00:00+09:00", end: "2026-11-25T13:00:00+09:00" },
        ],
      }),
    );
    await screen.findByText("本予約 11:00-13:00");
    fillForm();
    expect(screen.getByText(/ご希望の時間は、ほかの予約と重なっています/)).toBeTruthy();
    expect(submitButton().disabled).toBe(true);
  });

  it("利用日を変えると、その日の月のカレンダーを読む", async () => {
    const { calls } = renderWidget(handlerOf());
    await waitFor(() => expect(screen.queryByText("予約状況を読み込んでいます…")).toBeNull());
    fireEvent.change(screen.getByLabelText(/^利用日/), { target: { value: "2026-12-05" } });
    expect(screen.getByText("2026年12月")).toBeTruthy();
    await waitFor(() => expect(calls.at(-1)?.url).toBe(DECEMBER));
  });

  it("ご利用人数は1〜14人から選ぶ（15人以上は問い合わせに案内する）", () => {
    renderWidget(handlerOf());
    const options = within(screen.getByLabelText(/^ご利用人数/)).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "選んでください",
      ...Array.from({ length: 14 }, (_, index) => `${index + 1}人`),
    ]);
    expect(screen.getByText("15人以上でのご利用は、お問い合わせください。")).toBeTruthy();
  });
});
