import { PriceTable } from "@zebra/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { currentPriceTable } from "./current-price-table";
import { decidePlanId } from "./price-table-pricing";

// booking.md「料金」の「料金表」：今の料金表（リポジトリの1ファイル）が、
// 同じ節の単価の表・追加の表・プランの決め方と一致することを確かめる。
// プランの id は仕様の呼び名（A・B）、オプションの id は workshop・glitter とする（contracts の price-table.test.ts と同じ）。
// プランの決め方は規則の並べ方に何通りもあるので、規則の形ではなく、決まるプランで確かめる

function byId<T extends { readonly id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

describe("今の料金表", () => {
  it("料金表の形（contracts の PriceTable）を満たす", () => {
    expect(PriceTable.safeParse(currentPriceTable()).success).toBe(true);
  });

  it("単価（税抜、30分あたり）：プランA 通常 2,500円・深夜 3,750円、プランB 通常 2,750円・深夜 4,125円", () => {
    expect(byId(currentPriceTable().plans)).toEqual([
      { id: "A", name: "プランA", halfHourRates: { normal: 2_500, lateNight: 3_750 } },
      { id: "B", name: "プランB", halfHourRates: { normal: 2_750, lateNight: 4_125 } },
    ]);
  });

  it("機材保険：税抜 1,000円", () => {
    expect(currentPriceTable().equipmentInsurance).toBe(1_000);
  });

  it("オプション：6人以上のワークショップでの利用 税抜 2,000円、ラメやグリッターを多用した衣装・小道具の持ち込み 税抜 2,000円", () => {
    expect(byId(currentPriceTable().options)).toEqual([
      { id: "glitter", name: "ラメやグリッターを多用した衣装・小道具の持ち込み", price: 2_000 },
      { id: "workshop", name: "6人以上のワークショップでの利用", price: 2_000 },
    ]);
  });

  // 「料金」の例の表（人数・ホリゾントの養生 → プラン）の行を、今の料金表で
  it("10人・なし：プランA", () => {
    expect(
      decidePlanId(currentPriceTable(), { partySize: 10, cycloramaFloorProtection: false }),
    ).toBe("A");
  });

  it("11人・なし：プランB", () => {
    expect(
      decidePlanId(currentPriceTable(), { partySize: 11, cycloramaFloorProtection: false }),
    ).toBe("B");
  });

  it("11人・あり：プランA（床面を全面養生）", () => {
    expect(
      decidePlanId(currentPriceTable(), { partySize: 11, cycloramaFloorProtection: true }),
    ).toBe("A");
  });

  it("15人・なし（管理者が直接入れる）：プランB", () => {
    expect(
      decidePlanId(currentPriceTable(), { partySize: 15, cycloramaFloorProtection: false }),
    ).toBe("B");
  });

  // 15人以上は管理者が直接入れる（「申込フォーム」の節）ので、人数の上限はフォームの14人より広く取る
  it("プランは、10人以下、またはホリゾントの床面を全面養生するならプランA、それ以外はプランB（プロパティ）", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), fc.boolean(), (partySize, protection) => {
        const expectedPlan = partySize <= 10 || protection ? "A" : "B";
        expect(
          decidePlanId(currentPriceTable(), { partySize, cycloramaFloorProtection: protection }),
        ).toBe(expectedPlan);
      }),
    );
  });
});
