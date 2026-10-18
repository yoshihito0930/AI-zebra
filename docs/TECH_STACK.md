# Tech Stack

## 方針

- **言語はTypeScriptに統一する**（インフラのTerraformを除く）
- **AWSのコストを最小にする。** スタジオ1軒分のアクセスなら、ほぼ無料枠に収まる構成にする
- **インフラはすべてTerraformで管理する。** コンソールでの手作業の変更はしない。例外は、Route 53 に移すまでの Xserver の DNS レコード（「ドメインとDNS」）
- **ローカルでも本番と同じように動かせること。** エージェントがワークツリーごとに起動して検証できるようにする

## 構成

| 役割 | 採用 | 理由 |
|---|---|---|
| HP | Astro（静的ビルド）→ S3 + CloudFront | 静的配信でほぼ無料。表示が速い |
| 管理画面 | React + Vite（SPA）→ S3 + CloudFront | 静的配信。利用者が少ないのでSSRは不要 |
| 予約ウィジェット | React（HPに埋め込み） | 管理画面とコンポーネントを共有できる |
| API | Hono on Lambda（Node.js） | 同じアプリをローカルではNodeサーバー、本番ではLambdaとして動かせる |
| APIの入口 | API Gateway HTTP API | REST APIより安い。JWT認証に対応 |
| DB | DynamoDB（オンデマンド） | 使った分だけの課金。予約件数が少ないので安い |
| 認証 | Cognito（管理画面のスタッフのみ） | 自前で認証を作らない |
| メール | SES | 安い。お客様への送信は管理者の確認後のみ（定型の受付通知を除く。INV-6）。管理者への新しい申込の通知にも使う |
| 定期実行 | EventBridge Scheduler → Lambda | Googleカレンダーの取り込み（1日1回）。常時起動しない（INV-8） |
| 外部連携 | Google Calendar API（v1は読み取りのみ。書き込みはv1のあと） | 並行稼働の間の予約の取り込み。認証情報は SSM Parameter Store（SecureString）に置く（INV-8）。GCPで別の仕組みを作らず、AWSとTerraformにまとめる |
| スキーマ・契約 | Zod（packages/contracts） | API・ウィジェット・管理画面で同じ型を使う |
| 予約のルール | packages/booking-core（入出力を持たない純粋な関数） | DB なしでテストできる。API とウィジェット（見積表示）で同じ計算を使う |
| 実行環境 | Node.js 24（LTS） | Lambda が対応している LTS で、サポート期間が長い |
| テスト | Vitest、fast-check、DynamoDB Local（Docker） | AWS に接続せずに、単体・プロパティベース・統合テストを回せる |
| lint・整形 | ESLint（typescript-eslint）、dependency-cruiser、Prettier | 不変条件の一部を lint にする（[TESTING.md](TESTING.md)） |
| 日時 | Luxon（日時ライブラリはこれ1つ。INV-7） | タイムゾーンを明示して扱える |
| IaC | Terraform。stateはS3（`use_lockfile` でロック） | ロック用のDynamoDBテーブルが不要 |
| パッケージ管理 | pnpm workspaces | モノレポの標準的な構成 |

## DynamoDBでの重複予約の防ぎ方（INV-1, INV-2）

RDBの制約のようには防げないため、アプリ側で保証する。

- 時間を30分（予約の時間単位）の枠に区切り、枠ごとにロック用のアイテムを持つ
- 予約するときは、占有区間に含まれるすべての枠のアイテムと予約本体を、`TransactWriteItems` と条件付き書き込みでまとめて作る
- 枠がひとつでも埋まっていればトランザクション全体が失敗する
- 1件の占有区間は最長25時間（予約24時間＋バッファ1時間）で50枠。予約本体と合わせて51アイテムで、`TransactWriteItems` の上限（100アイテム）に収まる。最長利用時間を延ばすときは、この上限を確認する
- 第二キープも枠を確保する。仮予約と同じ枠に重なれるよう、1つの枠のアイテムに「本体」と「第二キープ」の2つの欄を持たせる方針とする
  - 通常の申込：両方の欄が空のときだけ、本体の欄を取る
  - 第二キープの申込：第二キープの欄が空で、本体の欄が空か、その第二キープが付く仮予約のものであるときだけ、第二キープの欄を取る（第二キープは承認済みの仮予約1件に付く。[reservation-model.md](design-docs/reservation-model.md)）
  - 繰り上げ：第二キープの欄から本体の欄へ移す
  - 第二キープが付いた仮予約を動かすとき：その仮予約の第二キープが持つ欄とは重なってよい
  - 欄を別アイテムに分けると、確認するアイテムが最長の予約で101となり、上限を超えるため
- バッファの1時間/30分の切り替えも、枠の確保・解放を伴うので、予約本体の更新と同じトランザクションで行う

キー設計の詳細は、骨組みを作るときに design-docs に書く。キー設計の変更は自律度「低」。

## 時刻で起きる処理

予約の状態を時刻で自動的に変える処理はない（仮予約の昇格・取消は管理者が手で行う。[booking.md](product-specs/booking.md)）。
期限切れなどの警告は、管理画面の表示時に計算する。
定期実行するのは、Googleカレンダーの取り込みだけ（[index.md](product-specs/index.md)）。取り込みも、ブロック枠の作成・更新・削除と枠の確保・解放を1トランザクションで行う（INV-2）。

## コストのために使わないもの（INV-8）

| 使わないもの | 理由 | 代わり |
|---|---|---|
| VPC内のLambda | NAT Gatewayが月数千円かかる | VPCの外で動かす |
| Secrets Manager | シークレットごとに課金される | SSM Parameter Store（標準） |
| 保存期間なしのCloudWatch Logs | 溜まり続ける | すべてのロググループに保存期間を設定 |
| WAF | 最低でも月数ドル | 必要になったら検討 |
| 常時起動のリソース（EC2、RDSなど） | 固定費になる | サーバーレスのみ |

AWS Budgetsで月額のアラートを設定する。

## 環境

- `dev`（開発・非公開）と `prod`（本番）の2つ
- 本番は公開まで、ベーシック認証などで非公開にしておく

### AWSアカウント

- 環境ごとに AWS アカウントを分ける（dev 用と prod 用の2つ）。AWS Organizations でまとめ、請求と AWS Budgets を一括で管理する
- エージェントに渡す認証情報は dev アカウントのものだけ。prod アカウントの変更は人間が行う

理由：エージェントが dev を自由に触れる前提なので、本番への変更を権限で防げる（自律度「低」の「本番の `terraform apply`」を、ルールではなくアカウントの境界で強制する）。Organizations 自体は無料で、コストはほぼ増えない。

注意：2025年7月以降の AWS の無料枠では、新しいアカウントの「無料プラン」のままでは Organizations に参加できない場合がある。アカウントを作るときに条件を確認する。

## ドメインとDNS

- ドメインは今のHPの `studiozebra-1st.com` を引き継ぐ。DNS は当面 Xserver のまま使い、いずれ Route 53 に移す
- 新HPの正式なURLは `https://www.studiozebra-1st.com/`。Route 53 に移したあとも `www` のままにする
- `studiozebra-1st.com`（www なし）へのアクセスは、Xserver のサーバーで `www` の同じパスへ301リダイレクトする。このため、Route 53 に移すまで Xserver のサーバー契約を続ける

理由：Xserver の DNS では、ルートドメインを CloudFront に向けられない（ALIAS レコードがない）。正式なURLを最初から `www` にしておけば、Route 53 に移すときにURLを変えずに済み、URLの移行は1回で終わる。

| ホスト名 | 環境 | 向け先 |
|---|---|---|
| `www.studiozebra-1st.com` | prod | HP（CloudFront） |
| `admin.studiozebra-1st.com` | prod | 管理画面（CloudFront） |
| `api.studiozebra-1st.com` | prod | API（API Gateway のカスタムドメイン） |
| `dev.studiozebra-1st.com` | dev | HP（CloudFront、ベーシック認証で非公開） |
| `admin.dev.studiozebra-1st.com` | dev | 管理画面 |
| `api.dev.studiozebra-1st.com` | dev | API |
| `studiozebra-1st.com` | — | Xserver（`www` へ301リダイレクト） |

- Xserver の DNS に手で入れるレコード：上のホスト名の CNAME、ACM 証明書の DNS 検証用の CNAME、SES のドメイン認証（DKIM）の CNAME と DMARC など
- 入れるべきレコードは Terraform の出力として一覧にし、人間が Xserver の管理画面で入れる（DNS の変更は自律度「低」）
- `@studiozebra-1st.com` のメールボックスは使っていない。今の MX・SPF（Xserver のメール用）は、引き継ぐ必要がない

### メールの送信元

- お客様へのメールは `noreply@studiozebra-1st.com` から SES で送る。返信先（Reply-To）は `studiozebra1st@gmail.com`

理由：独自ドメインで DKIM 署名すると届きやすい。Gmail のアドレスを差出人にして SES から送ると、DMARC で弾かれやすい。受信用のメールボックスは要らない。

## CI/CD

- GitHub Actions を使う（リポジトリは GitHub）
- AWS へは OIDC で認証し、長期のアクセスキーを置かない。アカウントごとに IAM ロールを分ける

| きっかけ | 実行すること |
|---|---|
| プルリクエスト | lint、型チェック、テスト一式、dev の `terraform plan`、仕様の例の節がテストにあるかの確認、テストと実装の同時変更の確認（[TESTING.md](TESTING.md)） |
| main へのマージ | dev への `terraform apply` とアプリのデプロイ |
| 人間がリリースタグ（`v*`。例：`v1.0.0`）を付ける | prod へのアプリのデプロイ。prod の `terraform plan` |
| prod の `terraform apply` | CI では実行しない。人間が plan の結果を確認して手元から実行する |

理由：本番に出るタイミングを人間が決められる。

リポジトリは公開にし、main ブランチの保護（CI を必須のステータスチェックにする）と、タグのルールセットを使う（GitHub の無料プランでは、非公開リポジトリでこれらが使えないため）。公開リポジトリでの決まりは [docs/exec-plans/skeleton-and-ci.md](exec-plans/skeleton-and-ci.md) を参照。


## 未決事項

- [ ] Organizations の管理アカウントを dev と prod のどちらにするか（または管理専用のアカウントを作るか）
- [ ] Route 53 に移す時期。移したあと Xserver を解約する時期
- [ ] ドメインの登録先（レジストラ）と、更新の管理
- [ ] 24時間を超えるブロック枠（連休の休業、Googleカレンダーの複数日の予定など）の枠の確保方法。30分の枠に区切ると、5日間で240アイテムになり、`TransactWriteItems` の上限（100アイテム）を超える。INV-2 を守れる形をキー設計で決める（自律度「低」）
