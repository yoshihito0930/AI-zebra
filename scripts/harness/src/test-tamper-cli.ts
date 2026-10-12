// テストの改ざん防止のチェックを実行する。使い方：pnpm test-tamper [--base <ref>]（既定は origin/main）
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { type AutonomyConfig, checkTamper } from "./test-tamper.ts";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const CONFIG_FILE = "harness/autonomy.json";

const baseIndex = process.argv.indexOf("--base");
const base = baseIndex >= 0 ? process.argv[baseIndex + 1] : "origin/main";
if (!base) throw new Error("--base の値がない");

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// 設定はPR側ではなく比較元（main）から読む。PRの中で設定を書き換えて、チェックをすり抜けられないようにする
function loadConfig(): AutonomyConfig {
  try {
    return JSON.parse(git("show", `${base}:${CONFIG_FILE}`)) as AutonomyConfig;
  } catch {
    // 比較元にまだ設定がない場合（設定を最初に追加するPR）だけ、作業中のファイルを使う
    console.log(`比較元 ${base} に ${CONFIG_FILE} がないため、作業中のファイルを使う`);
    return JSON.parse(readFileSync(path.join(repoRoot, CONFIG_FILE), "utf8")) as AutonomyConfig;
  }
}

const changed = git("diff", "--name-only", "--no-renames", `${base}...HEAD`)
  .split("\n")
  .filter((l) => l !== "");
const result = checkTamper(changed, loadConfig());

console.log(`比較元 ${base} からの変更：${changed.length} ファイル`);
if (!result.ok) {
  console.error("✗ 自律度「中」の領域のテストと実装を、同じPRで変更している（docs/TESTING.md）");
  console.error("  テストの変更は、テストだけのPRに分ける");
  console.error(`  テスト：${result.mediumTests.join(", ")}`);
  console.error(`  実装：${result.implementations.join(", ")}`);
  process.exit(1);
}
console.log("✓ 自律度「中」の領域のテストと実装の同時変更はない");
