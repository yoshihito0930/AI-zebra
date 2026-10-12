// 依存の方向の決まり（INV-5 と docs/exec-plans/skeleton-and-ci.md の「依存の方向」の表）。
// 規則は「直接の依存」に対して判定する。間接の依存（例：HP → booking-widget → booking-core）は許す。

/** 自分自身と、許したワークスペースのパッケージ以外への依存を禁止する規則を作る */
function onlyWorkspaceDeps(name, from, allowed) {
  return {
    name,
    severity: "error",
    from: { path: `^${from}/` },
    to: {
      path: "^(apps|packages|tooling)/",
      pathNot: `^(${[from, ...allowed].join("|")})/`,
    },
  };
}

module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "循環依存を作らない",
      from: {},
      to: { circular: true },
    },
    {
      name: "inv5-api-not-depend-on-site",
      severity: "error",
      comment: "INV-5：apps/api は apps/site-* に依存しない",
      from: { path: "^apps/api/" },
      to: { path: "^apps/site-" },
    },
    {
      name: "inv5-site-direct-deps",
      severity: "error",
      comment:
        "INV-5：apps/site-* が直接依存できるのは packages/contracts と packages/booking-widget だけ",
      from: { path: "^apps/(site-[^/]+)/" },
      to: {
        path: "^(apps|packages|tooling)/",
        pathNot: ["^apps/$1/", "^packages/(contracts|booking-widget)/"],
      },
    },
    onlyWorkspaceDeps("admin-deps", "apps/admin", [
      "packages/contracts",
      "packages/booking-core",
      "packages/clock",
    ]),
    onlyWorkspaceDeps("api-deps", "apps/api", [
      "packages/contracts",
      "packages/booking-core",
      "packages/clock",
    ]),
    onlyWorkspaceDeps("booking-widget-deps", "packages/booking-widget", [
      "packages/contracts",
      "packages/booking-core",
    ]),
    onlyWorkspaceDeps("booking-core-deps", "packages/booking-core", ["packages/contracts"]),
    onlyWorkspaceDeps("contracts-deps", "packages/contracts", []),
    onlyWorkspaceDeps("clock-deps", "packages/clock", []),
    {
      name: "inv5-booking-core-no-io",
      severity: "error",
      comment:
        "INV-5：packages/booking-core は入出力を持たない（Node の組み込みモジュール、AWS SDK、HTTP フレームワークを使わない）",
      from: { path: "^packages/booking-core/" },
      to: {
        dependencyTypes: ["core"],
      },
    },
    {
      name: "inv5-booking-core-no-io-packages",
      severity: "error",
      comment: "INV-5：packages/booking-core から AWS SDK・HTTP フレームワークを使わない",
      from: { path: "^packages/booking-core/" },
      to: { path: "node_modules/(@aws-sdk|@smithy|hono|@hono)/" },
    },
    {
      name: "contracts-only-zod",
      severity: "error",
      comment: "packages/contracts が使う外部パッケージは Zod だけ",
      from: { path: "^packages/contracts/" },
      to: { dependencyTypes: ["npm"], pathNot: "node_modules/zod/" },
    },
    {
      name: "not-to-unresolvable",
      severity: "error",
      comment: "解決できない import を残さない",
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^|/)(dist|coverage)/" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"],
    },
  },
};
