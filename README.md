# AI-zebra

撮影スタジオ「スタジオゼブラ」の公式HPと予約管理システム。AIを主軸にした開発の試行錯誤を兼ねている。
エージェント向けの目次は [AGENTS.md](AGENTS.md)、何を作るかは [docs/product-specs/index.md](docs/product-specs/index.md)。

## 必要なもの

- Node.js 24（`.nvmrc`。nvm なら `nvm use`）
- pnpm（`corepack enable` で `package.json` の `packageManager` のバージョンが使われる）
- Docker（統合テストで DynamoDB Local を動かすとき）

## よく使うコマンド

| コマンド | 内容 |
|---|---|
| `pnpm install` | 依存のインストール |
| `pnpm check` | lint・整形・型・依存の方向・単体テスト・例の網羅（CI とほぼ同じ） |
| `pnpm test` | 単体テスト |
| `pnpm db:up` / `pnpm db:down` | ローカルの DynamoDB（Docker）の起動・停止 |
| `pnpm test:int` | 統合テスト（先に `pnpm db:up`） |
| `pnpm build` | すべてのアプリをビルド |
| `pnpm dev:site` | HP（http://localhost:4321/） |
| `pnpm dev:admin` | 管理画面（http://localhost:5174/） |
| `pnpm dev:api` | API（http://localhost:8787/health） |
| `pnpm test-tamper` | テストの改ざん防止のチェック（main との差分） |
| `pnpm expected-failures` | 失敗予定リストのテストが、まだ失敗するかの確認 |

## API を手元で動かすときの環境変数

`pnpm dev:api` は、次の環境変数を読む。

| 環境変数 | 内容 |
|---|---|
| `PORT` | 待ち受けるポート。省略すると 8787 |
| `DYNAMODB_TABLE_NAME` | 読み書きするテーブルの名前。テーブルを使うリクエスト（公開API・管理 API）に必須 |
| `DYNAMODB_ENDPOINT` | ローカルの DynamoDB の URL（`pnpm db:up` で起動したもの）。省略すると AWS の DynamoDB に接続する |
| `DEV_ADMIN_USER_ID` | 管理 API（`/admin/…`）を、この id の管理者として動かす（Cognito なしで管理画面を作るため）。履歴の「誰が」になる。ない・空なら、管理 API はどれも 401。架空の id を使う |

`DEV_ADMIN_USER_ID` を読むのは手元の Node サーバー（`apps/api/src/server.ts`）だけ。本番（Lambda）は読まず、API Gateway の JWT オーソライザーが確かめたトークンの `sub` を使う（[docs/design-docs/admin-api.md](docs/design-docs/admin-api.md)「認証」）。

例：`DEV_ADMIN_USER_ID=dev-admin DYNAMODB_TABLE_NAME=<テーブルの名前> DYNAMODB_ENDPOINT=http://localhost:8000 pnpm dev:api`

## 変更の流れ

main は保護されている。ブランチを切って PR を出し、CI（`lint`・`typecheck`・`deps`・`test`・`test-int`・`spec-coverage`・`test-tamper`・`expected-failures`）が通ってからマージする。
テストと実装の進め方は [docs/TESTING.md](docs/TESTING.md)。
