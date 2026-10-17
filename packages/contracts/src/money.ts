// 金額の型（INV-9）。金額は整数（円）で扱い、浮動小数で計算しない。
// 公開APIの見積額と、booking-core の料金・キャンセル料の計算で同じ型を使う。
import { z } from "zod";

/** 0以上の整数の円。Yen.parse を通した値だけが Yen になる */
export const Yen = z.number().int().nonnegative().brand<"Yen">();
export type Yen = z.infer<typeof Yen>;
