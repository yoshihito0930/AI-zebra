// テスト担当と実装担当のエージェントに、役割の外の操作をさせないための判定（docs/TESTING.md）。
// Claude Code の PreToolUse フックから呼ばれる（.claude/agents/*.md の hooks）。
// フックは非対話のシェルで動き、nvm の Node 24 ではなく古い Node で実行されることがあるため、
// TypeScript や新しい Node の機能を使わない素の JavaScript で書く。
//
// これは「うっかり」を止めるための仕組みで、シェル経由の回り道（スクリプトの中でファイルを開くなど）までは止められない。
// 実装担当がテストを変えた場合は、CI のテストの改ざん防止（test-tamper）が最後に止める。

const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const CODE_FILE = /\.([cm]?[jt]sx?|astro)$/;
const CODE_ROOTS = /^(apps|packages)\//;
// テスト担当が読んでよい実装（公開APIの契約）
const READABLE_FOR_TEST_WRITER = /^packages\/contracts\//;
// テスト担当が書いてよい、テスト以外のファイル（例の網羅の保留リスト、失敗予定リスト、仕様の未決事項）
const WRITABLE_FOR_TEST_WRITER =
  /^(harness\/spec-coverage-pending\.txt|harness\/expected-failures\.txt|docs\/product-specs\/.+\.md)$/;

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const READ_COMMANDS =
  /(^|[\s;&|(])(cat|head|tail|less|more|grep|rg|sed|awk|bat|nl|od|xxd|strings)\s/;
const WRITE_HINTS =
  /(sed\s+-i|perl\s+-i|>\s*\S|\btee\b|\brm\b|\bmv\b|\bcp\b|\btruncate\b|\bgit\s+(checkout|restore|apply)\b)/;

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
 * コマンドの中から、リポジトリ内のファイルらしい語を拾う
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
 * @param {(repoPath: string) => boolean} [exists] ファイルがすでにあるか（テスト担当がスタブを新しく作れるかの判定に使う）
 * @returns {string | undefined}
 */
export function decide(role, toolName, toolInput, repoRoot, exists = () => true) {
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
      const tests = pathsInCommand(input.command).filter(isTestFile);
      if (tests.length > 0 && WRITE_HINTS.test(input.command)) {
        return `実装担当はシェルからテストファイル（${tests.join(", ")}）を変更できない（docs/TESTING.md）`;
      }
    }
    return undefined;
  }

  if (role === "test-writer") {
    if (toolName === "Read") {
      const p = toRepoPath(input.file_path, repoRoot);
      if (p !== undefined && isImplementation(p) && !READABLE_FOR_TEST_WRITER.test(p)) {
        return `テスト担当は実装（${p}）を読まない。テストは仕様（docs/product-specs）と契約（packages/contracts）だけから書く（docs/TESTING.md）`;
      }
    }
    if (EDIT_TOOLS.has(toolName ?? "")) {
      const p = toRepoPath(input.file_path ?? input.notebook_path, repoRoot);
      // 新しい実装ファイル（スタブ）を Write で作ることだけは許す。既存の実装は変更できない
      const newStub = p !== undefined && toolName === "Write" && isImplementation(p) && !exists(p);
      if (p === undefined || !(isTestFile(p) || WRITABLE_FOR_TEST_WRITER.test(p) || newStub)) {
        return `テスト担当が書けるのは、テストファイル・新しいスタブ・例の網羅の保留リスト・失敗予定リスト・仕様の未決事項だけ（${p ?? "リポジトリの外"}）`;
      }
    }
    if (toolName === "Bash" && typeof input.command === "string") {
      const impl = pathsInCommand(input.command).filter(
        (p) => isImplementation(p) && !READABLE_FOR_TEST_WRITER.test(p),
      );
      if (impl.length > 0 && READ_COMMANDS.test(input.command)) {
        return `テスト担当は実装（${impl.join(", ")}）を読まない（docs/TESTING.md）`;
      }
    }
    return undefined;
  }

  return `不明な役割：${role}`;
}
