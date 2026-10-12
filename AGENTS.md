# Studio Zebra

撮影スタジオ「スタジオゼブラ」の公式HPと予約管理システムのモノレポ。
このファイルは目次です。詳細は各ドキュメントを参照してください。

## 最初に読むもの

1. [docs/design-docs/core-beliefs.md](docs/design-docs/core-beliefs.md) — 不変条件と自律度。**必読。ここに反する変更はしない**
2. [docs/product-specs/index.md](docs/product-specs/index.md) — 何を作るか（v1スコープ）
3. [docs/product-specs/booking.md](docs/product-specs/booking.md) — 予約・空き判定の仕様
4. [docs/TECH_STACK.md](docs/TECH_STACK.md) — 技術スタックと選定理由
5. [docs/TESTING.md](docs/TESTING.md) — テストの進め方。**テストを書く・実装する前に必読**
6. [docs/exec-plans/](docs/exec-plans/) — 進行中の作業計画

デザインの方向性（docs/DESIGN.md）は未決定。UIは決定まで最小限の見た目で実装する。

## リポジトリ構成（予定）

```
apps/site-zebra/      HP（Astro）
apps/admin/           予約管理画面
apps/api/             予約API
packages/contracts/   公開APIのスキーマ（Zod）
packages/booking-core/    予約のルール（入出力を持たない純粋な関数）
packages/booking-widget/  HP埋め込み用カレンダー
packages/clock/           現在時刻の部品（INV-7）
infra/                Terraform
docs/                 仕様・設計・計画
```

詳細は [docs/exec-plans/skeleton-and-ci.md](docs/exec-plans/skeleton-and-ci.md)。骨組み作成後、このセクションを実際の構成に合わせて更新すること。

## 作業ルール

- 不変条件（core-beliefs.md の INV-*）に関わる変更は、必ずテストを伴う
- 自律度「中」の領域では、テストを先に仕様から書き、実装PRではテストを変更しない（TESTING.md）
- 自律度「低」の領域は、変更を提案するだけで実行しない
- 仕様が曖昧なときは推測で実装しない。product-specs の「未決事項」に追記し、PRで人間に質問する
- 作業中に詰まったこと、足りなかったもの（ドキュメント、lint、ツール）は [docs/harness-log.md](docs/harness-log.md) に記録する
- main への変更は、ブランチを切って PR で行う（main は保護されていて直接 push できない）。PR は `gh pr create` で作り、CI の結果は `gh pr checks` と `gh run view` で確かめる
- PR のマージ、タグ・リリースの作成、リポジトリ設定の変更は人間が行う。エージェントからは `.claude/settings.json` で禁止している
- 決まったことはリポジトリに残す。会話やチャットにしかない決定は、存在しないものとして扱う
- このリポジトリは公開する。秘密情報（鍵、トークン、パスワード）とお客様の個人情報は、コード・テストデータ・ドキュメント・コミットに入れない。テストデータの氏名や連絡先は、架空のものを使う
