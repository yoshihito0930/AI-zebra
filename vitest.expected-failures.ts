// 失敗予定リスト（harness/expected-failures.txt）を読み、テストの対象から外すパスを返す。
// ZEBRA_RUN_EXPECTED_FAILURES=1 のとき（失敗予定リストのチェック）は外さない。
import { readFileSync } from "node:fs";

export function expectedFailures(): string[] {
  if (process.env["ZEBRA_RUN_EXPECTED_FAILURES"] === "1") return [];
  return readFileSync(new URL("./harness/expected-failures.txt", import.meta.url), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
}
