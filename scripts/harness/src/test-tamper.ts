// テストの改ざん防止のチェック（docs/TESTING.md「実装PRでテストを変更させない」）。
// ファイルを読み書きしない純粋な関数だけを置く。git と設定ファイルの読み込みは test-tamper-cli.ts で行う。
import { matchesGlob } from "node:path";

export type AutonomyConfig = {
  /** 自律度「中」の領域のパス（glob） */
  medium: readonly string[];
};

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

export type TamperResult =
  { ok: true } | { ok: false; mediumTests: string[]; implementations: string[] };

/** 自律度「中」の領域のテストと実装を、同じPRで変えていたら失敗にする */
export function checkTamper(changedFiles: readonly string[], config: AutonomyConfig): TamperResult {
  const mediumTests: string[] = [];
  const implementations: string[] = [];
  for (const file of changedFiles) {
    const kind = classify(file, config);
    if (kind === "medium-test") mediumTests.push(file);
    if (kind === "implementation") implementations.push(file);
  }
  if (mediumTests.length > 0 && implementations.length > 0) {
    return { ok: false, mediumTests, implementations };
  }
  return { ok: true };
}
