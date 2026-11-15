// 申込フォームの入力から求めるもの（利用日時、予約の種類、見積額、送る前の確かめ、送る本文）。
// 氏名・連絡先は架空のもの（公開リポジトリのため）
import { currentPriceTable } from "@zebra/booking-core";
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  buildRequest,
  draftOf,
  emptyFormValues,
  rangeOf,
  type FormValues,
} from "./application-draft.ts";

const priceTable = currentPriceTable();
// 今は 2026-10-01 10:00（JST）
const now = DateTime.fromISO("2026-10-01T10:00:00+09:00");

const filled = (overrides: Partial<FormValues> = {}): FormValues => ({
  ...emptyFormValues(),
  kind: "firm",
  date: "2026-10-20",
  startTime: "10:00",
  endTime: "12:00",
  partySize: "3",
  cycloramaFloorProtection: "no",
  name: "架空 太郎",
  email: "taro@example.com",
  phone: "090-0000-0000",
  address: "東京都架空区1-2-3",
  photographerName: "架空 次郎",
  shootingTypes: ["still"],
  shootingDetails: "商品撮影",
  agreedToCycloramaRules: true,
  agreedToTerms: true,
  ...overrides,
});

const draft = (
  values: FormValues,
  options: { now?: DateTime; bookings?: Parameters<typeof draftOf>[1]["bookings"] } = {},
) => draftOf(values, { now: options.now ?? now, bookings: options.bookings ?? [], priceTable });

describe("利用日時の入力（JST）", () => {
  it("利用日と開始・終了の時刻を JST の日時にする", () => {
    const range = rangeOf({ date: "2026-10-20", startTime: "10:00", endTime: "12:00" });
    expect(range?.start.toISO()).toBe("2026-10-20T10:00:00.000+09:00");
    expect(range?.end.toISO()).toBe("2026-10-20T12:00:00.000+09:00");
  });

  it("終了の時刻が開始以前なら、終了は翌日（22:00〜2:00、10:00〜10:00 は24時間）", () => {
    expect(rangeOf({ date: "2026-10-20", startTime: "22:00", endTime: "02:00" })?.end.toISO()).toBe(
      "2026-10-21T02:00:00.000+09:00",
    );
    expect(rangeOf({ date: "2026-10-20", startTime: "10:00", endTime: "10:00" })?.end.toISO()).toBe(
      "2026-10-21T10:00:00.000+09:00",
    );
  });

  it("日・時刻のどれかがなければ決まらない", () => {
    expect(rangeOf({ date: "", startTime: "10:00", endTime: "12:00" })).toBeUndefined();
    expect(rangeOf({ date: "2026-10-20", startTime: "", endTime: "12:00" })).toBeUndefined();
  });
});

describe("見積額（booking-core の料金の計算。税込、整数の円）", () => {
  it("プランA、10:00–12:00 は 11,000円", () => {
    expect(draft(filled()).estimate).toEqual({ estimateIncludingTax: 11_000, planName: "プランA" });
  });

  it("11人・養生なしはプランB。20:30–翌0:30 は 28,737円（28,737.5 を切り捨て）", () => {
    expect(
      draft(filled({ partySize: "11", startTime: "20:30", endTime: "00:30" })).estimate,
    ).toEqual({ estimateIncludingTax: 28_737, planName: "プランB" });
  });

  it("11人でもホリゾントの養生ありならプランA", () => {
    expect(
      draft(filled({ partySize: "11", cycloramaFloorProtection: "yes" })).estimate?.planName,
    ).toBe("プランA");
  });

  it("機材保険とオプション2つを足す（16,500円）", () => {
    expect(
      draft(filled({ equipmentInsurance: true, optionIds: ["workshop", "glitter"] })).estimate
        ?.estimateIncludingTax,
    ).toBe(16_500);
  });

  it("人数・ホリゾントの養生・日時のどれかが決まらないか、利用時間の決まりを満たさなければ出さない", () => {
    expect(draft(filled({ partySize: "" })).estimate).toBeUndefined();
    expect(draft(filled({ cycloramaFloorProtection: "" })).estimate).toBeUndefined();
    expect(draft(filled({ endTime: "" })).estimate).toBeUndefined();
    expect(draft(filled({ endTime: "11:30" })).estimate).toBeUndefined();
  });
});

describe("送る前の確かめ（booking-core の同じ判定）", () => {
  it("2時間未満・深夜帯で4時間未満は申込めない", () => {
    expect(draft(filled({ endTime: "11:30" })).problems).toEqual(["shorter-than-2-hours"]);
    expect(draft(filled({ startTime: "03:00", endTime: "05:00" })).problems).toEqual([
      "late-night-shorter-than-4-hours",
    ]);
  });

  it("仮予約の期限（利用日の7日前の18:00）を過ぎたら、仮予約は選べない", () => {
    // 開始 10/20 15:00 の仮予約の期限は 10/13 18:00
    const values = filled({ kind: "provisional", startTime: "15:00", endTime: "19:00" });
    const before = draft(values, { now: DateTime.fromISO("2026-10-13T17:59:00+09:00") });
    expect(before.provisionalSelectable).toBe(true);
    expect(before.problems).toEqual([]);
    expect(before.provisionalDeadline?.toISO()).toBe("2026-10-13T18:00:00.000+09:00");

    const after = draft(values, { now: DateTime.fromISO("2026-10-13T18:00:00+09:00") });
    expect(after.provisionalSelectable).toBe(false);
    expect(after.problems).toEqual(["past-provisional-deadline"]);
    // 本予約なら受け付ける
    expect(
      draft({ ...values, kind: "firm" }, { now: DateTime.fromISO("2026-10-13T18:00:00+09:00") })
        .problems,
    ).toEqual([]);
  });

  it("本予約は開始の24時間前まで", () => {
    const values = filled({ startTime: "15:00", endTime: "19:00" });
    expect(draft(values, { now: DateTime.fromISO("2026-10-19T14:59:00+09:00") }).problems).toEqual(
      [],
    );
    expect(draft(values, { now: DateTime.fromISO("2026-10-19T15:00:00+09:00") }).problems).toEqual([
      "past-24-hours-before-start",
    ]);
  });
});

describe("第二キープの案内と、ほかの予約との重なり", () => {
  const provisional = {
    label: "provisional" as const,
    start: "2026-10-20T13:00:00+09:00",
    end: "2026-10-20T15:00:00+09:00",
  };
  const firm = {
    label: "firm" as const,
    start: "2026-10-20T17:00:00+09:00",
    end: "2026-10-20T19:00:00+09:00",
  };

  it("希望日時が「仮予約」とだけ重なるなら、第二キープとして申込む", () => {
    const result = draft(filled({ kind: "", startTime: "14:00", endTime: "16:00" }), {
      bookings: [provisional, firm],
    });
    expect(result.secondHold).toBe(true);
    expect(result.kind).toBe("second-hold");
    expect(result.problems).toEqual([]);
  });

  it("「本予約」とも重なるなら申込めない", () => {
    const result = draft(filled({ startTime: "14:00", endTime: "18:00" }), {
      bookings: [provisional, firm],
    });
    expect(result.secondHold).toBe(false);
    expect(result.problems).toEqual(["overlaps-existing"]);
  });

  it("予約の時間と接するだけなら重ならない（半開区間）。間の1時間は API が判定する", () => {
    const result = draft(filled({ startTime: "15:00", endTime: "17:00" }), {
      bookings: [provisional, firm],
    });
    expect(result.secondHold).toBe(false);
    expect(result.kind).toBe("firm");
    expect(result.problems).toEqual([]);
  });

  it("第二キープも仮予約の期限まで", () => {
    const result = draft(filled({ startTime: "14:00", endTime: "16:00" }), {
      bookings: [provisional],
      now: DateTime.fromISO("2026-10-13T18:00:00+09:00"),
    });
    expect(result.kind).toBe("second-hold");
    expect(result.problems).toEqual(["past-provisional-deadline"]);
  });
});

describe("送る本文（契約 ApplicationRequest の形）", () => {
  it("日時はオフセット付き（+09:00）。空の任意の欄は送らない", () => {
    const values = filled();
    const built = buildRequest(values, draft(values));
    expect(built).toEqual({
      ok: true,
      request: {
        kind: "firm",
        start: "2026-10-20T10:00:00+09:00",
        end: "2026-10-20T12:00:00+09:00",
        partySize: 3,
        cycloramaFloorProtection: false,
        equipmentInsurance: false,
        optionIds: [],
        customer: {
          name: "架空 太郎",
          email: "taro@example.com",
          phone: "090-0000-0000",
          address: "東京都架空区1-2-3",
          photographerName: "架空 次郎",
        },
        shooting: { types: ["still"], details: "商品撮影" },
        agreedToCycloramaRules: true,
        agreedToTerms: true,
      },
    });
  });

  it("会社名・補足事項を書いたら送る", () => {
    const values = filled({ companyName: "架空スタジオ株式会社", notes: "搬入は10時から" });
    const built = buildRequest(values, draft(values));
    expect(built.ok && built.request.customer.companyName).toBe("架空スタジオ株式会社");
    expect(built.ok && built.request.shooting.notes).toBe("搬入は10時から");
  });

  it("契約に合わない欄を、フォームの呼び名で返す", () => {
    const values = filled({
      kind: "",
      name: "",
      email: "taro.example.com",
      phone: "+81-90-0000-0000",
      shootingTypes: [],
      agreedToTerms: false,
    });
    expect(buildRequest(values, draft(values))).toEqual({
      ok: false,
      fields: ["予約の種類", "氏名", "メールアドレス", "電話番号", "撮影内容", "利用規約への同意"],
    });
  });
});
