import { Yen } from "@zebra/contracts";
import fc from "fast-check";
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { calculatePrice, type Plan, type PricingOptions } from "./pricing";

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

const noOptions: PricingOptions = { workshop: false, glitter: false };

interface Row {
  readonly plan: Plan;
  readonly start: string;
  readonly end: string;
  readonly equipmentInsurance?: boolean;
  readonly options?: PricingOptions;
}

function quote(row: Row, toDateTime: (iso: string) => DateTime) {
  return calculatePrice({
    plan: row.plan,
    start: toDateTime(row.start),
    end: toDateTime(row.end),
    equipmentInsurance: row.equipmentInsurance ?? false,
    options: row.options ?? noOptions,
  });
}

function expected(subtotalExcludingTax: number, estimateIncludingTax: number) {
  return {
    subtotalExcludingTax: Yen.parse(subtotalExcludingTax),
    estimateIncludingTax: Yen.parse(estimateIncludingTax),
  };
}

// 例の表の行。期待値は「計算（税抜）」の最後の値と「見積額（税込）」
const rows = {
  a1012: { plan: "A", start: "2026-10-20T10:00", end: "2026-10-20T12:00" },
  a2101: { plan: "A", start: "2026-10-20T21:00", end: "2026-10-21T01:00" },
  b2030: { plan: "B", start: "2026-10-20T20:30", end: "2026-10-21T00:30" },
  b0004: { plan: "B", start: "2026-10-20T00:00", end: "2026-10-20T04:00" },
  a1012Extras: {
    plan: "A",
    start: "2026-10-20T10:00",
    end: "2026-10-20T12:00",
    equipmentInsurance: true,
    options: { workshop: true, glitter: true },
  },
  a2206Workshop: {
    plan: "A",
    start: "2026-10-20T22:00",
    end: "2026-10-21T06:00",
    options: { workshop: true, glitter: false },
  },
} satisfies Record<string, Row>;

describe("料金", () => {
  it("A、10:00–12:00：計算（税抜）2,500 × 4 = 10,000、見積額（税込）11,000", () => {
    expect(quote(rows.a1012, jst)).toEqual(expected(10_000, 11_000));
  });

  it("A、21:00–翌1:00：計算（税抜）通常 2,500 × 4 + 深夜 3,750 × 4 = 25,000、見積額（税込）27,500", () => {
    expect(quote(rows.a2101, jst)).toEqual(expected(25_000, 27_500));
  });

  it("B、20:30–翌0:30：計算（税抜）通常 2,750 × 5 + 深夜 4,125 × 3 = 26,125、見積額（税込）28,737（28,737.5 を切り捨て）", () => {
    expect(quote(rows.b2030, jst)).toEqual(expected(26_125, 28_737));
  });

  it("B、00:00–04:00：計算（税抜）深夜 4,125 × 8 = 33,000、見積額（税込）36,300", () => {
    expect(quote(rows.b0004, jst)).toEqual(expected(33_000, 36_300));
  });

  it("A、10:00–12:00、機材保険、オプション2つ：計算（税抜）10,000 + 1,000 + 2,000 × 2 = 15,000、見積額（税込）16,500", () => {
    expect(quote(rows.a1012Extras, jst)).toEqual(expected(15_000, 16_500));
  });

  it("A、22:00–翌6:00、ワークショップ：計算（税抜）通常 2,500 × 2 + 深夜 3,750 × 14 + 2,000 = 59,500、見積額（税込）65,450（オプションは1回）", () => {
    expect(quote(rows.a2206Workshop, jst)).toEqual(expected(59_500, 65_450));
  });

  // 上の各行を、同じ時点の UTC で渡す。期待値は表の行のまま
  describe("UTC で渡しても同じ結果（INV-7）", () => {
    it("A、10:00–12:00：計算（税抜）2,500 × 4 = 10,000、見積額（税込）11,000", () => {
      expect(quote(rows.a1012, utc)).toEqual(expected(10_000, 11_000));
    });

    it("A、21:00–翌1:00：計算（税抜）通常 2,500 × 4 + 深夜 3,750 × 4 = 25,000、見積額（税込）27,500", () => {
      expect(quote(rows.a2101, utc)).toEqual(expected(25_000, 27_500));
    });

    it("B、20:30–翌0:30：計算（税抜）通常 2,750 × 5 + 深夜 4,125 × 3 = 26,125、見積額（税込）28,737（28,737.5 を切り捨て）", () => {
      expect(quote(rows.b2030, utc)).toEqual(expected(26_125, 28_737));
    });

    it("B、00:00–04:00：計算（税抜）深夜 4,125 × 8 = 33,000、見積額（税込）36,300", () => {
      expect(quote(rows.b0004, utc)).toEqual(expected(33_000, 36_300));
    });

    it("A、10:00–12:00、機材保険、オプション2つ：計算（税抜）10,000 + 1,000 + 2,000 × 2 = 15,000、見積額（税込）16,500", () => {
      expect(quote(rows.a1012Extras, utc)).toEqual(expected(15_000, 16_500));
    });

    it("A、22:00–翌6:00、ワークショップ：計算（税抜）通常 2,500 × 2 + 深夜 3,750 × 14 + 2,000 = 59,500、見積額（税込）65,450（オプションは1回）", () => {
      expect(quote(rows.a2206Workshop, utc)).toEqual(expected(59_500, 65_450));
    });
  });

  // INV-9（金額は整数の円。税抜で合計 → 消費税10% → 1円未満切り捨て）と
  // INV-7（深夜帯の判定は JST）を、ランダムな予約で確かめる。
  // 予約区間は「時間の単位と利用時間」のルールを満たすもの（JST の30分単位、4時間〜24時間）だけを作る
  describe("プロパティ（INV-9、INV-7）", () => {
    // 仕様「単価（税抜）」の30分あたりの単価
    const halfHourRate: Record<Plan, { normal: number; lateNight: number }> = {
      A: { normal: 2_500, lateNight: 3_750 },
      B: { normal: 2_750, lateNight: 4_125 },
    };

    const base = jst("2026-10-20T00:00");

    const booking = fc.record({
      plan: fc.constantFrom<Plan>("A", "B"),
      // 10/20 00:00 から2週間のうち、30分単位の開始
      startSlot: fc.integer({ min: 0, max: 48 * 14 - 1 }),
      // 4時間〜24時間（30分単位）
      slots: fc.integer({ min: 8, max: 48 }),
      equipmentInsurance: fc.boolean(),
      workshop: fc.boolean(),
      glitter: fc.boolean(),
    });

    type Booking = typeof booking extends fc.Arbitrary<infer T> ? T : never;

    function startOf(b: Booking): DateTime {
      return base.plus({ minutes: 30 * b.startSlot });
    }

    function endOf(b: Booking): DateTime {
      return startOf(b).plus({ minutes: 30 * b.slots });
    }

    function priceOf(
      b: Booking,
      overrides: Partial<{
        start: DateTime;
        end: DateTime;
        equipmentInsurance: boolean;
        options: PricingOptions;
      }> = {},
    ) {
      return calculatePrice({
        plan: b.plan,
        start: overrides.start ?? startOf(b),
        end: overrides.end ?? endOf(b),
        equipmentInsurance: overrides.equipmentInsurance ?? b.equipmentInsurance,
        options: overrides.options ?? { workshop: b.workshop, glitter: b.glitter },
      });
    }

    it("税抜の合計と税込の見積額は、どちらも0以上の整数の円（Yen）", () => {
      fc.assert(
        fc.property(booking, (b) => {
          const result = priceOf(b);
          expect(Yen.safeParse(result.subtotalExcludingTax).success).toBe(true);
          expect(Yen.safeParse(result.estimateIncludingTax).success).toBe(true);
        }),
      );
    });

    it("税込の見積額は、税抜の合計に消費税10%をかけて1円未満を切り捨てた額", () => {
      fc.assert(
        fc.property(booking, (b) => {
          const result = priceOf(b);
          const timesEleven = result.subtotalExcludingTax * 11;
          const floored = (timesEleven - (timesEleven % 10)) / 10;
          expect(result.estimateIncludingTax).toBe(floored);
        }),
      );
    });

    it("機材保険・オプションなしの税抜の合計は、30分ごとの単価（JST の深夜帯 23:00〜翌8:00 かどうかで決まる）の和", () => {
      fc.assert(
        fc.property(booking, (b) => {
          const start = startOf(b);
          let sum = 0;
          for (let i = 0; i < b.slots; i++) {
            const hour = start.plus({ minutes: 30 * i }).setZone("Asia/Tokyo").hour;
            const lateNight = hour >= 23 || hour < 8;
            sum += lateNight ? halfHourRate[b.plan].lateNight : halfHourRate[b.plan].normal;
          }
          const result = priceOf(b, { equipmentInsurance: false, options: noOptions });
          expect(result.subtotalExcludingTax).toBe(sum);
        }),
      );
    });

    it("機材保険は税抜で1,000円、オプションは1つにつき税抜で2,000円を、利用時間によらず1回だけ足す", () => {
      fc.assert(
        fc.property(booking, (b) => {
          const bare = priceOf(b, { equipmentInsurance: false, options: noOptions });
          const result = priceOf(b);
          const extras =
            (b.equipmentInsurance ? 1_000 : 0) + (b.workshop ? 2_000 : 0) + (b.glitter ? 2_000 : 0);
          expect(result.subtotalExcludingTax).toBe(bare.subtotalExcludingTax + extras);
        }),
      );
    });

    it("同じ時点を UTC で渡しても、JST で渡したときと同じ結果", () => {
      fc.assert(
        fc.property(booking, (b) => {
          const inJst = priceOf(b);
          const inUtc = priceOf(b, { start: startOf(b).toUTC(), end: endOf(b).toUTC() });
          expect(inUtc).toEqual(inJst);
        }),
      );
    });
  });
});
