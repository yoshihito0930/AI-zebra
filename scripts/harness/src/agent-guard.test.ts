import { describe, expect, it } from "vitest";
import { decide } from "./agent-guard.js";

const root = "/repo";

describe("実装担当のガード", () => {
  const d = (tool: string, input: Record<string, unknown>) =>
    decide("implementer", tool, input, root);

  it.each([
    ["Edit", "/repo/packages/booking-core/src/availability.test.ts"],
    ["Write", "/repo/apps/api/src/db/client.int.test.ts"],
    ["MultiEdit", "/repo/apps/site-zebra/src/x.test.tsx"],
  ])("%s でテストファイル %s を変更しようとしたら止める", (tool, file) => {
    expect(d(tool, { file_path: file })).toMatch(/テストファイル/);
  });

  it("実装ファイルの変更は許す", () => {
    expect(
      d("Edit", { file_path: "/repo/packages/booking-core/src/availability.ts" }),
    ).toBeUndefined();
  });

  it("テストファイルを読むのは許す", () => {
    expect(
      d("Read", { file_path: "/repo/packages/booking-core/src/availability.test.ts" }),
    ).toBeUndefined();
  });

  it.each([
    "sed -i 's/a/b/' packages/booking-core/src/availability.test.ts",
    "echo x > packages/booking-core/src/availability.test.ts",
    "rm packages/booking-core/src/availability.test.ts",
    "git checkout main -- packages/booking-core/src/availability.test.ts",
  ])("シェルからテストファイルを変更するコマンドは止める：%s", (command) => {
    expect(d("Bash", { command })).toMatch(/テストファイル/);
  });

  it.each([
    "pnpm test",
    "cat packages/booking-core/src/availability.test.ts",
    "pnpm vitest run packages/booking-core/src/availability.test.ts",
  ])("テストを読む・動かすコマンドは許す：%s", (command) => {
    expect(d("Bash", { command })).toBeUndefined();
  });
});

describe("テスト担当のガード", () => {
  const d = (tool: string, input: Record<string, unknown>) =>
    decide("test-writer", tool, input, root);

  it.each([
    "/repo/packages/booking-core/src/availability.ts",
    "/repo/apps/api/src/app.ts",
    "/repo/apps/site-zebra/src/pages/index.astro",
  ])("実装 %s を読もうとしたら止める", (file) => {
    expect(d("Read", { file_path: file })).toMatch(/実装/);
  });

  it.each([
    "/repo/docs/product-specs/booking.md",
    "/repo/packages/contracts/src/index.ts",
    "/repo/packages/booking-core/src/availability.test.ts",
    "/repo/docs/TESTING.md",
    "/repo/packages/booking-core/package.json",
  ])("仕様・契約・テスト・設定 %s を読むのは許す", (file) => {
    expect(d("Read", { file_path: file })).toBeUndefined();
  });

  it.each([
    "/repo/packages/booking-core/src/availability.test.ts",
    "/repo/apps/api/src/public/reserve.int.test.ts",
    "/repo/harness/spec-coverage-pending.txt",
    "/repo/harness/expected-failures.txt",
    "/repo/docs/product-specs/booking.md",
  ])("テスト・保留リスト・仕様 %s を書くのは許す", (file) => {
    expect(d("Write", { file_path: file })).toBeUndefined();
  });

  it.each([
    "/repo/packages/booking-core/src/availability.ts",
    "/repo/harness/autonomy.json",
    "/repo/docs/design-docs/core-beliefs.md",
    "/tmp/x.ts",
  ])("テスト以外の %s を書こうとしたら止める", (file) => {
    expect(d("Edit", { file_path: file })).toMatch(/書けるのは/);
  });

  it.each([
    "cat packages/booking-core/src/availability.ts",
    "grep -n availability apps/api/src/app.ts",
  ])("シェルから実装を読むコマンドは止める：%s", (command) => {
    expect(d("Bash", { command })).toMatch(/実装/);
  });

  it.each([
    "pnpm test",
    "cat packages/contracts/src/index.ts",
    "pnpm vitest run packages/booking-core",
  ])("テストの実行や契約を読むコマンドは許す：%s", (command) => {
    expect(d("Bash", { command })).toBeUndefined();
  });
});

describe("テスト担当のスタブ", () => {
  const exists = (p: string) => p === "packages/booking-core/src/fee.ts";
  const d = (tool: string, file: string) =>
    decide("test-writer", tool, { file_path: `/repo/${file}` }, root, exists);

  it("まだない実装ファイルを Write で作るのは許す（スタブ）", () => {
    expect(d("Write", "packages/booking-core/src/availability.ts")).toBeUndefined();
  });

  it("すでにある実装ファイルを Write で上書きしようとしたら止める", () => {
    expect(d("Write", "packages/booking-core/src/fee.ts")).toMatch(/書けるのは/);
  });

  it("まだない実装ファイルでも Edit は止める（Write で作る）", () => {
    expect(d("Edit", "packages/booking-core/src/availability.ts")).toMatch(/書けるのは/);
  });
});

describe("役割の指定", () => {
  it("知らない役割は止める", () => {
    expect(decide("unknown", "Read", { file_path: "/repo/x" }, root)).toMatch(/不明な役割/);
  });
});
