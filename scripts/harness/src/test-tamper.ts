// テストの改ざん防止のチェック（docs/TESTING.md「実装PRでテストを変更させない」）。
// ファイルを読み書きしない純粋な関数だけを置く。git と設定ファイルの読み込みは test-tamper-cli.ts で行う。
import { matchesGlob } from "node:path";
import ts from "typescript";

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

/** スタブの関数の中身：引数を使ったことにする `void x;` だけが続き、最後に `throw new Error("未実装")` */
function isStubBody(body: ts.Block): boolean {
  const statements = [...body.statements];
  const last = statements.pop();
  if (
    !last ||
    !ts.isThrowStatement(last) ||
    !ts.isNewExpression(last.expression) ||
    !ts.isIdentifier(last.expression.expression) ||
    last.expression.expression.text !== "Error"
  ) {
    return false;
  }
  const args = last.expression.arguments ?? [];
  if (args.length !== 1 || !ts.isStringLiteral(args[0]!) || args[0].text !== "未実装") return false;
  return statements.every(
    (s) =>
      ts.isExpressionStatement(s) &&
      ts.isVoidExpression(s.expression) &&
      ts.isIdentifier(s.expression.expression),
  );
}

/**
 * スタブか（docs/TESTING.md の手順2）。型の宣言・import・型だけの export と、中身が「未実装」を投げるだけの
 * 関数の宣言だけでできている .ts ファイル。振る舞いを持たないので、test-tamper は実装と数えない。
 * 値の宣言（const、enum、class など）や、ほかの文を含むものはスタブではない
 */
export function isStub(file: string, source: string): boolean {
  if (!/\.[cm]?ts$/.test(file)) return false;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  return sf.statements.every(
    (s) =>
      ts.isImportDeclaration(s) ||
      ts.isTypeAliasDeclaration(s) ||
      ts.isInterfaceDeclaration(s) ||
      (ts.isExportDeclaration(s) && s.isTypeOnly) ||
      (ts.isFunctionDeclaration(s) && (s.body === undefined || isStubBody(s.body))),
  );
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
 * - 失敗予定リストに足した項目が、このPRで新しく足したテストではない（既存のテストを隠している）。
 *   ただし、実装を含まないPR（テストを直すPR）では、このPRで変更したテストも足してよい。
 *   すでに実装のある関数の振る舞いを仕様の変更で変えるとき、直したテストは今の実装では失敗するため（docs/TESTING.md の手順5）
 *
 * newStubs は、このPRで足したファイルのうちスタブのもの（isStub）。実装と数えない。
 * スタブを足すテストのPRで、既存のテストも直せるようにするため。足したファイル（A）だけを見る
 */
export function checkTamper(
  changes: readonly Change[],
  config: AutonomyConfig,
  addedExpectedFailures: readonly string[] = [],
  newStubs: readonly string[] = [],
): TamperProblem[] {
  const problems: TamperProblem[] = [];
  const changedTests = changes
    .filter((c) => c.status !== "A" && classify(c.path, config) === "medium-test")
    .map((c) => c.path);
  const implementations = changes
    .filter((c) => classify(c.path, config) === "implementation")
    .filter((c) => !(c.status === "A" && newStubs.includes(c.path)))
    .map((c) => c.path);
  if (changedTests.length > 0 && implementations.length > 0) {
    problems.push({ kind: "existing-test-changed", tests: changedTests, implementations });
  }

  const testOnly = implementations.length === 0;
  const allowed = new Set(
    changes.filter((c) => c.status === "A" || (testOnly && c.status === "M")).map((c) => c.path),
  );
  const notNew = addedExpectedFailures.filter((e) => !allowed.has(e));
  if (notNew.length > 0) problems.push({ kind: "expected-failure-not-new", entries: notNew });

  return problems;
}

export function describeTamperProblem(p: TamperProblem): string[] {
  switch (p.kind) {
    case "existing-test-changed":
      return [
        "✗ 実装を含むPRで、既存の自律度「中」のテストを変更・削除している（docs/TESTING.md）",
        "  テストの変更は、実装を含まないPRに分ける（新しいスタブは実装と数えない）",
        `  テスト：${p.tests.join(", ")}`,
        `  実装：${p.implementations.join(", ")}`,
      ];
    case "expected-failure-not-new":
      return [
        "✗ 失敗予定リスト（harness/expected-failures.txt）に、このPRで新しく足したテスト以外を追加している",
        "  レビュー済みのテストを失敗予定にして隠すことはできない（実装を含まないPRでは、そのPRで変更したテストは足せる）",
        `  項目：${p.entries.join(", ")}`,
      ];
  }
}
