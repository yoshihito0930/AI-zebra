import { describe, expect, it } from "vitest";
import { type Change, checkTamper, classify, parseNameStatus } from "./test-tamper.ts";

const config = {
  medium: ["packages/booking-core/src/**", "packages/contracts/src/**", "apps/api/src/public/**"],
};
const A = (path: string): Change => ({ status: "A", path });
const M = (path: string): Change => ({ status: "M", path });
const D = (path: string): Change => ({ status: "D", path });

const TEST = "packages/booking-core/src/availability.test.ts";
const IMPL = "packages/booking-core/src/availability.ts";

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

describe("git diff --name-status を読む", () => {
  it("追加・変更・削除・種類の変更を読む", () => {
    expect(parseNameStatus("A\ta.ts\nM\tb.ts\nD\tc.ts\nT\td.ts\n")).toEqual([
      A("a.ts"),
      M("b.ts"),
      D("c.ts"),
      M("d.ts"),
    ]);
  });
});

describe("既存の自律度「中」のテストの改ざんを見つける", () => {
  it("新しいテストとスタブ（実装）と失敗予定リストの追加 → 成功（テストのPR）", () => {
    expect(
      checkTamper([A(TEST), A(IMPL), M("harness/expected-failures.txt")], config, [TEST]),
    ).toEqual([]);
  });

  it("実装だけと失敗予定リストからの削除 → 成功（実装のPR）", () => {
    expect(checkTamper([M(IMPL), M("harness/expected-failures.txt")], config, [])).toEqual([]);
  });

  it("既存のテストの変更だけ → 成功（テストを直すPR。人間がレビュー）", () => {
    expect(checkTamper([M(TEST)], config)).toEqual([]);
  });

  it("既存のテストの変更と実装 → 失敗", () => {
    expect(checkTamper([M(TEST), M(IMPL)], config)).toEqual([
      { kind: "existing-test-changed", tests: [TEST], implementations: [IMPL] },
    ]);
  });

  it("既存のテストの削除と実装 → 失敗", () => {
    expect(checkTamper([D(TEST), M(IMPL)], config)).toEqual([
      { kind: "existing-test-changed", tests: [TEST], implementations: [IMPL] },
    ]);
  });

  it("既存のテストの変更と、別の領域の実装 → 失敗（実装の場所を問わない）", () => {
    expect(checkTamper([M(TEST), M("apps/admin/src/App.tsx")], config)).toHaveLength(1);
  });

  it("自律度「高」の領域のテストと実装の両方 → 成功", () => {
    const changes = [
      M("apps/site-zebra/src/components/Header.test.ts"),
      M("apps/site-zebra/src/components/Header.tsx"),
    ];
    expect(checkTamper(changes, config)).toEqual([]);
  });

  it("既存のテストと仕様（docs） → 成功（仕様とテストを一緒に直すPR。人間がレビュー）", () => {
    expect(checkTamper([M(TEST), M("docs/product-specs/booking.md")], config)).toEqual([]);
  });

  it("既存のテストを失敗予定リストに足す → 失敗（レビュー済みのテストを隠せない）", () => {
    expect(checkTamper([M(IMPL), M("harness/expected-failures.txt")], config, [TEST])).toEqual([
      { kind: "expected-failure-not-new", entries: [TEST] },
    ]);
  });
});
