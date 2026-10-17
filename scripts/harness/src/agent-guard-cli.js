// Claude Code の PreToolUse フックの入口。使い方：node scripts/harness/src/agent-guard-cli.js <test-writer|implementer>
// 標準入力でフックの入力（JSON）を受け取り、止めるときは理由を標準エラーに書いて終了コード2で終わる。
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { decide } from "./agent-guard.js";

const role = process.argv[2];
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  /** @type {{ tool_name?: string, tool_input?: Record<string, unknown>, cwd?: string }} */
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.stderr.write("agent-guard：フックの入力を読めない\n");
    process.exit(2);
  }
  const repoRoot = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
  const reason = decide(
    role,
    input.tool_name,
    input.tool_input,
    repoRoot,
    (p) => existsSync(path.join(repoRoot, p)),
    onMainIn(repoRoot),
  );
  if (reason !== undefined) {
    process.stderr.write(`${reason}\n`);
    process.exit(2);
  }
  process.exit(0);
});

/**
 * ファイルが main にあるかを返す関数を作る。origin/main（なければ main）を見る。
 * どちらもないときは、すべて「main にある」とみなす（テスト担当が実装を書けない側に倒す）
 * @param {string} repoRoot
 * @returns {(repoPath: string) => boolean}
 */
function onMainIn(repoRoot) {
  /** @param {string[]} args */
  const git = (args) => {
    try {
      execFileSync("git", ["-C", repoRoot, ...args], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  const ref = ["origin/main", "main"].find((r) => git(["rev-parse", "--verify", "--quiet", r]));
  if (ref === undefined) return () => true;
  return (p) => git(["cat-file", "-e", `${ref}:${p}`]);
}
