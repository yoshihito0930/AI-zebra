import { PriceTable, Yen } from "@zebra/contracts";
import fc from "fast-check";
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { calculatePriceFromTable, decidePlanId } from "./price-table-pricing";

// 仕様の日時は JST で書かれている（INV-7）。例の表には日付がないので、
// 開始日を 2026-10-20 とする（「翌」は 10/21）
function jst(iso: string): DateTime {
  const dateTime = DateTime.fromISO(iso, { zone: "Asia/Tokyo" });
  if (!dateTime.isValid) {
    throw new Error(`テストの日時が不正：${iso}`);
  }
  return dateTime;
}

// 同じ時点を UTC のゾーンで表した日時（INV-7。docs/TESTING.md「仕様の例とテストの対応づけ」）
function utc(iso: string): DateTime {
  return jst(iso).toUTC();
}

// booking.md「料金」の単価の表・追加の表・プランの決め方を、料金表の形（contracts の PriceTable）にしたもの。
// 単価は税抜の30分あたり。プランの決め方は「10人以下、またはホリゾントの床面を全面養生するならプランA、それ以外はプランB」
const specTable = PriceTable.parse({
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
});

interface Row {
  readonly planId: string;
  readonly start: string;
  readonly end: string;
  readonly equipmentInsurance?: boolean;
  readonly optionIds?: readonly string[];
}

function quote(table: PriceTable, row: Row, toDateTime: (iso: string) => DateTime) {
  return calculatePriceFromTable(table, {
    planId: row.planId,
    start: toDateTime(row.start),
    end: toDateTime(row.end),
    equipmentInsurance: row.equipmentInsurance ?? false,
    optionIds: row.optionIds ?? [],
  });
}

function expected(subtotalExcludingTax: number, estimateIncludingTax: number) {
  return {
    subtotalExcludingTax: Yen.parse(subtotalExcludingTax),
    estimateIncludingTax: Yen.parse(estimateIncludingTax),
  };
}

// 例の表（予約 → 計算・見積額）の行。期待値は「計算（税抜）」の最後の値と「見積額（税込）」
const rows = {
  a1012: { planId: "A", start: "2026-10-20T10:00", end: "2026-10-20T12:00" },
  a2101: { planId: "A", start: "2026-10-20T21:00", end: "2026-10-21T01:00" },
  b2030: { planId: "B", start: "2026-10-20T20:30", end: "2026-10-21T00:30" },
  b0004: { planId: "B", start: "2026-10-20T00:00", end: "2026-10-20T04:00" },
  a1012Extras: {
    planId: "A",
    start: "2026-10-20T10:00",
    end: "2026-10-20T12:00",
    equipmentInsurance: true,
    optionIds: ["workshop", "glitter"],
  },
  a2206Workshop: {
    planId: "A",
    start: "2026-10-20T22:00",
    end: "2026-10-21T06:00",
    optionIds: ["workshop"],
  },
} satisfies Record<string, Row>;

describe("料金", () => {
  it("A、10:00–12:00：計算（税抜）2,500 × 4 = 10,000、見積額（税込）11,000", () => {
    expect(quote(specTable, rows.a1012, jst)).toEqual(expected(10_000, 11_000));
  });

  it("A、21:00–翌1:00：計算（税抜）通常 2,500 × 4 + 深夜 3,750 × 4 = 25,000、見積額（税込）27,500", () => {
    expect(quote(specTable, rows.a2101, jst)).toEqual(expected(25_000, 27_500));
  });

  it("B、20:30–翌0:30：計算（税抜）通常 2,750 × 5 + 深夜 4,125 × 3 = 26,125、見積額（税込）28,737（28,737.5 を切り捨て）", () => {
    expect(quote(specTable, rows.b2030, jst)).toEqual(expected(26_125, 28_737));
  });

  it("B、00:00–04:00：計算（税抜）深夜 4,125 × 8 = 33,000、見積額（税込）36,300", () => {
    expect(quote(specTable, rows.b0004, jst)).toEqual(expected(33_000, 36_300));
  });

  it("A、10:00–12:00、機材保険、オプション2つ：計算（税抜）10,000 + 1,000 + 2,000 × 2 = 15,000、見積額（税込）16,500", () => {
    expect(quote(specTable, rows.a1012Extras, jst)).toEqual(expected(15_000, 16_500));
  });

  it("A、22:00–翌6:00、ワークショップ：計算（税抜）通常 2,500 × 2 + 深夜 3,750 × 14 + 2,000 = 59,500、見積額（税込）65,450（オプションは1回）", () => {
    expect(quote(specTable, rows.a2206Workshop, jst)).toEqual(expected(59_500, 65_450));
  });

  it("10人・なし：プランA", () => {
    expect(decidePlanId(specTable, { partySize: 10, cycloramaFloorProtection: false })).toBe("A");
  });

  it("11人・なし：プランB", () => {
    expect(decidePlanId(specTable, { partySize: 11, cycloramaFloorProtection: false })).toBe("B");
  });

  it("11人・あり：プランA（床面を全面養生）", () => {
    expect(decidePlanId(specTable, { partySize: 11, cycloramaFloorProtection: true })).toBe("A");
  });

  it("15人・なし（管理者が直接入れる）：プランB", () => {
    expect(decidePlanId(specTable, { partySize: 15, cycloramaFloorProtection: false })).toBe("B");
  });

  // 料金の行を、同じ時点の UTC で渡す。期待値は表の行のまま
  describe("UTC で渡しても同じ結果（INV-7）", () => {
    it("A、10:00–12:00：計算（税抜）2,500 × 4 = 10,000、見積額（税込）11,000", () => {
      expect(quote(specTable, rows.a1012, utc)).toEqual(expected(10_000, 11_000));
    });

    it("A、21:00–翌1:00：計算（税抜）通常 2,500 × 4 + 深夜 3,750 × 4 = 25,000、見積額（税込）27,500", () => {
      expect(quote(specTable, rows.a2101, utc)).toEqual(expected(25_000, 27_500));
    });

    it("B、20:30–翌0:30：計算（税抜）通常 2,750 × 5 + 深夜 4,125 × 3 = 26,125、見積額（税込）28,737（28,737.5 を切り捨て）", () => {
      expect(quote(specTable, rows.b2030, utc)).toEqual(expected(26_125, 28_737));
    });

    it("B、00:00–04:00：計算（税抜）深夜 4,125 × 8 = 33,000、見積額（税込）36,300", () => {
      expect(quote(specTable, rows.b0004, utc)).toEqual(expected(33_000, 36_300));
    });

    it("A、10:00–12:00、機材保険、オプション2つ：計算（税抜）10,000 + 1,000 + 2,000 × 2 = 15,000、見積額（税込）16,500", () => {
      expect(quote(specTable, rows.a1012Extras, utc)).toEqual(expected(15_000, 16_500));
    });

    it("A、22:00–翌6:00、ワークショップ：計算（税抜）通常 2,500 × 2 + 深夜 3,750 × 14 + 2,000 = 59,500、見積額（税込）65,450（オプションは1回）", () => {
      expect(quote(specTable, rows.a2206Workshop, utc)).toEqual(expected(59_500, 65_450));
    });
  });

  // 「料金表」の小節：料金の計算とプランの決め方は、料金表を受け取って計算する。
  // 単価・機材保険・オプション・プランの決め方を変えた別の料金表でも、その料金表どおりになることを確かめる。
  // あわせて INV-9（金額は整数の円。税抜で合計 → 消費税10% → 1円未満切り捨て）と、
  // INV-7（深夜帯の判定は JST）を確かめる。
  // 予約区間は「時間の単位と利用時間」のルールを満たすもの（JST の30分単位、4時間〜24時間）だけを作る
  describe("料金表どおりに計算する（プロパティ。INV-9、INV-7）", () => {
    const rate = fc.integer({ min: 0, max: 20_000 });

    // ランダムな料金表と、その料金表のプラン・オプションを使う予約
    const tableAndBooking = fc
      .record({
        planRates: fc.array(fc.record({ normal: rate, lateNight: rate }), {
          minLength: 1,
          maxLength: 4,
        }),
        optionPrices: fc.array(fc.integer({ min: 0, max: 10_000 }), { maxLength: 4 }),
        equipmentInsurance: fc.integer({ min: 0, max: 10_000 }),
      })
      .chain((raw) =>
        fc.record({
          raw: fc.constant(raw),
          planIndex: fc.integer({ min: 0, max: raw.planRates.length - 1 }),
          optionIndexes: fc.subarray(raw.optionPrices.map((_, index) => index)),
          equipmentInsurance: fc.boolean(),
          // 10/20 00:00（JST）から2週間のうち、30分単位の開始
          startSlot: fc.integer({ min: 0, max: 48 * 14 - 1 }),
          // 4時間〜24時間（30分単位）
          slots: fc.integer({ min: 8, max: 48 }),
        }),
      );

    type Case = typeof tableAndBooking extends fc.Arbitrary<infer T> ? T : never;

    const base = jst("2026-10-20T00:00");

    function tableOf(c: Case): PriceTable {
      return PriceTable.parse({
        plans: c.raw.planRates.map((halfHourRates, index) => ({
          id: `plan-${index}`,
          name: `プラン${index}`,
          halfHourRates,
        })),
        planRules: [{ plan: "plan-0" }],
        equipmentInsurance: c.raw.equipmentInsurance,
        options: c.raw.optionPrices.map((price, index) => ({
          id: `option-${index}`,
          name: `オプション${index}`,
          price,
        })),
      });
    }

    function startOf(c: Case): DateTime {
      return base.plus({ minutes: 30 * c.startSlot });
    }

    function endOf(c: Case): DateTime {
      return startOf(c).plus({ minutes: 30 * c.slots });
    }

    function priceOf(
      c: Case,
      overrides: Partial<{
        start: DateTime;
        end: DateTime;
        equipmentInsurance: boolean;
        optionIds: readonly string[];
      }> = {},
    ) {
      return calculatePriceFromTable(tableOf(c), {
        planId: `plan-${c.planIndex}`,
        start: overrides.start ?? startOf(c),
        end: overrides.end ?? endOf(c),
        equipmentInsurance: overrides.equipmentInsurance ?? c.equipmentInsurance,
        optionIds: overrides.optionIds ?? c.optionIndexes.map((index) => `option-${index}`),
      });
    }

    it("税抜の合計と税込の見積額は、どちらも0以上の整数の円（Yen）", () => {
      fc.assert(
        fc.property(tableAndBooking, (c) => {
          const result = priceOf(c);
          expect(Yen.safeParse(result.subtotalExcludingTax).success).toBe(true);
          expect(Yen.safeParse(result.estimateIncludingTax).success).toBe(true);
        }),
      );
    });

    it("税込の見積額は、税抜の合計に消費税10%をかけて1円未満を切り捨てた額", () => {
      fc.assert(
        fc.property(tableAndBooking, (c) => {
          const result = priceOf(c);
          const timesEleven = result.subtotalExcludingTax * 11;
          const floored = (timesEleven - (timesEleven % 10)) / 10;
          expect(result.estimateIncludingTax).toBe(floored);
        }),
      );
    });

    it("機材保険・オプションなしの税抜の合計は、渡したプランの30分ごとの単価（JST の深夜帯 23:00〜翌8:00 かどうかで決まる）の和", () => {
      fc.assert(
        fc.property(tableAndBooking, (c) => {
          const rates = c.raw.planRates[c.planIndex];
          if (rates === undefined) {
            throw new Error("テストのプランが不正");
          }
          const start = startOf(c);
          let sum = 0;
          for (let i = 0; i < c.slots; i++) {
            const hour = start.plus({ minutes: 30 * i }).setZone("Asia/Tokyo").hour;
            const lateNight = hour >= 23 || hour < 8;
            sum += lateNight ? rates.lateNight : rates.normal;
          }
          const result = priceOf(c, { equipmentInsurance: false, optionIds: [] });
          expect(result.subtotalExcludingTax).toBe(sum);
        }),
      );
    });

    it("機材保険は料金表の機材保険の額を、オプションは選んだものそれぞれの料金表の額を、利用時間によらず1回だけ足す", () => {
      fc.assert(
        fc.property(tableAndBooking, (c) => {
          const bare = priceOf(c, { equipmentInsurance: false, optionIds: [] });
          const result = priceOf(c);
          let extras = c.equipmentInsurance ? c.raw.equipmentInsurance : 0;
          for (const index of c.optionIndexes) {
            extras += c.raw.optionPrices[index] ?? 0;
          }
          expect(result.subtotalExcludingTax).toBe(bare.subtotalExcludingTax + extras);
        }),
      );
    });

    it("同じ時点を UTC で渡しても、JST で渡したときと同じ結果", () => {
      fc.assert(
        fc.property(tableAndBooking, (c) => {
          const inJst = priceOf(c);
          const inUtc = priceOf(c, { start: startOf(c).toUTC(), end: endOf(c).toUTC() });
          expect(inUtc).toEqual(inJst);
        }),
      );
    });

    // ランダムなプランの決め方（PlanRule の並び）。最後の規則は条件なし（contracts の PriceTable の決まり）
    const planRulesCase = fc.integer({ min: 1, max: 4 }).chain((planCount) =>
      fc.record({
        planCount: fc.constant(planCount),
        conditionalRules: fc.array(
          fc.record({
            planIndex: fc.integer({ min: 0, max: planCount - 1 }),
            maxPartySize: fc.option(fc.integer({ min: 1, max: 20 }), { nil: undefined }),
            cycloramaFloorProtection: fc.boolean(),
          }),
          { maxLength: 5 },
        ),
        lastPlanIndex: fc.integer({ min: 0, max: planCount - 1 }),
        partySize: fc.integer({ min: 1, max: 30 }),
        cycloramaFloorProtection: fc.boolean(),
      }),
    );

    it("プランは、料金表の規則を上から順に見て、書いてある条件をすべて満たす最初の規則のプラン", () => {
      fc.assert(
        fc.property(planRulesCase, (c) => {
          const rules = [
            ...c.conditionalRules.map((rule) => ({
              plan: `plan-${rule.planIndex}`,
              ...(rule.maxPartySize === undefined ? {} : { maxPartySize: rule.maxPartySize }),
              ...(rule.cycloramaFloorProtection ? { cycloramaFloorProtection: true } : {}),
            })),
            { plan: `plan-${c.lastPlanIndex}` },
          ];
          const table = PriceTable.parse({
            plans: Array.from({ length: c.planCount }, (_, index) => ({
              id: `plan-${index}`,
              name: `プラン${index}`,
              halfHourRates: { normal: 2_500, lateNight: 3_750 },
            })),
            planRules: rules,
            equipmentInsurance: 1_000,
            options: [],
          });
          const matched = rules.find(
            (rule) =>
              ("maxPartySize" in rule ? c.partySize <= rule.maxPartySize : true) &&
              ("cycloramaFloorProtection" in rule ? c.cycloramaFloorProtection : true),
          );
          expect(
            decidePlanId(table, {
              partySize: c.partySize,
              cycloramaFloorProtection: c.cycloramaFloorProtection,
            }),
          ).toBe(matched?.plan);
        }),
      );
    });
  });
});
