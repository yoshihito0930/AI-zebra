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
| `pnpm build` | すべてのアプリをビルド |
| `pnpm dev:site` | HP（http://localhost:4321/） |
| `pnpm dev:admin` | 管理画面（http://localhost:5174/） |
| `pnpm dev:api` | API（http://localhost:8787/health） |
| `pnpm test-tamper` | テストの改ざん防止のチェック（main との差分） |

## 変更の流れ

main は保護されている。ブランチを切って PR を出し、CI（`lint`・`typecheck`・`deps`・`test`・`spec-coverage`・`test-tamper`）が通ってからマージする。
テストと実装の進め方は [docs/TESTING.md](docs/TESTING.md)。
