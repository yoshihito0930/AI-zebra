// テスト担当と実装担当のエージェントに、役割の外の操作をさせないための判定（docs/TESTING.md）。
// Claude Code の PreToolUse フックから呼ばれる（.claude/agents/*.md の hooks）。
// フックは非対話のシェルで動き、nvm の Node 24 ではなく古い Node で実行されることがあるため、
// TypeScript や新しい Node の機能を使わない素の JavaScript で書く。
//
// これは「うっかり」を止めるための仕組みで、シェル経由の回り道（スクリプトの中でファイルを開く、パスを引用符で囲むなど）までは止められない。
// 実装担当がテストを変えた場合は、CI のテストの改ざん防止（test-tamper）が最後に止める。

import path from "node:path";

const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const CODE_FILE = /\.([cm]?[jt]sx?|astro)$/;
const CODE_ROOTS = /^(apps|packages)\//;
// テスト担当が読んでよい実装（公開APIの契約）
const READABLE_FOR_TEST_WRITER = /^packages\/contracts\//;
// テスト担当が書いてよい、テスト以外のファイル（例の網羅の保留リスト、失敗予定リスト、仕様の未決事項）
const WRITABLE_FOR_TEST_WRITER =
  /^(harness\/spec-coverage-pending\.txt|harness\/expected-failures\.txt|docs\/product-specs\/.+\.md)$/;

// テスト担当が書いてよい、リポジトリの外の場所（Claude Code のスクラッチパッド。PR 本文やコミットメッセージの下書きに使う）
const SCRATCHPAD = /^\/tmp\/claude-[^/]+\/[^/]+\/[^/]+\/scratchpad\//;

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const READ_COMMANDS =
  /(^|[\s;&|(])(cat|head|tail|less|more|grep|rg|sed|awk|bat|nl|od|xxd|strings)\s/;
// 依存を変えるパッケージマネージャーのコマンド（引数なしの install は、lockfile どおりに入れるだけなので許す）
const DEPENDENCY_COMMANDS =
  /^\s*(pnpm|npm|yarn)\b(?=.*\s((add|remove|rm|uninstall|update|up|upgrade)(\s|$)|(install|i)(\s+-\S+)*\s+[^-\s]))/;
// 依存を決めるファイル
const DEPENDENCY_FILES = /(^|[\s/'"])(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)\b/;
const WRITE_HINTS =
  /(sed\s+-i|perl\s+-i|>(?!&)\s*\S|\btee\b|\brm\b|\bmv\b|\bcp\b|\btruncate\b|\bgit\s+(checkout|restore|apply)\b)/;

/**
 * 絶対パスをリポジトリからの相対パスにする（リポジトリの外なら undefined）
 * @param {unknown} filePath
 * @param {string} repoRoot
 * @returns {string | undefined}
 */
export function toRepoPath(filePath, repoRoot) {
  if (typeof filePath !== "string" || filePath === "") return undefined;
  const root = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;
  if (filePath.startsWith(root)) return filePath.slice(root.length);
  if (!filePath.startsWith("/")) return filePath.replace(/^\.\//, "");
  return undefined;
}

/** @param {string} p */
export function isTestFile(p) {
  return TEST_FILE.test(p);
}

/** @param {string} p */
export function isImplementation(p) {
  return CODE_ROOTS.test(p) && CODE_FILE.test(p) && !TEST_FILE.test(p);
}

/**
 * コマンドを、判定に使う部分（&& ; | などで区切った1つずつのコマンド）に分ける。
 * ヒアドキュメントの本文と引用符の中は取り除く。コミットメッセージや sed の式の中にパスが出てきても、
 * そのファイルを読む・書くわけではないため
 * @param {string} command
 * @returns {string[]}
 */
function segmentsOf(command) {
  // 開始の記号と同じ行の残り（書き込み先など）は残し、本文だけを消す
  const withoutHeredocs = command.replace(
    /<<-?[ \t]*(['"]?)(\w+)\1([^\n]*)\n(?:[\s\S]*?\n)?[ \t]*\2[ \t]*(?=\n|$)/g,
    " $3",
  );
  const withoutQuotes = withoutHeredocs.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");
  return withoutQuotes.split(/&&|\|\||[;|\n]/);
}

/**
 * コマンドの1つの部分から、リポジトリ内のファイルらしい語を拾う
 * @param {string} command
 * @returns {string[]}
 */
function pathsInCommand(command) {
  return (command.match(/[\w@./-]+\.[cm]?[jt]sx?\b|[\w@./-]+\.astro\b/g) ?? []).map((p) =>
    p.replace(/^\.\//, ""),
  );
}

/**
 * フックの入力（tool_name と tool_input）から、操作を止めるかを決める。
 * 止めるときは理由の文字列を、許すときは undefined を返す。
 * @param {string | undefined} role
 * @param {string | undefined} toolName
 * @param {Record<string, unknown> | undefined} toolInput
 * @param {string} repoRoot
 * @param {(repoPath: string) => boolean} [exists] ファイルが作業ツリーにあるか
 * @param {(repoPath: string) => boolean} [onMain] ファイルが main にあるか。テスト担当は、main にない実装ファイル（そのブランチで作ったスタブ）だけを読み書きできる
 * @returns {string | undefined}
 */
export function decide(role, toolName, toolInput, repoRoot, exists = () => true, onMain = exists) {
  /** @type {Record<string, unknown>} */
  const input = toolInput ?? {};

  if (role === "implementer") {
    if (EDIT_TOOLS.has(toolName ?? "")) {
      const p = toRepoPath(input.file_path ?? input.notebook_path, repoRoot);
      if (p !== undefined && isTestFile(p)) {
        return `実装担当はテストファイル（${p}）を変更できない。テストが間違っていると考えるなら、理由を書いて人間に質問する（docs/TESTING.md の手順5）`;
      }
    }
    if (toolName === "Bash" && typeof input.command === "string") {
      for (const segment of segmentsOf(input.command)) {
        const tests = pathsInCommand(segment).filter(isTestFile);
        if (tests.length > 0 && WRITE_HINTS.test(segment)) {
          return `実装担当はシェルからテストファイル（${tests.join(", ")}）を変更できない（docs/TESTING.md）`;
        }
      }
    }
    return undefined;
  }

  if (role === "test-writer") {
    // そのブランチで作ったスタブ（main になく、作業ツリーにある実装ファイル）は、読み書きしてよい。
    // ないファイルは含めない（起動時の自己確認で、ないファイルの Read が止まることを使っているため）
    /** @param {string} p */
    const ownStub = (p) => isImplementation(p) && !onMain(p) && exists(p);
    if (toolName === "Read") {
      const p = toRepoPath(input.file_path, repoRoot);
      if (
        p !== undefined &&
        isImplementation(p) &&
        !READABLE_FOR_TEST_WRITER.test(p) &&
        !ownStub(p)
      ) {
        return `テスト担当は実装（${p}）を読まない。テストは仕様（docs/product-specs）と契約（packages/contracts）だけから書く（docs/TESTING.md）`;
      }
    }
    if (EDIT_TOOLS.has(toolName ?? "")) {
      const filePath = input.file_path ?? input.notebook_path;
      if (typeof filePath === "string" && SCRATCHPAD.test(path.posix.normalize(filePath))) {
        return undefined;
      }
      const p = toRepoPath(filePath, repoRoot);
      // 新しい実装ファイル（スタブ）を Write で作ることと、そのブランチで作ったスタブを直すことは許す。
      // main にある実装は変更できない
      const stub =
        p !== undefined &&
        isImplementation(p) &&
        ((toolName === "Write" && !exists(p) && !onMain(p)) || ownStub(p));
      if (p === undefined || !(isTestFile(p) || WRITABLE_FOR_TEST_WRITER.test(p) || stub)) {
        return `テスト担当が書けるのは、テストファイル・新しいスタブ（main にない実装ファイル）・例の網羅の保留リスト・失敗予定リスト・仕様の未決事項だけ（${p ?? "リポジトリの外"}）`;
      }
    }
    if (toolName === "Bash" && typeof input.command === "string") {
      for (const segment of segmentsOf(input.command)) {
        const impl = pathsInCommand(segment).filter(
          (p) => isImplementation(p) && !READABLE_FOR_TEST_WRITER.test(p) && !ownStub(p),
        );
        if (impl.length > 0 && READ_COMMANDS.test(segment)) {
          return `テスト担当は実装（${impl.join(", ")}）を読まない（docs/TESTING.md）`;
        }
        if (
          DEPENDENCY_COMMANDS.test(segment.replace(/\s\d*>>?&?\s*\S+/g, " ")) ||
          (DEPENDENCY_FILES.test(segment) && WRITE_HINTS.test(segment))
        ) {
          return "テスト担当は依存を変えない。依存が要るなら、止まって報告する（テストの PR の前に準備の PR を出す。docs/TESTING.md）";
        }
      }
    }
    return undefined;
  }

  return `不明な役割：${role}`;
}
