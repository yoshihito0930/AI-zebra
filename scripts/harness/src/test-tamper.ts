// テストの改ざん防止のチェック（docs/TESTING.md「実装PRでテストを変更させない」）。
// ファイルを読み書きしない純粋な関数だけを置く。git と設定ファイルの読み込みは test-tamper-cli.ts で行う。
import { matchesGlob } from "node:path";

export type AutonomyConfig = {
  /** 自律度「中」の領域のパス（glob） */
  medium: readonly string[];
};

/** git diff --name-status --no-renames の1行。A：追加、M：変更、D：削除 */
export type Change = { status: "A" | "M" | "D"; path: string };

const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const CODE_FILE = /\.([cm]?[jt]sx?|astro)$/;
const CODE_ROOTS = /^(apps|packages|tooling|scripts)\//;

export type FileKind = "medium-test" | "other-test" | "implementation" | "other";

export function classify(file: string, config: AutonomyConfig): FileKind {
  if (TEST_FILE.test(file)) {
    return config.medium.some((g) => matchesGlob(file, g)) ? "medium-test" : "other-test";
  }
  if (CODE_ROOTS.test(file) && CODE_FILE.test(file)) return "implementation";
  return "other";
}

/** git diff --name-status の出力を読む。T（種類の変更）は変更として扱う */
export function parseNameStatus(output: string): Change[] {
  return output
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const [status = "", path = ""] = l.split("\t");
      const s = status.startsWith("A") ? "A" : status.startsWith("D") ? "D" : "M";
      return { status: s, path };
    });
}

export type TamperProblem =
  | { kind: "existing-test-changed"; tests: string[]; implementations: string[] }
  | { kind: "expected-failure-not-new"; entries: string[] };

/**
 * 次のどちらかがあれば問題として返す。
 * - 実装を含むPRで、既存の自律度「中」のテストを変更・削除している
 * - 失敗予定リストに足した項目が、このPRで新しく足したテストではない（既存のテストを隠している）
 */
export function checkTamper(
  changes: readonly Change[],
  config: AutonomyConfig,
  addedExpectedFailures: readonly string[] = [],
): TamperProblem[] {
  const problems: TamperProblem[] = [];
  const changedTests = changes
    .filter((c) => c.status !== "A" && classify(c.path, config) === "medium-test")
    .map((c) => c.path);
  const implementations = changes
    .filter((c) => classify(c.path, config) === "implementation")
    .map((c) => c.path);
  if (changedTests.length > 0 && implementations.length > 0) {
    problems.push({ kind: "existing-test-changed", tests: changedTests, implementations });
  }

  const addedTests = new Set(changes.filter((c) => c.status === "A").map((c) => c.path));
  const notNew = addedExpectedFailures.filter((e) => !addedTests.has(e));
  if (notNew.length > 0) problems.push({ kind: "expected-failure-not-new", entries: notNew });

  return problems;
}

export function describeTamperProblem(p: TamperProblem): string[] {
  switch (p.kind) {
    case "existing-test-changed":
      return [
        "✗ 実装を含むPRで、既存の自律度「中」のテストを変更・削除している（docs/TESTING.md）",
        "  テストの変更は、実装を含まないPRに分ける",
        `  テスト：${p.tests.join(", ")}`,
        `  実装：${p.implementations.join(", ")}`,
      ];
    case "expected-failure-not-new":
      return [
        "✗ 失敗予定リスト（harness/expected-failures.txt）に、このPRで新しく足したテスト以外を追加している",
        "  レビュー済みのテストを失敗予定にして隠すことはできない",
        `  項目：${p.entries.join(", ")}`,
      ];
  }
}
