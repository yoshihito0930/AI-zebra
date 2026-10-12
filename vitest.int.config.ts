import { defineConfig } from "vitest/config";

// 統合テスト（*.int.test.ts）の設定。ローカルの DynamoDB（compose.yaml）に接続して動かす
export default defineConfig({
  test: {
    include: ["{apps,packages}/**/*.int.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    globalSetup: ["./vitest.int.setup.ts"],
    passWithNoTests: true,
    testTimeout: 15_000,
  },
});
