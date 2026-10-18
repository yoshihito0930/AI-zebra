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

// INV-9：金額は整数（円）で扱い、浮動小数で計算しない。端数の処理は決めた1か所だけで行う。
// 金額を計算する packages/booking-core と packages/contracts（テスト以外）で、小数・丸め・割り算を止める。
// 端数を切り捨てる決めた場所（消費税、キャンセル料）だけ、理由を書いた eslint-disable のコメントで割り算を許す
const moneyMessage =
  "INV-9：金額は整数（円）で扱う。小数・丸め・割り算は使わない。端数の処理は決めた場所（消費税・キャンセル料の切り捨て）だけで、理由を書いた eslint-disable のコメントを付けて行う。";
const noFloatingPointMoney = [
  { selector: "Literal[raw=/^\\d[\\d_]*\\.\\d/]", message: moneyMessage },
  {
    selector:
      "CallExpression[callee.object.name='Math'][callee.property.name=/^(round|floor|ceil|trunc)$/]",
    message: moneyMessage,
  },
  { selector: "CallExpression[callee.property.name='toFixed']", message: moneyMessage },
  { selector: "CallExpression[callee.name='parseFloat']", message: moneyMessage },
  { selector: "CallExpression[callee.property.name='parseFloat']", message: moneyMessage },
  { selector: "BinaryExpression[operator='/']", message: moneyMessage },
  { selector: "AssignmentExpression[operator='/=']", message: moneyMessage },
];

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/coverage/**", "**/.astro/**"],
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
    // ブラウザで動くもの
    files: ["apps/admin/**", "apps/site-*/**", "packages/booking-widget/**"],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    files: ["apps/api/src/mail/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [otherDateLibraries] }],
    },
  },
  {
    files: ["packages/booking-core/src/**", "packages/contracts/src/**"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...noDirectCurrentTime, ...noFloatingPointMoney],
    },
  },
  {
    files: ["packages/clock/src/**"],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
);
