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
| `pnpm db:table` | ローカルの DynamoDB に、手元で API を動かすためのテーブルを作る（先に `pnpm db:up`） |
| `pnpm db:demo` | `pnpm db:table` で作ったテーブルに、デモ用の架空の予約を入れる（「デモのデータ」の節） |
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

`pnpm db:up` で起動したローカルの DynamoDB は空なので、最初に `pnpm db:table` でテーブル（キー設計どおり。名前は既定で `zebra-local`）を作る。何度動かしてもよい（もうあれば作らない）。接続先が手元（localhost・127.0.0.1）でなければ作らない。ローカルの DynamoDB はデータをメモリにだけ置くので、`pnpm db:down` のあとはもう一度作る。

```sh
pnpm db:up
pnpm db:table
DEV_ADMIN_USER_ID=dev-admin DYNAMODB_TABLE_NAME=zebra-local DYNAMODB_ENDPOINT=http://localhost:8000 pnpm dev:api
```

## デモのデータ

管理画面を手元で触るときに、一覧に予約が並んでいる状態を作る。`pnpm db:demo`（`apps/api/scripts/demo-data.ts`）は、テーブルに架空の予約を入れる。

```sh
pnpm db:up
pnpm db:table
pnpm db:demo
DEV_ADMIN_USER_ID=dev-admin DYNAMODB_TABLE_NAME=zebra-local DYNAMODB_ENDPOINT=http://localhost:8000 pnpm dev:api
pnpm dev:admin   # 別のターミナルで（管理画面）
```

- 入るもの：動かした日（JST）の翌日から来月の末日までに散らばる、承認待ち（仮・本・第二キープ）、承認済みの仮予約・本予約、仮予約に付いた第二キープ（承認済み・承認待ち）、深夜帯にかかる予約、日をまたぐ予約、休業のブロック枠、取消した予約。フォームからの申込（受付番号つき）と、管理者の直接入力の両方。入れた予約の一覧（日時・状態・氏名・受付番号）を表示する
- 本番と同じ処理（申込の処理、操作・直接入力・ブロック枠の保存）で入れる。締め切りや空き判定で入らない日は、1日ずつ後ろにずらす
- 氏名・連絡先・撮影内容はすべて架空のもの
- 何度動かしてもよい：テーブルが空のときだけ入れる。空でなければ（前に入れたデモのデータや、手で入れた予約がある）何も入れずに知らせる。入れ直すときは、`pnpm db:down` → `pnpm db:up` → `pnpm db:table` のあとに動かすか、別のテーブルの名前（`DYNAMODB_TABLE_NAME=zebra-demo2 pnpm db:table` と `DYNAMODB_TABLE_NAME=zebra-demo2 pnpm db:demo`。`pnpm dev:api` にも同じ名前を渡す）を使う
- テーブルがなければ、`pnpm db:table` を先に動かすよう表示して止まる。接続先が手元（localhost・127.0.0.1）でなければ何もしない
- 読む環境変数は `pnpm db:table` と同じ（`DYNAMODB_ENDPOINT`・`DYNAMODB_TABLE_NAME`。省略なら `http://127.0.0.1:8000` と `zebra-local`）。履歴の「誰が」は `DEV_ADMIN_USER_ID`（省略なら `dev-admin`）

## 管理画面を手元で開く

管理画面（apps/admin）は、手元の API に Vite の dev サーバーの中継（`/admin` → http://localhost:8787）でつなぐ。ログイン（Cognito）はまだなく、API の `DEV_ADMIN_USER_ID` の管理者として動く。

1. 上の手順で API を起動する（`pnpm db:up` → `pnpm db:table` → `DEV_ADMIN_USER_ID=dev-admin … pnpm dev:api`）
2. 別のターミナルで `pnpm dev:admin` を動かし、http://localhost:5174/ を開く

予約の一覧（期間・状態で絞る）、予約の詳細、承認・却下・昇格・取消・繰り上げ、受付番号から探す、ができる。テーブルが空なら、上の `pnpm db:demo` で架空の予約を入れる。メールの下書きを開く画面は、まだない。

## HP を手元で開く

HP（apps/site-zebra）の予約ページ（`/reservation/`）には、予約ウィジェット（packages/booking-widget。カレンダーと申込フォーム）が入っている。ウィジェットは、手元の公開 API に Astro（Vite）の dev サーバーの中継（`/public` → http://localhost:8787）でつなぐ。

1. 上の手順で API を起動する（`pnpm db:up` → `pnpm db:table` → `pnpm db:demo` → `DEV_ADMIN_USER_ID=dev-admin … pnpm dev:api`）。カレンダーに予約を並べたいときは `pnpm db:demo` で架空の予約を入れる
2. 別のターミナルで `pnpm dev:site` を動かし、http://localhost:4321/reservation/ を開く（トップページ http://localhost:4321/ からもリンクがある）

カレンダーで予約状況（表示名と時間）を見て、申込フォームから申込める。申込むと、管理画面（`pnpm dev:admin`）の一覧に承認待ちとして出る。API を起動していなければ、カレンダーは「読み込めませんでした」と出す。本番での HP と API のつなぎ方（同じオリジンにするか、など）は、AWS の準備のときに決める。

## 変更の流れ

main は保護されている。ブランチを切って PR を出し、CI（`lint`・`typecheck`・`deps`・`test`・`test-int`・`spec-coverage`・`test-tamper`・`expected-failures`）が通ってからマージする。
テストと実装の進め方は [docs/TESTING.md](docs/TESTING.md)。
