// 今の料金表（docs/product-specs/booking.md「料金」の「料金表」）。
// 当面はリポジトリのこの1ファイルに置く。
// 変えるときは、このファイルと booking.md の単価の表・例を一緒に直す。
import { PriceTable } from "@zebra/contracts";

// 今の料金表のデータ。返すときに PriceTable.parse で形（整数の円、id の重なり、最後の規則が条件なし）を確かめる
const CURRENT_PRICE_TABLE_DATA = {
  plans: [
    { id: "A", name: "プランA", halfHourRates: { normal: 2_500, lateNight: 3_750 } },
    { id: "B", name: "プランB", halfHourRates: { normal: 2_750, lateNight: 4_125 } },
  ],
  // 10人以下、またはホリゾントの床面を全面養生するならプランA、それ以外はプランB
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
} as const;

/**
 * 今の料金表を返す。
 * 呼ぶたびに parse した新しい値を返すので、呼び出し側が値を書き換えても、ほかの呼び出しには影響しない
 */
export function currentPriceTable(): PriceTable {
  return PriceTable.parse(CURRENT_PRICE_TABLE_DATA);
}
