// リポジトリ共通の lint 設定。
// 不変条件（core-beliefs.md の INV-*）を強制するルールは、CI の基本ジョブと一緒に追加する
// （docs/exec-plans/skeleton-and-ci.md の PR2）。
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
);
