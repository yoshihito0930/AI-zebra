import { defineConfig } from "vitest/config";
import { expectedFailures } from "./vitest.expected-failures.ts";

export default defineConfig({
  test: {
    // テストは対象のファイルの隣に *.test.ts で置く。統合テスト（*.int.test.ts）は別の設定で動かす（TESTING.md）
    include: ["{apps,packages,tooling,scripts}/**/*.test.ts"],
    // 失敗予定リストのテストは外す（docs/TESTING.md）
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.int.test.ts", ...expectedFailures()],
    // 骨組みの段階ではテストがまだない
    passWithNoTests: true,
  },
});
