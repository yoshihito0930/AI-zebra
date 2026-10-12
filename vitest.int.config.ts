import { defineConfig } from "vitest/config";
import { expectedFailures } from "./vitest.expected-failures.ts";

// 統合テスト（*.int.test.ts）の設定。ローカルの DynamoDB（compose.yaml）に接続して動かす
export default defineConfig({
  test: {
    include: ["{apps,packages}/**/*.int.test.ts"],
    // 失敗予定リストのテストは外す（docs/TESTING.md）
    exclude: ["**/node_modules/**", "**/dist/**", ...expectedFailures()],
    globalSetup: ["./vitest.int.setup.ts"],
    passWithNoTests: true,
    testTimeout: 15_000,
  },
});
