import { Yen } from "@zebra/contracts";
import { describe, expect, it } from "vitest";
import {
  buildContent,
  buildCustomer,
  contentChanged,
  contentInputOf,
  customerInputOf,
  emptyContentInput,
  emptyCustomerInput,
  estimateOf,
  type ContentInput,
} from "./reservation-input.ts";
import { detailResponse } from "./test-support.ts";

const input = (overrides: Partial<ContentInput>): ContentInput => ({
  ...emptyContentInput(),
  partySize: "3",
  ...overrides,
});

/** 見積の税込額（出せないときは理由） */
const estimateText = (overrides: Partial<ContentInput>) => {
  const estimate = estimateOf(input(overrides));
  return estimate.ok
    ? `${estimate.planId} ${estimate.quote.estimateIncludingTax}`
    : `不可：${estimate.message}`;
};

// booking.md「料金」の例を、管理画面の見積でも同じに出す（計算は booking-core の関数と今の料金表。API と同じ）
describe("フォームの見積（今の料金表）", () => {
  it("A、10:00–12:00：11,000円", () => {
    expect(estimateText({ start: "2026-11-20T10:00", end: "2026-11-20T12:00" })).toBe("A 11000");
  });

  it("A、21:00–翌1:00：27,500円（深夜帯は JST で判定する）", () => {
    expect(estimateText({ start: "2026-11-20T21:00", end: "2026-11-21T01:00" })).toBe("A 27500");
  });

  it("B（11人）、20:30–翌0:30：28,737円", () => {
    expect(
      estimateText({ start: "2026-11-20T20:30", end: "2026-11-21T00:30", partySize: "11" }),
    ).toBe("B 28737");
  });

  it("11人でもホリゾントの養生ありならプランA", () => {
    expect(
      estimateText({
        start: "2026-11-20T10:00",
        end: "2026-11-20T12:00",
        partySize: "11",
        cycloramaFloorProtection: true,
      }),
    ).toBe("A 11000");
  });

  it("15人（管理者が直接入れる）はプランB", () => {
    expect(
      estimateText({ start: "2026-11-20T10:00", end: "2026-11-20T12:00", partySize: "15" }),
    ).toBe("B 12100");
  });

  it("A、10:00–12:00、機材保険、オプション2つ：16,500円", () => {
    expect(
      estimateText({
        start: "2026-11-20T10:00",
        end: "2026-11-20T12:00",
        equipmentInsurance: true,
        optionIds: ["glitter", "workshop"],
      }),
    ).toBe("A 16500");
  });

  it("日時・人数がない、30分単位でない、終わりが開始以前なら、見積を出さずに理由を返す", () => {
    expect(estimateText({ start: "", end: "2026-11-20T12:00" })).toContain("日時を入れると");
    expect(
      estimateText({ start: "2026-11-20T10:00", end: "2026-11-20T12:00", partySize: "" }),
    ).toContain("人数を入れると");
    expect(estimateText({ start: "2026-11-20T10:15", end: "2026-11-20T12:15" })).toContain(
      "30分単位でない",
    );
    expect(estimateText({ start: "2026-11-20T12:00", end: "2026-11-20T10:00" })).toContain(
      "終わりが開始より前",
    );
  });
});

describe("予約の内容の本文", () => {
  it("JST で入れた日時をオフセット付きにし、オプションを料金表の順に並べる", () => {
    expect(
      buildContent(
        input({
          start: "2026-11-20T22:00",
          end: "2026-11-21T02:00",
          optionIds: ["glitter", "workshop"],
          equipmentInsurance: true,
        }),
        "30000",
      ),
    ).toEqual({
      ok: true,
      value: {
        start: "2026-11-20T22:00:00.000+09:00",
        end: "2026-11-21T02:00:00.000+09:00",
        partySize: 3,
        cycloramaFloorProtection: false,
        equipmentInsurance: true,
        optionIds: ["workshop", "glitter"],
        confirmedPrice: 30_000,
      },
    });
  });

  it("確定金額の欄を直していれば、その値を使う", () => {
    const built = buildContent(
      input({ start: "2026-11-20T10:00", end: "2026-11-20T12:00", confirmedPrice: "10000" }),
      "11000",
    );
    expect(built.ok && built.value.confirmedPrice).toBe(10_000);
  });

  it("日時・人数・確定金額が正しくなければ、理由を並べる", () => {
    expect(buildContent(input({ partySize: "0", confirmedPrice: "1.5" }), "")).toEqual({
      ok: false,
      messages: [
        "開始の日時を入れてください。",
        "終わりの日時を入れてください。",
        "人数は、1〜100の整数で入れてください。",
        "確定金額は、0以上の整数（円）で入れてください。",
      ],
    });
  });

  it("変更の初期値は今の予約の値で、内容を変えたかを比べられる", () => {
    const detail = detailResponse({ status: "firm", confirmedPrice: Yen.parse(12_100) });
    const initial = contentInputOf(detail);
    expect(initial).toEqual({
      start: "2026-11-05T10:00",
      end: "2026-11-05T12:00",
      partySize: "2",
      cycloramaFloorProtection: false,
      equipmentInsurance: true,
      optionIds: ["glitter"],
      confirmedPrice: undefined,
    });
    expect(contentChanged(initial, detail)).toBe(false);
    // 確定金額だけを直しても、内容は変わっていない
    expect(contentChanged({ ...initial, confirmedPrice: "9000" }, detail)).toBe(false);
    expect(contentChanged({ ...initial, end: "2026-11-05T13:00" }, detail)).toBe(true);
    expect(contentChanged({ ...initial, optionIds: [] }, detail)).toBe(true);
  });
});

describe("お客様の情報・撮影の内容の本文", () => {
  it("前後の空白を除き、空の欄は送らない", () => {
    expect(
      buildCustomer({
        ...emptyCustomerInput(),
        name: " 架空 次郎 ",
        phone: "090-0000-0001",
        companyName: "   ",
        shootingTypes: ["movie", "still"],
        shootingNotes: "機材の搬入あり",
      }),
    ).toEqual({
      ok: true,
      value: {
        customer: { name: "架空 次郎", phone: "090-0000-0001" },
        shooting: { types: ["still", "movie"], notes: "機材の搬入あり" },
      },
    });
  });

  it("氏名と、電話番号かメールアドレスのどちらか1つが必須", () => {
    expect(buildCustomer(emptyCustomerInput())).toEqual({
      ok: false,
      messages: [
        "氏名を入れてください。",
        "電話番号かメールアドレスのどちらか1つを入れてください。",
      ],
    });
    const emailOnly = buildCustomer({
      ...emptyCustomerInput(),
      name: "架空 次郎",
      email: "jiro@example.com",
    });
    expect(emailOnly.ok).toBe(true);
  });

  it("メールアドレス・電話番号の形と、長さの上限を確かめる（申込フォームと同じ）", () => {
    const result = buildCustomer({
      ...emptyCustomerInput(),
      name: "架空 次郎",
      email: "jiro@example",
      phone: "+81-90-0000-0001",
      address: "あ".repeat(201),
    });
    expect(result).toEqual({
      ok: false,
      messages: [
        "メールアドレスは「〇〇@〇〇.〇〇」の形で入れてください。",
        "電話番号は、先頭が0の10〜11桁の数字で入れてください（ハイフンは入れてよい。+81 は使えません）。",
        "住所が長すぎます。",
      ],
    });
  });

  it("今の予約の値から初期値を作る（ない欄は空）", () => {
    expect(customerInputOf(detailResponse())).toEqual({
      name: "架空 花子",
      companyName: "架空スタジオ株式会社",
      email: "hanako@example.com",
      phone: "090-0000-0000",
      address: "",
      photographerName: "",
      shootingTypes: ["still", "movie"],
      shootingDetails: "商品撮影",
      shootingNotes: "",
    });
  });
});
