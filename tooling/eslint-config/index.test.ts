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
