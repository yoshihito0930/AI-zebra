// 例の網羅のチェックを実行する。使い方：pnpm spec-coverage
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  describeProblem,
  evaluateCoverage,
  extractDescribeNames,
  extractExampleSections,
  parsePendingList,
} from "./spec-coverage.ts";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const SPEC_DIR = "docs/product-specs";
const PENDING_FILE = "harness/spec-coverage-pending.txt";
const TEST_ROOTS = ["apps", "packages", "tooling", "scripts"];
// このチェック自身のテストは、例の文字列をデータとして含むので数えない
const IGNORED = /(^|\/)(node_modules|dist|coverage)\/|^scripts\/harness\//;

function listFiles(dir: string, match: RegExp): string[] {
  let entries: string[];
  try {
    entries = readdirSync(path.join(repoRoot, dir), { recursive: true }) as string[];
  } catch {
    return [];
  }
  return entries
    .map((e) => path.posix.join(dir, e.split(path.sep).join("/")))
    .filter((f) => match.test(f) && !IGNORED.test(f));
}

const read = (f: string) => readFileSync(path.join(repoRoot, f), "utf8");

const sections = listFiles(SPEC_DIR, /\.md$/).flatMap((f) => extractExampleSections(read(f)));
const describeNames = TEST_ROOTS.flatMap((d) => listFiles(d, /\.test\.[cm]?[jt]sx?$/)).flatMap(
  (f) => extractDescribeNames(read(f)),
);
const pending = parsePendingList(read(PENDING_FILE));

const problems = evaluateCoverage({ sections, describeNames, pending });
const covered = sections.filter((s) => describeNames.includes(s)).length;
console.log(`例のある節：${sections.length}（テストあり ${covered}、保留 ${pending.length}）`);

if (problems.length > 0) {
  for (const p of problems) console.error(`✗ ${describeProblem(p)}`);
  process.exit(1);
}
console.log("✓ 例のある節は、すべてテストがあるか保留リストにある");
