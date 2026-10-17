import { describe, expect, it } from "vitest";
import { Yen } from "./money";

describe("金額の型（INV-9）", () => {
  it.each([0, 1, 28737, 65450])("0以上の整数 %d は Yen として通す", (value) => {
    expect(Yen.parse(value)).toBe(value);
  });

  it.each([28737.5, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "整数でない・負の値 %d は通さない",
    (value) => {
      expect(Yen.safeParse(value).success).toBe(false);
    },
  );
});
