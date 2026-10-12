// 例の網羅のチェック（docs/TESTING.md「仕様の例とテストの対応づけ」）。
// ファイルを読み書きしない純粋な関数だけを置く。ファイルの読み込みは spec-coverage-cli.ts で行う。

const EXAMPLE_HEADING = "例";

/**
 * Markdown から「例」の見出しを探し、その親（1つ上の階層の見出し）の名前を返す。
 * コードブロックの中の行は見出しとして扱わない。
 */
export function extractExampleSections(markdown: string): string[] {
  const sections: string[] = [];
  // 見出しの階層ごとに、いま開いている見出しの名前を持つ（index = レベル）
  const open: (string | undefined)[] = [];
  let inFence = false;

  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const level = m[1]!.length;
    const text = m[2]!.trim();

    if (text === EXAMPLE_HEADING) {
      const parent = open.slice(1, level).findLast((h) => h !== undefined);
      if (parent !== undefined && !sections.includes(parent)) sections.push(parent);
    }
    open[level] = text;
    open.length = level + 1;
  }
  return sections;
}

/** テストのソースから describe の名前（最初の引数の文字列）を集める */
export function extractDescribeNames(source: string): string[] {
  const names: string[] = [];
  const re = /\bdescribe(?:\.\w+)*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
  for (const m of source.matchAll(re)) names.push(m[2]!);
  return names;
}

/** 保留リストのファイルから節の名前を読む（空行と # で始まる行は無視する） */
export function parsePendingList(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
}

export type CoverageProblem =
  | { kind: "missing"; section: string }
  | { kind: "covered-but-pending"; section: string }
  | { kind: "unknown-pending"; section: string };

/**
 * 節ごとに、テストがあるか・保留リストにあるかを照らし合わせる。
 * 問題がなければ空の配列を返す。
 */
export function evaluateCoverage(input: {
  sections: readonly string[];
  describeNames: readonly string[];
  pending: readonly string[];
}): CoverageProblem[] {
  const covered = new Set(input.describeNames);
  const pending = new Set(input.pending);
  const sections = new Set(input.sections);
  const problems: CoverageProblem[] = [];

  for (const section of input.sections) {
    const hasTest = covered.has(section);
    const isPending = pending.has(section);
    if (!hasTest && !isPending) problems.push({ kind: "missing", section });
    if (hasTest && isPending) problems.push({ kind: "covered-but-pending", section });
  }
  for (const section of input.pending) {
    if (!sections.has(section)) problems.push({ kind: "unknown-pending", section });
  }
  return problems;
}

export function describeProblem(p: CoverageProblem): string {
  switch (p.kind) {
    case "missing":
      return `節「${p.section}」の例に対応するテスト（describe("${p.section}", ...)）がない。テストを書くか、保留リストに追加する`;
    case "covered-but-pending":
      return `節「${p.section}」のテストができたので、保留リストから消す`;
    case "unknown-pending":
      return `保留リストの「${p.section}」は、仕様に「例」のある節として存在しない。保留リストから消す`;
  }
}
