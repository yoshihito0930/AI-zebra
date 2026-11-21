import { describe, expect, it } from "vitest";
import { parseStudioTel } from "./studio-tel";

// 電話番号はすべて架空のもの
describe("スタジオの電話番号（PUBLIC_STUDIO_TEL）", () => {
  it("ない・空・空白だけなら出さない", () => {
    expect(parseStudioTel(undefined)).toBeUndefined();
    expect(parseStudioTel("")).toBeUndefined();
    expect(parseStudioTel("  ")).toBeUndefined();
  });

  it("数字とハイフンなら、そのまま出し、tel: のリンクはハイフンを外す", () => {
    expect(parseStudioTel("000-0000-0000")).toEqual({
      label: "000-0000-0000",
      href: "tel:00000000000",
    });
    expect(parseStudioTel(" 00000000000 ")).toEqual({
      label: "00000000000",
      href: "tel:00000000000",
    });
    expect(parseStudioTel("+81-00-0000-0000")).toEqual({
      label: "+81-00-0000-0000",
      href: "tel:+810000000000",
    });
  });

  it("番号でない値は組み立てを止める", () => {
    for (const value of [
      "（電話番号）",
      "000-0000-000a",
      "000 0000 0000",
      "-000",
      "000-",
      "tel:000",
    ]) {
      expect(() => parseStudioTel(value)).toThrow("PUBLIC_STUDIO_TEL");
    }
  });
});
