// テストの改ざん防止のチェックを実行する。使い方：pnpm test-tamper [--base <ref>]（既定は origin/main）
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parsePendingList as parseListFile } from "./spec-coverage.ts";
import {
  type AutonomyConfig,
  checkTamper,
  describeTamperProblem,
  isStub,
  parseNameStatus,
} from "./test-tamper.ts";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const CONFIG_FILE = "harness/autonomy.json";
const EXPECTED_FAILURES_FILE = "harness/expected-failures.txt";

const baseIndex = process.argv.indexOf("--base");
const base = baseIndex >= 0 ? process.argv[baseIndex + 1] : "origin/main";
if (!base) throw new Error("--base の値がない");

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** 比較元にあるファイルを読む（なければ undefined） */
function readAtBase(file: string): string | undefined {
  try {
    return git("show", `${base}:${file}`);
  } catch {
    return undefined;
  }
}

function readWorking(file: string): string | undefined {
  try {
    return readFileSync(path.join(repoRoot, file), "utf8");
  } catch {
    return undefined;
  }
}

// 設定はPR側ではなく比較元（main）から読む。PRの中で設定を書き換えて、チェックをすり抜けられないようにする
function loadConfig(): AutonomyConfig {
  const atBase = readAtBase(CONFIG_FILE);
  if (atBase !== undefined) return JSON.parse(atBase) as AutonomyConfig;
  // 比較元にまだ設定がない場合（設定を最初に追加するPR）だけ、作業中のファイルを使う
  console.log(`比較元 ${base} に ${CONFIG_FILE} がないため、作業中のファイルを使う`);
  return JSON.parse(readWorking(CONFIG_FILE) ?? "{}") as AutonomyConfig;
}

const changes = parseNameStatus(git("diff", "--name-status", "--no-renames", `${base}...HEAD`));
const before = new Set(parseListFile(readAtBase(EXPECTED_FAILURES_FILE) ?? ""));
const addedExpectedFailures = parseListFile(readWorking(EXPECTED_FAILURES_FILE) ?? "").filter(
  (e) => !before.has(e),
);

// 足したファイルのうち、スタブ（型と「未実装」を投げる関数だけ）のもの。実装と数えない
const newStubs = changes
  .filter((c) => c.status === "A")
  .map((c) => c.path)
  .filter((file) => {
    const source = readWorking(file);
    return source !== undefined && isStub(file, source);
  });
if (newStubs.length > 0) console.log(`実装と数えないスタブ：${newStubs.join(", ")}`);

const problems = checkTamper(changes, loadConfig(), addedExpectedFailures, newStubs);

console.log(`比較元 ${base} からの変更：${changes.length} ファイル`);
if (problems.length > 0) {
  for (const p of problems) for (const line of describeTamperProblem(p)) console.error(line);
  process.exit(1);
}
console.log("✓ 既存の自律度「中」のテストの改ざんはない");
