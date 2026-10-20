import { describe, expect, it } from "vitest";
import {
  ApplicationAccepted,
  ApplicationRejected,
  ApplicationRequest,
  ReceiptNumber,
} from "./application";

// 架空のお客様（実在しない）
const valid = {
  kind: "provisional",
  start: "2026-10-20T10:00:00+09:00",
  end: "2026-10-20T12:00:00+09:00",
  partySize: 10,
  cycloramaFloorProtection: false,
  equipmentInsurance: true,
  optionIds: ["workshop"],
  customer: {
    name: "試験 太郎",
    email: "taro@example.com",
    phone: "090-0000-0000",
    address: "東京都架空区1-2-3",
    photographerName: "試験 花子",
  },
  shooting: { types: ["still"], details: "商品撮影" },
  agreedToCycloramaRules: true,
  agreedToTerms: true,
};

describe("申込フォーム（契約）", () => {
  it("正しい申込は通す（会社名・補足事項は空でよい）", () => {
    expect(ApplicationRequest.safeParse(valid).success).toBe(true);
    const withEmpty = {
      ...valid,
      customer: { ...valid.customer, companyName: "" },
      shooting: { ...valid.shooting, notes: "" },
    };
    expect(ApplicationRequest.safeParse(withEmpty).success).toBe(true);
  });

  it.each(["0312345678", "03-1234-5678", "09000000000", "090-0000-0000"])(
    "電話番号 %s は通す",
    (phone) => {
      const value = { ...valid, customer: { ...valid.customer, phone } };
      expect(ApplicationRequest.safeParse(value).success).toBe(true);
    },
  );

  it.each([
    ["人数 15（問い合わせに案内）", { ...valid, partySize: 15 }],
    ["人数 0", { ...valid, partySize: 0 }],
    ["利用規約への同意なし", { ...valid, agreedToTerms: false }],
    ["ホリゾントルールの確認なし", { ...valid, agreedToCycloramaRules: false }],
    [
      "メールアドレスの形が不正",
      { ...valid, customer: { ...valid.customer, email: "taro@example" } },
    ],
    [
      "電話番号が +81 から",
      { ...valid, customer: { ...valid.customer, phone: "+81-90-0000-0000" } },
    ],
    ["電話番号の桁が足りない", { ...valid, customer: { ...valid.customer, phone: "090-000-000" } }],
    ["氏名が空", { ...valid, customer: { ...valid.customer, name: " " } }],
    ["撮影内容がない", { ...valid, shooting: { ...valid.shooting, types: [] } }],
    ["同じオプションが2回", { ...valid, optionIds: ["workshop", "workshop"] }],
    ["予約の種類が不正", { ...valid, kind: "pending-firm" }],
    ["日時にオフセットがない", { ...valid, start: "2026-10-20T10:00:00" }],
    ["余計なキー", { ...valid, status: "firm" }],
  ])("%s は通さない", (_, value) => {
    expect(ApplicationRequest.safeParse(value).success).toBe(false);
  });

  it("受付番号は、紛らわしい文字を除いた英大文字と数字の8文字", () => {
    expect(ReceiptNumber.safeParse("ZB7K2M9Q").success).toBe(true);
    for (const value of ["ZB7K2M9", "ZB7K2M9QX", "ZB7K2M9O", "ZB7K2M90", "zb7k2m9q"]) {
      expect(ReceiptNumber.safeParse(value).success).toBe(false);
    }
  });

  it("受け付けたときの返事は、受付番号と見積額だけ", () => {
    expect(
      ApplicationAccepted.safeParse({ receiptNumber: "ZB7K2M9Q", estimateIncludingTax: 11_000 })
        .success,
    ).toBe(true);
    expect(
      ApplicationAccepted.safeParse({
        receiptNumber: "ZB7K2M9Q",
        estimateIncludingTax: 11_000,
        id: "r-1",
      }).success,
    ).toBe(false);
  });

  it("断るときの返事は、決まった理由だけ", () => {
    expect(ApplicationRejected.safeParse({ error: "past-provisional-deadline" }).success).toBe(
      true,
    );
    expect(ApplicationRejected.safeParse({ error: "unknown" }).success).toBe(false);
  });
});
