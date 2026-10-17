// 今の料金表（docs/product-specs/booking.md「料金」の「料金表」）。
// 実データは実装担当がこのファイルに書く（docs/TESTING.md の手順4）。
// 変えるときは、このファイルと booking.md の単価の表・例を一緒に直す。
import type { PriceTable } from "@zebra/contracts";

/** 今の料金表を返す */
export function currentPriceTable(): PriceTable {
  throw new Error("未実装");
}
