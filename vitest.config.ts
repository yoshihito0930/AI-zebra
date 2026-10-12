import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // テストは対象のファイルの隣に *.test.ts で置く。統合テスト（*.int.test.ts）は別の設定で動かす（TESTING.md）
    include: ["{apps,packages,tooling,scripts}/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.int.test.ts"],
    // 骨組みの段階ではテストがまだない
    passWithNoTests: true,
  },
});
