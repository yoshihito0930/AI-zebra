import { describe, expect, it } from "vitest";
import { PriceTable } from "./price-table";

// booking.md「料金」の単価の表とプランの決め方（今の料金表）
const current = {
  plans: [
    { id: "A", name: "プランA", halfHourRates: { normal: 2_500, lateNight: 3_750 } },
    { id: "B", name: "プランB", halfHourRates: { normal: 2_750, lateNight: 4_125 } },
  ],
  planRules: [
    { plan: "A", maxPartySize: 10 },
    { plan: "A", cycloramaFloorProtection: true },
    { plan: "B" },
  ],
  equipmentInsurance: 1_000,
  options: [
    { id: "workshop", name: "6人以上のワークショップでの利用", price: 2_000 },
    { id: "glitter", name: "ラメやグリッターを多用した衣装・小道具の持ち込み", price: 2_000 },
  ],
};

describe("料金表の形", () => {
  it("仕様の今の料金表は通す", () => {
    expect(PriceTable.safeParse(current).success).toBe(true);
  });

  it.each([
    [
      "単価が整数でない",
      {
        ...current,
        plans: [
          { ...current.plans[0], halfHourRates: { normal: 2_500.5, lateNight: 3_750 } },
          current.plans[1],
        ],
      },
    ],
    [
      "プランの id が重なっている",
      { ...current, plans: [current.plans[0], { ...current.plans[1], id: "A" }] },
    ],
    [
      "オプションの id が重なっている",
      { ...current, options: [current.options[0], { ...current.options[1], id: "workshop" }] },
    ],
    [
      "規則が料金表にないプランを指している",
      { ...current, planRules: [{ plan: "C", maxPartySize: 10 }, { plan: "B" }] },
    ],
    ["最後の規則に条件がある", { ...current, planRules: [{ plan: "A", maxPartySize: 10 }] }],
    ["プランがない", { ...current, plans: [], planRules: [] }],
  ])("%s料金表は通さない", (_, table) => {
    expect(PriceTable.safeParse(table).success).toBe(false);
  });
});
