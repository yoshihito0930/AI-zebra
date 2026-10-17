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
    "pnpm check && echo x >> packages/booking-core/src/availability.test.ts",
    "cat <<'EOF' > packages/booking-core/src/availability.test.ts\nx\nEOF",
    ": hook-check.test.ts > /dev/null",
  ])("シェルからテストファイルを変更するコマンドは止める：%s", (command) => {
    expect(d("Bash", { command })).toMatch(/テストファイル/);
  });

  it.each([
    "pnpm test",
    "cat packages/booking-core/src/availability.test.ts",
    "pnpm vitest run packages/booking-core/src/availability.test.ts",
    "pnpm vitest run packages/booking-core/src/availability.test.ts 2>&1 | tail -20",
  ])("テストを読む・動かすコマンドは許す：%s", (command) => {
    expect(d("Bash", { command })).toBeUndefined();
  });

  // 2026-10-17 に実際に止まったコマンド（docs/harness-log.md）
  it.each([
    "sed -i '\\#^packages/booking-core/src/time-unit-and-duration.test.ts$#d' harness/expected-failures.txt; cat harness/expected-failures.txt",
    "git add -A && git commit -q -F - <<'EOF'\nfeat: x\n\ntime-unit-and-duration.test.ts を失敗予定リストから外す\nEOF\ngit push 2>&1 | tail -2",
    "cat >> docs/harness-log.md <<'EOF'\n- packages/booking-core/src/time-unit-and-duration.test.ts を消す `sed -i`\nEOF",
  ])(
    "テストのパスが、書き換え先ではなく引用符やヒアドキュメントの中にあるだけなら許す：%s",
    (command) => {
      expect(d("Bash", { command })).toBeUndefined();
    },
  );
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
    "pnpm test && cat packages/booking-core/src/availability.ts",
  ])("シェルから実装を読むコマンドは止める：%s", (command) => {
    expect(d("Bash", { command })).toMatch(/実装/);
  });

  it.each([
    "pnpm test",
    "cat packages/contracts/src/index.ts",
    "pnpm vitest run packages/booking-core",
    // 2026-10-17 に実際に止まったコマンド（docs/harness-log.md）
    "git add packages/booking-core/src/time-unit-and-duration.ts harness/expected-failures.txt && git push 2>&1 | tail -2",
    'gh pr create --body "スタブ：packages/booking-core/src/time-unit-and-duration.ts" | head -1',
  ])("テストの実行や契約を読むコマンドは許す：%s", (command) => {
    expect(d("Bash", { command })).toBeUndefined();
  });

  it.each([
    // 2026-10-17 に実際に通ってしまったコマンド（docs/harness-log.md）
    "git checkout -b test/x && pnpm add -D -w fast-check 2>&1 | tail -5",
    'sed -i \'s/"fast-check": "^4.10.2"/"fast-check": "4.10.2"/\' package.json',
    "pnpm --filter @zebra/booking-core add luxon",
    "npm install fast-check",
    "npm i -D fast-check",
    "pnpm install -D -w fast-check",
    "pnpm remove zod",
    "echo '{}' > packages/booking-core/package.json",
  ])("依存を変えるコマンドは止める：%s", (command) => {
    expect(d("Bash", { command })).toMatch(/依存/);
  });

  it.each([
    "pnpm install",
    "pnpm install --frozen-lockfile",
    "cat package.json packages/booking-core/package.json",
    "pnpm --filter @zebra/booking-core typecheck",
    "pnpm vitest run packages/booking-core/src/add.test.ts",
  ])("依存を変えないコマンドは許す：%s", (command) => {
    expect(d("Bash", { command })).toBeUndefined();
  });

  it("スクラッチパッドに書くのは許す（PR 本文の下書きなど）", () => {
    expect(
      d("Write", { file_path: "/tmp/claude-0/-repo/3dbb3d1e/scratchpad/pr-body.md" }),
    ).toBeUndefined();
  });

  it.each([
    "/root/.claude/settings.json",
    "/tmp/claude-0/-repo/3dbb3d1e/scratchpad/../../../../root/.claude/settings.json",
    "/tmp/claude-0/-repo/3dbb3d1e/tasks/x.md",
  ])("スクラッチパッド以外のリポジトリの外 %s は止める", (file) => {
    expect(d("Write", { file_path: file })).toMatch(/書けるのは/);
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

describe("テスト担当が、そのブランチで作ったスタブを直す", () => {
  // fee.ts は main にある実装。second-hold.ts はこのブランチで作ったスタブ（作業ツリーにあり、main にない）
  const inTree = new Set([
    "packages/booking-core/src/fee.ts",
    "packages/booking-core/src/second-hold.ts",
  ]);
  const exists = (p: string) => inTree.has(p);
  const onMain = (p: string) => p === "packages/booking-core/src/fee.ts";
  const d = (tool: string, input: Record<string, unknown>) =>
    decide("test-writer", tool, input, root, exists, onMain);
  const stub = "/repo/packages/booking-core/src/second-hold.ts";
  const onMainImpl = "/repo/packages/booking-core/src/fee.ts";

  it.each(["Read", "Edit", "Write"])("そのブランチのスタブは %s してよい", (tool) => {
    expect(d(tool, { file_path: stub })).toBeUndefined();
  });

  it("そのブランチのスタブは、シェルから読んでよい", () => {
    expect(d("Bash", { command: "cat packages/booking-core/src/second-hold.ts" })).toBeUndefined();
  });

  it("main にある実装は、読むのも書くのも止める", () => {
    expect(d("Read", { file_path: onMainImpl })).toMatch(/読まない/);
    expect(d("Edit", { file_path: onMainImpl })).toMatch(/書けるのは/);
    expect(d("Write", { file_path: onMainImpl })).toMatch(/書けるのは/);
    expect(d("Bash", { command: "cat packages/booking-core/src/fee.ts" })).toMatch(/読まない/);
  });

  it("ないファイルの Read は止める（起動時の自己確認で使う）", () => {
    expect(d("Read", { file_path: "/repo/packages/booking-core/src/hook-check.ts" })).toMatch(
      /読まない/,
    );
  });
});

describe("役割の指定", () => {
  it("知らない役割は止める", () => {
    expect(decide("unknown", "Read", { file_path: "/repo/x" }, root)).toMatch(/不明な役割/);
  });
});
