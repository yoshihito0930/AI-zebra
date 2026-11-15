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
| `MAIL_STAFF_NAME` | お客様へのメールの下書きに差し込む担当者名（例：`架空 担当`）。ない・空なら「（担当者名）」と出す |
| `MAIL_SIGNATURE` | 下書きの最後の署名。改行は `\n`（バックスラッシュと n の2文字）と書く（例：`スタジオ（架空）\nTEL 000-0000-0000`）。ない・空なら署名を出さない |

`DEV_ADMIN_USER_ID` を読むのは手元の Node サーバー（`apps/api/src/server.ts`）だけ。本番（Lambda）は読まず、API Gateway の JWT オーソライザーが確かめたトークンの `sub` を使う（[docs/design-docs/admin-api.md](docs/design-docs/admin-api.md)「認証」）。

`MAIL_STAFF_NAME`・`MAIL_SIGNATURE` は、手元の Node サーバーと本番（Lambda）の両方が読む（[docs/design-docs/admin-api.md](docs/design-docs/admin-api.md)「担当者名と署名の設定」）。本物の担当者名や電話番号はリポジトリに書かず、本番の値は Lambda の環境変数に入れる。

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

予約の一覧（期間・状態で絞る）、予約の詳細、承認・却下・昇格・取消・繰り上げ、受付番号から探す、予約の変更（詳細から）、予約の直接入力、バッファの切り替え（詳細から）、お客様の情報・撮影の内容を直す（詳細から）、ブロック枠を入れる・直す・消す（一覧から）、ができる。変更と直接入力では、入力に応じた見積（今の料金表）を出して確定金額の初期値にし、締め切りなどの警告が出たら、確かめてから送り直す。テーブルが空なら、上の `pnpm db:demo` で架空の予約を入れる。メールの下書きを開く画面は、まだない（操作のあとに、作った下書きの一覧だけを出す）。

## HP を手元で開く

HP（apps/site-zebra）の予約ページ（`/reservation/`）には、予約ウィジェット（packages/booking-widget。カレンダーと申込フォーム）が入っている。ウィジェットは、手元の公開 API に Astro（Vite）の dev サーバーの中継（`/public` → http://localhost:8787）でつなぐ。

1. 上の手順で API を起動する（`pnpm db:up` → `pnpm db:table` → `pnpm db:demo` → `DEV_ADMIN_USER_ID=dev-admin … pnpm dev:api`）。カレンダーに予約を並べたいときは `pnpm db:demo` で架空の予約を入れる
2. 別のターミナルで `pnpm dev:site` を動かし、http://localhost:4321/reservation/ を開く（トップページ http://localhost:4321/ からもリンクがある）

カレンダーで予約状況（表示名と時間）を見て、申込フォームから申込める。申込むと、管理画面（`pnpm dev:admin`）の一覧に承認待ちとして出る。API を起動していなければ、カレンダーは「読み込めませんでした」と出す。本番での HP と API のつなぎ方（同じオリジンにするか、など）は、AWS の準備のときに決める。

## デモの通し手順

管理画面とお客様の画面（HP の予約ページ）を、手元で一緒に触るときの手順。データはすべて架空のもの（`pnpm db:demo`）。

### 始める

最初の1回だけ `pnpm install` を動かす（Docker を起動しておく）。

ターミナルを3つ使う。

1. ターミナル1：データベースと API

   ```sh
   pnpm db:up
   pnpm db:table
   pnpm db:demo
   DEV_ADMIN_USER_ID=dev-admin MAIL_STAFF_NAME="架空 担当" DYNAMODB_TABLE_NAME=zebra-local DYNAMODB_ENDPOINT=http://localhost:8000 pnpm dev:api
   ```

   `pnpm db:demo` は、動かした日の翌日から来月の末日までに、架空の予約とブロック枠を入れ、その一覧を表示する（受付番号もここに出る）。
2. ターミナル2：`pnpm dev:admin` を動かし、http://localhost:5174/ を開く（管理画面）
3. ターミナル3：`pnpm dev:site` を動かし、http://localhost:4321/reservation/ を開く（お客様の画面）

### 確かめること

上から順に試すと、お客様の申込から管理者の操作までを一通り通せる。

1. お客様の画面のカレンダーに、デモの予約が「仮予約」「本予約」「第二キープ」「予約不可」と時間だけで並ぶ（誰の予約か・金額は出ない。INV-3）。1日に4件以上ある日は「他○件」と出て、押すとその日の一覧が開く
2. 空いている日を押し、申込フォームで本予約か仮予約を申込む（氏名・連絡先は架空のもの）。入力に応じて見積額が出て、受け付けると受付番号が出る
3. 管理画面の一覧で「承認待ちをすべて見る」を押すと、2の申込が出る。上の「受付番号から探す」に2の受付番号を入れても開ける
4. 詳細で確定金額を入れて承認する。作った下書き（承認）の一覧が出る
5. 同じ予約を「直す」から延長する。見積が変わり、確定金額の初期値になる。締め切りなどの警告が出たら、確かめてから送り直す
6. 詳細でバッファを30分にする。お客様の画面を読み直し、その予約の終わりの30分後から申込めることを確かめる（1時間のままなら断られる）
7. お客様の画面で、「仮予約」の時間と重なる日時を選ぶと、第二キープとして申込むよう案内が出る
8. 管理画面の一覧から、ブロック枠を入れる。お客様の画面を読み直すと「予約不可」として出る。管理画面で消すと、出なくなる
9. 管理画面の「直接入力」で、電話で受けた予約として入れる（氏名と、電話番号かメールアドレスのどちらか1つが必須）
10. 本予約を取消す。取消の前にキャンセル料が出て、取消すとお客様の画面のカレンダーから消える

メールの下書きを開いて Gmail にコピーする画面は、まだない（API はある。操作のあとに、作った下書きの一覧だけが出る）。

### 終わりにする

1. ターミナル3とターミナル2で、`Ctrl+C` を押して HP と管理画面を止める
2. ターミナル1で、`Ctrl+C` を押して API を止める
3. ターミナル1で `pnpm db:down` を動かし、データベース（Docker のコンテナ）を止める

- ローカルの DynamoDB はデータをメモリにだけ置くので、`pnpm db:down` で入れたデータはすべて消える。次に始めるときは、「始める」の手順をもう一度動かす
- データを消さずに続けたいときは、3をせずにおく（Docker のコンテナが動いたまま残る）。そのあと `pnpm db:demo` をもう一度動かしても、テーブルが空でないので何も入れない
- 統合テスト（`pnpm test:int`）も同じデータベースを使う。テストを動かすときは、デモの API を止めてからにすると、テストが遅くならない

## 変更の流れ

main は保護されている。ブランチを切って PR を出し、CI（`lint`・`typecheck`・`deps`・`test`・`test-int`・`spec-coverage`・`test-tamper`・`expected-failures`）が通ってからマージする。
テストと実装の進め方は [docs/TESTING.md](docs/TESTING.md)。
