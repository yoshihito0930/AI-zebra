// 失敗予定リストの正直さを確かめる。使い方：pnpm expected-failures（統合テストが載っていれば先に pnpm db:up）
// リストのテストが存在し、まだ失敗することを確かめる。通るようになったテストがあれば、リストから消すよう失敗させる。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parsePendingList as parseListFile } from "./spec-coverage.ts";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const LIST = "harness/expected-failures.txt";

const entries = parseListFile(readFileSync(path.join(repoRoot, LIST), "utf8"));
const problems: string[] = [];

for (const entry of entries) {
  if (!existsSync(path.join(repoRoot, entry))) {
    problems.push(`✗ ${entry} が存在しない。リストから消す`);
    continue;
  }
  const config = entry.includes(".int.test.") ? "vitest.int.config.ts" : "vitest.config.ts";
  const run = spawnSync("pnpm", ["exec", "vitest", "run", "--config", config, entry], {
    cwd: repoRoot,
    encoding: "utf8",
    // 失敗予定リストのテストも対象に含めて動かす（vitest の設定がこの変数を見る）
    env: { ...process.env, ZEBRA_RUN_EXPECTED_FAILURES: "1" },
  });
  if (run.status === 0) {
    problems.push(`✗ ${entry} が通るようになった。実装のPRで、リストからこの行を消す`);
  } else {
    console.log(`・${entry}：まだ失敗する（予定どおり）`);
  }
}

console.log(`失敗予定リスト：${entries.length} ファイル`);
if (problems.length > 0) {
  for (const p of problems) console.error(p);
  process.exit(1);
}
console.log("✓ 失敗予定リストのテストは、すべて存在し、まだ失敗する");
