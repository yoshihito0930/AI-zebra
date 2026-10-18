import path from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const eslint = new ESLint({ cwd: repoRoot });

async function ruleIds(file: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(repoRoot, file) });
  return (result?.messages ?? []).map((m) => m.ruleId ?? "parse-error");
}

describe("INV-7：現在時刻は packages/clock からだけ取得する", () => {
  it.each([
    ["Date.now()", "export const t = Date.now();"],
    ["引数なしの new Date()", "export const t = new Date();"],
    ["Date()", "export const t = Date();"],
  ])("packages/booking-core で %s はエラー", async (_, code) => {
    expect(await ruleIds("packages/booking-core/src/x.ts", code)).toContain("no-restricted-syntax");
  });

  it("引数ありの new Date(...) はエラーにしない（現在時刻ではないため）", async () => {
    const code = 'export const t = new Date("2026-10-20T06:00:00Z");';
    expect(await ruleIds("packages/booking-core/src/x.ts", code)).toEqual([]);
  });

  it("packages/clock の中では Date.now() を使える", async () => {
    expect(await ruleIds("packages/clock/src/x.ts", "export const t = Date.now();")).toEqual([]);
  });
});

describe("INV-7：日時ライブラリは Luxon だけ", () => {
  it.each(["dayjs", "date-fns", "moment", "@date-fns/tz", "@js-temporal/polyfill"])(
    "%s の import はエラー",
    async (lib) => {
      const code = `import x from "${lib}";\nexport default x;`;
      expect(await ruleIds("apps/api/src/x.ts", code)).toContain("no-restricted-imports");
    },
  );

  it("luxon の import はエラーにしない", async () => {
    const code = 'import { DateTime } from "luxon";\nexport default DateTime;';
    expect(await ruleIds("packages/booking-core/src/x.ts", code)).toEqual([]);
  });

  it("apps/api/src/mail の中でも、Luxon 以外の日時ライブラリはエラー", async () => {
    const code = 'import x from "dayjs";\nexport default x;';
    expect(await ruleIds("apps/api/src/mail/x.ts", code)).toContain("no-restricted-imports");
  });
});

describe("INV-6：SES を呼べるのは apps/api/src/mail の中だけ", () => {
  const code = 'import { SESv2Client } from "@aws-sdk/client-sesv2";\nexport default SESv2Client;';

  it("apps/api/src/mail の中では使える", async () => {
    expect(await ruleIds("apps/api/src/mail/send.ts", code)).toEqual([]);
  });

  it.each([
    "apps/api/src/public/reserve.ts",
    "packages/booking-core/src/x.ts",
    "apps/admin/src/x.ts",
  ])("%s ではエラー", async (file) => {
    expect(await ruleIds(file, code)).toContain("no-restricted-imports");
  });

  it("@aws-sdk/client-ses（v1 のクライアント）も同じくエラー", async () => {
    const v1 = 'import { SESClient } from "@aws-sdk/client-ses";\nexport default SESClient;';
    expect(await ruleIds("apps/api/src/x.ts", v1)).toContain("no-restricted-imports");
  });
});

describe("INV-9：金額は整数で扱い、端数の処理は決めた場所だけ", () => {
  it.each([
    ["小数のリテラル", "export const rate = 1.1;"],
    ["Math.round", "export const f = (x: number) => Math.round(x);"],
    ["Math.floor", "export const f = (x: number) => Math.floor(x);"],
    ["Math.ceil", "export const f = (x: number) => Math.ceil(x);"],
    ["Math.trunc", "export const f = (x: number) => Math.trunc(x);"],
    ["toFixed", "export const f = (x: number) => x.toFixed(0);"],
    ["parseFloat", 'export const x = parseFloat("1.5");'],
    ["Number.parseFloat", 'export const x = Number.parseFloat("1.5");'],
    ["割り算", "export const f = (x: number) => x / 10;"],
    ["割り算の代入", "export const f = (x: number) => { let y = x; y /= 10; return y; };"],
  ])("packages/booking-core で %s はエラー", async (_, code) => {
    expect(await ruleIds("packages/booking-core/src/x.ts", code)).toContain("no-restricted-syntax");
  });

  it("packages/contracts でも割り算はエラー", async () => {
    const code = "export const f = (x: number) => x / 10;";
    expect(await ruleIds("packages/contracts/src/x.ts", code)).toContain("no-restricted-syntax");
  });

  it.each([
    ["整数の掛け算と余り", "export const f = (x: number) => (x * 11) % 10;"],
    ["区切りのある整数", "export const yen = 2_500;"],
    ["小数点を含む文字列", 'export const v = "1.1";'],
  ])("%s はエラーにしない", async (_, code) => {
    expect(await ruleIds("packages/booking-core/src/x.ts", code)).toEqual([]);
  });

  it("理由を書いた eslint-disable のコメントがあれば、割り算を使える（決めた場所）", async () => {
    const code =
      "export const f = (x: number) =>\n  // eslint-disable-next-line no-restricted-syntax -- INV-9：ここだけで切り捨てる\n  (x - (x % 10)) / 10;";
    expect(await ruleIds("packages/booking-core/src/x.ts", code)).toEqual([]);
  });

  it("テストファイルでは小数を使える（期待値や、通さない値を書くため）", async () => {
    expect(
      await ruleIds("packages/booking-core/src/x.test.ts", "export const x = 28737.5;"),
    ).toEqual([]);
  });

  it("金額を計算しない UI のコードでは小数を使える", async () => {
    expect(await ruleIds("apps/admin/src/x.ts", "export const opacity = 0.5;")).toEqual([]);
  });

  it("金額のルールを足しても、packages/booking-core の Date.now() は引き続きエラー", async () => {
    expect(
      await ruleIds("packages/booking-core/src/x.ts", "export const t = Date.now();"),
    ).toContain("no-restricted-syntax");
  });
});

describe("Node で動かすコードの相対 import には拡張子を付ける", () => {
  it.each([
    ["packages/contracts/src/x.ts", 'export { Yen } from "./money";'],
    [
      "packages/booking-core/src/x.ts",
      'import { usageDate } from "./jst-time";\nexport const f = usageDate;',
    ],
    ["apps/api/src/x.ts", 'export * from "./db/client";'],
    ["packages/booking-core/src/x.ts", 'export const m = import("./jst-time");'],
  ])("%s の拡張子のない相対 import はエラー", async (file, code) => {
    expect(await ruleIds(file, code)).toContain("no-restricted-syntax");
  });

  it.each([
    'export { Yen } from "./money.ts";',
    'import { DateTime } from "luxon";\nexport const d = DateTime;',
    'export { z } from "zod";',
  ])("拡張子付きの相対 import とパッケージの import はエラーにしない：%s", async (code) => {
    expect(await ruleIds("packages/contracts/src/x.ts", code)).toEqual([]);
  });

  it("テストファイルは対象外（Vitest が解決するため）", async () => {
    expect(
      await ruleIds("packages/contracts/src/x.test.ts", 'export { Yen } from "./money";'),
    ).toEqual([]);
  });

  it("packages/clock でも止め、Date.now() は今までどおり使える", async () => {
    expect(await ruleIds("packages/clock/src/x.ts", 'export * from "./y";')).toContain(
      "no-restricted-syntax",
    );
    expect(await ruleIds("packages/clock/src/x.ts", "export const t = Date.now();")).toEqual([]);
  });
});
