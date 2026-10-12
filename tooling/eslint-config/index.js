// リポジトリ共通の lint 設定。
// 不変条件（docs/design-docs/core-beliefs.md の INV-*）の一部を、ここで lint として強制する。
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// INV-7：日時ライブラリは Luxon だけ
const otherDateLibraries = {
  group: [
    "moment",
    "moment-timezone",
    "dayjs",
    "date-fns",
    "date-fns-tz",
    "@date-fns/*",
    "js-joda",
    "@js-joda/*",
    "@js-temporal/polyfill",
    "temporal-polyfill",
  ],
  message: "INV-7：日時ライブラリは Luxon だけを使う。",
};

// INV-6：お客様へのメールを送れる経路を限るため、SES を呼べるのは apps/api/src/mail/ の中だけ
const sesClients = {
  group: ["@aws-sdk/client-ses", "@aws-sdk/client-sesv2"],
  message: "INV-6：SES を呼べるのは apps/api/src/mail/ の中だけ。",
};

// INV-7：現在時刻は packages/clock からだけ取得する（テストで固定できるように）
const currentTimeMessage =
  "INV-7：現在時刻は packages/clock の時計から取得する。Date.now() / new Date() / Date() を直接使わない。";
const noDirectCurrentTime = [
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message: currentTimeMessage,
  },
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message: currentTimeMessage,
  },
  { selector: "CallExpression[callee.name='Date']", message: currentTimeMessage },
];

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
    rules: {
      "no-restricted-imports": ["error", { patterns: [otherDateLibraries, sesClients] }],
      "no-restricted-syntax": ["error", ...noDirectCurrentTime],
    },
  },
  {
    files: ["apps/api/src/mail/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [otherDateLibraries] }],
    },
  },
  {
    files: ["packages/clock/src/**"],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
);
