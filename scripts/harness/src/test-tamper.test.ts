import { describe, expect, it } from "vitest";
import { checkTamper, classify } from "./test-tamper.ts";

const config = {
  medium: ["packages/booking-core/src/**", "packages/contracts/src/**", "apps/api/src/public/**"],
};

describe("PRで変更されたファイルを分類する", () => {
  it.each([
    ["packages/booking-core/src/availability.test.ts", "medium-test"],
    ["apps/api/src/public/reserve.int.test.ts", "medium-test"],
    ["apps/site-zebra/src/components/Header.test.ts", "other-test"],
    ["packages/booking-core/src/availability.ts", "implementation"],
    ["apps/site-zebra/src/pages/index.astro", "implementation"],
    ["apps/site-zebra/src/components/Header.tsx", "implementation"],
    ["docs/product-specs/booking.md", "other"],
    ["harness/autonomy.json", "other"],
    ["pnpm-lock.yaml", "other"],
  ] as const)("%s は %s", (file, kind) => {
    expect(classify(file, config)).toBe(kind);
  });
});

describe("自律度「中」のテストと実装の同時変更を見つける", () => {
  it("自律度「中」の領域のテストだけ → 成功（テストのPR。人間がレビュー）", () => {
    expect(checkTamper(["packages/booking-core/src/availability.test.ts"], config)).toEqual({
      ok: true,
    });
  });

  it("実装だけ → 成功（実装のPR）", () => {
    expect(checkTamper(["packages/booking-core/src/availability.ts"], config)).toEqual({
      ok: true,
    });
  });

  it("自律度「中」の領域のテストと実装の両方 → 失敗", () => {
    expect(
      checkTamper(
        [
          "packages/booking-core/src/availability.test.ts",
          "packages/booking-core/src/availability.ts",
        ],
        config,
      ),
    ).toEqual({
      ok: false,
      mediumTests: ["packages/booking-core/src/availability.test.ts"],
      implementations: ["packages/booking-core/src/availability.ts"],
    });
  });

  it("自律度「高」の領域のテストと実装の両方 → 成功", () => {
    expect(
      checkTamper(
        [
          "apps/site-zebra/src/components/Header.test.ts",
          "apps/site-zebra/src/components/Header.tsx",
        ],
        config,
      ),
    ).toEqual({ ok: true });
  });

  it("自律度「中」の領域のテストと仕様（docs） → 成功（仕様とテストを一緒に直すPR。人間がレビュー）", () => {
    expect(
      checkTamper(
        ["packages/booking-core/src/availability.test.ts", "docs/product-specs/booking.md"],
        config,
      ),
    ).toEqual({ ok: true });
  });

  it("自律度「中」の領域のテストと、別の領域の実装 → 失敗（実装の場所を問わない）", () => {
    const result = checkTamper(
      ["packages/booking-core/src/availability.test.ts", "apps/admin/src/App.tsx"],
      config,
    );
    expect(result.ok).toBe(false);
  });

  it("自律度「中」の領域のテストの削除も、変更として数える", () => {
    // git diff --name-only は削除されたファイルも列挙するので、同じ扱いになる
    const result = checkTamper(
      ["packages/contracts/src/schema.test.ts", "packages/contracts/src/schema.ts"],
      config,
    );
    expect(result.ok).toBe(false);
  });
});
