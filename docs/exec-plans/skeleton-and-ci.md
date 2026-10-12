# 計画：骨組みと CI

状態：**確定**（2026-10-12 承認）

## 目的

エージェントが TESTING.md の手順（テストを先に書く → 人間がレビュー → 実装）で開発を回せる状態を作る。
そのために、モノレポの骨組みと、ドキュメントで決めた制御（テストの改ざん防止、例の網羅の確認、不変条件の lint）を CI に組み込む。

## この計画でやらないこと

- AWS・Terraform・デプロイ（AWSアカウントの準備ができてから、別の計画にする）
- 予約のロジック（空き判定、料金など）の実装。骨組みのあと、最初の1周として TESTING.md の手順で行う
- DynamoDB のキー設計（自律度「低」。別の設計文書で人間が決める）
- 画面のデザイン（docs/DESIGN.md が決まってから）

## 1. ディレクトリ構成

```
apps/site-zebra/          HP（Astro、静的ビルド）
apps/admin/               管理画面（React + Vite）
apps/api/                 予約API（Hono。ローカルは Node サーバー、本番は Lambda）
packages/contracts/       公開APIのスキーマ（Zod）
packages/booking-core/    予約のルール（空き判定、料金、キャンセル料、日時の判定）。入出力を持たない純粋な関数だけ
packages/booking-widget/  HP埋め込み用カレンダーと申込フォーム（React）
packages/clock/           現在時刻を返す部品（INV-7。テストで固定できる）
tooling/eslint-config/    共通の lint 設定（不変条件の lint を含む）
tooling/tsconfig/         共通の TypeScript 設定
scripts/harness/          CI 用の独自チェック（例の網羅、テストの改ざん防止）
harness/                  CI のチェックが読む設定（自律度のパスの対応、例の網羅の保留リスト）
docs/                     仕様・設計・計画
```

`packages/booking-core` は、TECH_STACK.md の構成にはまだない新しいパッケージ。

理由：予約のルールを API から切り離して純粋な関数にすると、DB なしで単体テストとプロパティベーステストを回せる。自律度「中」の領域がこのパッケージに集まるので、テストの改ざん防止のパスの規則も単純になる。

### 依存の方向（INV-5 を含む）

| パッケージ | 依存してよいもの |
|---|---|
| `apps/site-zebra` | `packages/contracts`、`packages/booking-widget`（INV-5） |
| `apps/admin` | `packages/contracts`、`packages/booking-core`、`packages/clock` |
| `apps/api` | `packages/contracts`、`packages/booking-core`、`packages/clock` |
| `packages/booking-widget` | `packages/contracts`、`packages/booking-core`（見積の表示に使う。画面の見積と API の計算を必ず一致させるため） |
| `packages/booking-core` | `packages/contracts` だけ。AWS SDK、HTTP、DB、`Date.now()` を使わない（現在時刻は引数で受け取る） |
| `packages/contracts` | Zod だけ |

## 2. 共通の道具

| 役割 | 採用 | 理由 |
|---|---|---|
| Node.js | 24（LTS）。`.nvmrc` と `package.json` の `engines` で固定 | Lambda が対応している LTS の中で、サポート期間が長い。手元は 22.4.1 なので更新が必要 |
| パッケージ管理 | pnpm（workspaces）。corepack でバージョンを固定 | TECH_STACK.md のとおり。手元には未導入 |
| 言語 | TypeScript 6.0（`strict`）。型チェックはパッケージごとの `tsc --noEmit` を `pnpm typecheck` でまとめて実行する | typescript-eslint が対応しているのが TypeScript 6.0 までのため、7 系は使わない。パッケージは TypeScript のソースのまま参照させる（ビルド済みの型定義を出さない）ので、プロジェクト参照（`tsc -b`）は使わない |
| テスト | Vitest。プロパティベーステストは fast-check | Vite（管理画面）と設定を揃えられる。TESTING.md の想定どおり |
| lint | ESLint（flat config）と typescript-eslint | 不変条件の lint を `no-restricted-imports` などの標準ルールで書ける |
| 依存の方向 | dependency-cruiser | INV-5 と、上の依存の方向の表を機械で確かめる |
| 整形 | Prettier | |
| 日時 | Luxon（このライブラリ1つに限る。INV-7） | タイムゾーンを明示して扱える。JST の日付の境界の計算が書きやすい |
| ローカルの DB | DynamoDB Local（Docker）。CI では GitHub Actions のサービスコンテナで動かす | TESTING.md の「AWSに接続せずローカルで実行」 |

バージョンは、作業を始める時点の安定版に固定する（`^` を付けない）。

## 3. テストの置き場所とパスの規則（TESTING.md の未決事項の解消案）

- テストは、対象のファイルの隣に `*.test.ts` として置く。統合テストは `*.int.test.ts` とする
- どのパスが自律度「中」の領域かは、`harness/autonomy.json` に glob で書く。CI の改ざん防止のチェックはこのファイルを読む

```json
{
  "medium": [
    "packages/booking-core/src/**",
    "packages/contracts/src/**",
    "apps/api/src/public/**",
    "apps/api/src/mail/**",
    "apps/api/src/gcal/**"
  ]
}
```

- `harness/autonomy.json` 自体の変更も自律度「中」とする（人間がレビューしてマージする）

## 4. CI（GitHub Actions）

プルリクエストと main への push で動かす。この計画で作るのは次のジョブ。dev へのデプロイと `terraform plan` は、AWS の計画で足す。

| ジョブ | 内容 | 関係する決まり |
|---|---|---|
| 準備 | pnpm のインストール（キャッシュ付き） | |
| lint | ESLint（不変条件の lint を含む）、Prettier の確認 | INV-6、INV-7（下の5） |
| 型チェック | `pnpm typecheck`（パッケージごとの `tsc --noEmit`） | INV-4（型の面） |
| 依存の方向 | dependency-cruiser | INV-5、1の表 |
| 単体テスト | Vitest（プロパティベーステストを含む） | INV-1、INV-9 |
| 統合テスト | Vitest と DynamoDB Local | INV-2、INV-6、INV-10 |
| 例の網羅 | 独自スクリプト（下の6） | TESTING.md「仕様の例とテストの対応づけ」 |
| テストの改ざん防止 | 独自スクリプト（下の6）。プルリクエストのときだけ | TESTING.md「実装PRでテストを変更させない」 |

手元でも同じ確認を `pnpm check`（lint・型・依存・単体テスト）と `pnpm test:int`（統合テスト）で実行できるようにする。

CI が失敗したらマージできないよう、main ブランチを保護する（必須のステータスチェック）。そのため、リポジトリは**公開**にする（GitHub の無料プランでは、非公開リポジトリのブランチ保護が使えないため）。

### 公開リポジトリにするための決まり

- 秘密情報（鍵、トークン、パスワード）とお客様の個人情報は、リポジトリに置かない。AWS へは OIDC で認証し、設定値は SSM Parameter Store に置く（TECH_STACK.md）
- GitHub のシークレットスキャンとプッシュ保護を有効にする
- フォーク（外部の人）からのプルリクエストでは、AWS の認証や書き込みの権限を使うジョブを動かさない。`pull_request_target` は使わない。ワークフローの `permissions` は最小限にする
- main ブランチの保護：プルリクエストを必須にし、CI のジョブをすべて必須のステータスチェックにする
- リリースタグ（本番デプロイのきっかけ）は、ルールセットで作れる人を制限する

## 5. この計画で入れる不変条件の lint

コードがまだなくても書けるものだけを入れる。残りは、対象のコードを作るときに入れる。

| 不変条件 | この計画で入れる lint | 後で入れるもの |
|---|---|---|
| INV-5 | dependency-cruiser の規則（1の表） | |
| INV-6 | `@aws-sdk/client-sesv2` を import できるのは `apps/api/src/mail/` の中だけ | 送信関数の構造と統合テスト（メール機能を作るとき） |
| INV-7 | `Date.now()`・`new Date()`（引数なし）を `packages/clock` の外で禁止。日時ライブラリは Luxon 以外を import 禁止 | |
| INV-9 | | 金額の型（branded type）と、金額に浮動小数を使わない規則（料金計算を作るとき） |
| INV-10 | | ロガーに渡せる型の制限（ロガーを作るとき） |

## 6. 独自チェック

### 例の網羅（scripts/harness/spec-coverage）

- product-specs の Markdown から、「例」という見出し（`### 例`、`#### 例`）を探し、そのすぐ上の見出しを「節の名前」として集める
- テストファイルの `describe("節の名前"` を探し、節ごとに対応するテストがあるかを確かめる
- まだ実装していない節は、`harness/spec-coverage-pending.txt` に書いておけば失敗にしない（最初はすべての節がここに入る）
- 保留リストに書いてある節のテストができたら、保留リストから消すよう失敗させる（リストが古くならないように）

#### 例

| 状況 | 結果 |
|---|---|
| 節「申込の締め切り」のテストがあり、保留リストにない | 成功 |
| 節「申込の締め切り」のテストがなく、保留リストにある | 成功（保留中） |
| 節「申込の締め切り」のテストがなく、保留リストにもない | 失敗 |
| 節「申込の締め切り」のテストがあるのに、保留リストにも残っている | 失敗（保留リストから消す） |
| 仕様に新しい節「予約の変更」の例を足したが、テストも保留リストの記載もない | 失敗 |

### テストの改ざん防止（scripts/harness/test-tamper）

- プルリクエストで変更されたファイルを、`harness/autonomy.json` で「自律度『中』のテスト」「実装」「そのほか」に分ける
- 「自律度『中』のテスト」と「実装」の両方が含まれていたら失敗させる

#### 例

| PRで変更されたファイル | 結果 |
|---|---|
| `packages/booking-core/src/availability.test.ts` だけ | 成功（テストのPR。人間がレビュー） |
| `packages/booking-core/src/availability.ts` だけ | 成功（実装のPR） |
| 上の2つの両方 | 失敗 |
| `apps/site-zebra/src/components/Header.test.ts` と `Header.tsx` | 成功（自律度「高」の領域） |
| `packages/booking-core/src/availability.test.ts` と `docs/product-specs/booking.md` | 成功（仕様とテストを一緒に直すPR。人間がレビュー） |

## 7. エージェントの作業環境

- テストを書くエージェントと実装するエージェントを分けるため、Claude Code のサブエージェントを2つ定義する（`.claude/agents/`）
  - テスト担当：product-specs と contracts だけを読み、`*.test.ts` だけを書く。実装ファイルは読まない・書かない
  - 実装担当：テストを通すように実装する。テストファイルは書き換えない
- 読み書きできるパスは、エージェントの指示に加えて、Claude Code の権限設定（`.claude/settings.json` の deny）でも制限する
- タグの作成、リリースの作成、`gh api`、PR のマージ、リポジトリ設定の変更は、`.claude/settings.json` で禁止済み（下の「決定の記録」）
- AGENTS.md の「リポジトリ構成（予定）」を、実際の構成に合わせて更新する

## 8. 進め方（PRの分け方）

| 順 | PR | 自律度 |
|---|---|---|
| 1 | ルートの設定（pnpm workspaces、Node のバージョン、TypeScript・ESLint・Prettier・Vitest の共通設定）と、空の `packages/booking-core`・`packages/contracts`・`packages/clock` | 高 |
| 2 | CI の基本のジョブ（lint、型、依存の方向、単体テスト）と、5の lint | 中（CIのルールなので人間がレビュー） |
| 3 | 独自チェック2つと `harness/` の設定ファイル。スクリプト自体にも、6の例からテストを書く | 中 |
| 4 | アプリの骨組み：Astro（トップページだけ）、管理画面（空の画面）、API（ヘルスチェックだけ）、ウィジェット（空のコンポーネント） | 高 |
| 5 | 統合テストの土台（DynamoDB Local、docker compose、CI のサービスコンテナ） | 高 |
| 6 | エージェントの定義と権限設定、AGENTS.md の更新 | 中 |

## 9. 完了の条件

- `pnpm install` と `pnpm check` が、手元とCIの両方で通る
- 4つのアプリ・パッケージが、それぞれ1コマンドで起動できる（HP、管理画面、API）
- 例の網羅と改ざん防止のチェックが、6の例どおりに動く（スクリプトのテストが通る）
- main ブランチで、CI が通らないとマージできない

## 決定の記録

- ウィジェットの見積表示に `booking-core` を使う。INV-5 は「直接の依存」の決まりと明記した（core-beliefs.md）
- リポジトリを公開にし、無料プランでブランチ保護を使う
- この計画全体で進める
- コミットの作者欄のメールアドレスは、そのまま公開する
- 手元の Node.js 24 と pnpm は、Claude が nvm と corepack で入れる
- リリースタグの名前は `v*`（`v1.0.0` など）。タグのルールセットの対象もこれに合わせてある
- エージェントにタグを作らせない方法は、Claude Code の権限設定（`.claude/settings.json` の deny）で禁止する。エージェント専用の GitHub アカウントは作らない。設定で止める方法なので、GitHub 側では止まらないことを受け入れる
- エージェントは gh コマンドを使う。ログインには、このリポジトリだけに限った Fine-grained トークンを使い、Administration の権限を付けない（ルールセットやリポジトリの設定を変えられないようにする）
- gh の導入と権限設定は、PR6 より前に先に入れる（gh でタグを作る経路があるため）
- エージェントによるPRのマージは、当面すべて禁止する（自律度「高」も、マージは人間）。PRが自律度「中」の領域に触れていないことをCIで判定できるようになったら見直す

## 人間が行う準備

- [ ] リポジトリを公開にし、シークレットスキャン・プッシュ保護・main ブランチの保護・タグのルールセットを設定する
