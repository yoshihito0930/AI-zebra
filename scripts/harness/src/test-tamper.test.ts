import { describe, expect, it } from "vitest";
import { type Change, checkTamper, classify, isStub, parseNameStatus } from "./test-tamper.ts";

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

// PR #60 のスタブ（second-hold-application-deadline.ts）と同じ形
const STUB_SOURCE = `// 第二キープ申込の締め切り
import type { DateTime } from "luxon";

export type Input = {
  /** 開始 */
  start: DateTime;
  appliedAt: DateTime;
};
export interface Options { strict: boolean }
export type Result = { ok: true } | { ok: false; reason: "past-provisional-deadline" };
export type { Other } from "./other.ts";

export function check(input: Input): Result;
export function check(input: Input, options?: Options): Result {
  void input;
  void options;
  throw new Error("未実装");
}
function helper(): void {
  throw new Error("未実装");
}
`;

describe("スタブ（型と「未実装」を投げる関数だけ）を見分ける", () => {
  it("型の宣言・import・型だけの export・「未実装」を投げる関数だけ → スタブ", () => {
    expect(isStub("packages/booking-core/src/deadline.ts", STUB_SOURCE)).toBe(true);
  });

  it("型の宣言だけ → スタブ（振る舞いを持たない）", () => {
    expect(isStub("packages/booking-core/src/types.ts", "export type A = { x: number };\n")).toBe(
      true,
    );
  });

  it.each([
    ["中身で計算している", `export function f(a: number): number {\n  return a + 1;\n}\n`],
    [
      "「未実装」を投げる前に、ほかの文がある",
      `export function f(a: number): number {\n  if (a > 0) return a;\n  throw new Error("未実装");\n}\n`,
    ],
    [
      "「未実装」でないエラーを投げる",
      `export function f(): void {\n  throw new Error("not implemented");\n}\n`,
    ],
    ["値の宣言（const）がある", `export const RATE = 10;\n`],
    ["Zod のスキーマ（値）がある", `import { z } from "zod";\nexport const A = z.string();\n`],
    ["アロー関数の const", `export const f = () => {\n  throw new Error("未実装");\n};\n`],
    ["enum がある", `export enum Kind {\n  A,\n}\n`],
    ["値の re-export がある", `export { f } from "./f.ts";\n`],
    ["トップレベルの文がある", `console.log("x");\n`],
  ])("%s → スタブではない", (_, source) => {
    expect(isStub("packages/booking-core/src/x.ts", source)).toBe(false);
  });

  it(".ts 以外 → スタブではない", () => {
    expect(isStub("apps/site-zebra/src/pages/index.astro", "")).toBe(false);
    expect(isStub("apps/admin/src/App.tsx", "export type A = string;\n")).toBe(false);
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

  it("実装を含まないPRで、そのPRで変更したテストを失敗予定リストに足す → 成功（仕様の変更で振る舞いを変えるときの、テストを直すPR）", () => {
    const changes = [
      M(TEST),
      M("docs/product-specs/booking.md"),
      M("harness/expected-failures.txt"),
    ];
    expect(checkTamper(changes, config, [TEST])).toEqual([]);
  });

  it("実装を含まないPRでも、そのPRで変更していない既存のテストを失敗予定リストに足す → 失敗", () => {
    const other = "packages/booking-core/src/pricing.test.ts";
    expect(checkTamper([M(TEST), M("harness/expected-failures.txt")], config, [other])).toEqual([
      { kind: "expected-failure-not-new", entries: [other] },
    ]);
  });

  it("実装を含むPRで、そのPRで変更したテストを失敗予定リストに足す → 失敗（両方の問題）", () => {
    expect(
      checkTamper([M(TEST), M(IMPL), M("harness/expected-failures.txt")], config, [TEST]),
    ).toEqual([
      { kind: "existing-test-changed", tests: [TEST], implementations: [IMPL] },
      { kind: "expected-failure-not-new", entries: [TEST] },
    ]);
  });

  it("既存のテストの変更と、新しいスタブ → 成功（スタブは実装と数えない。PR #38・#60/#61）", () => {
    const stub = "packages/booking-core/src/deadline.ts";
    expect(checkTamper([M(TEST), A(stub)], config, [], [stub])).toEqual([]);
  });

  it("新しいスタブと、新しいテストと、そのPRで変更したテストを失敗予定リストに足す → 成功（実装を含まないPR）", () => {
    const stub = "packages/booking-core/src/deadline.ts";
    const newTest = "packages/booking-core/src/deadline.test.ts";
    const changes = [A(stub), A(newTest), M(TEST), M("harness/expected-failures.txt")];
    expect(checkTamper(changes, config, [newTest, TEST], [stub])).toEqual([]);
  });

  it("既存のテストの変更と、新しいスタブと、実装 → 失敗（実装だけを挙げる）", () => {
    const stub = "packages/booking-core/src/deadline.ts";
    expect(checkTamper([M(TEST), A(stub), M(IMPL)], config, [], [stub])).toEqual([
      { kind: "existing-test-changed", tests: [TEST], implementations: [IMPL] },
    ]);
  });

  it("既存のファイルは、スタブとして渡されても実装と数える（足したファイルだけを見る）", () => {
    expect(checkTamper([M(TEST), M(IMPL)], config, [], [IMPL])).toHaveLength(1);
  });

  it("消したテストを失敗予定リストに足す → 失敗", () => {
    expect(checkTamper([D(TEST), M("harness/expected-failures.txt")], config, [TEST])).toEqual([
      { kind: "expected-failure-not-new", entries: [TEST] },
    ]);
  });
});
