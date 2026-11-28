# 計画：HP を zebra リポジトリに一本化する

状態：**進行中**（2026-11-28 開始）

## 目的

HP のページとデザインは zebra リポジトリ（`studio-website/astro`）で作り、このリポジトリは予約 API・管理画面・予約ウィジェットを持つ（ユーザーの判断）。ウィジェットは、HP にスクリプト1行で載せる（ユーザーの判断）。

## 手順

1. 文書を直す（この計画を足した PR）：AGENTS.md、index.md、TECH_STACK.md、DESIGN.md
2. ウィジェットの載せ方を決める：docs/design-docs/widget-embed.md。決めることは次のとおり
   - スクリプトの形（置く場所の要素、設定の渡し方〈API の URL・リンク先・色や文字〉）
   - 配る場所
   - HP のスタイルと混ざらないようにする方法（Shadow DOM など）
3. ウィジェットを1つのファイルに組み立てる：組み立ての設定、CI の build での確かめ、手元で試すページ
4. apps/site-zebra を、ウィジェットを手元で試すページだけにする
   - `/horizon/`・`/policy/`・今の仕組みの予約ページ・機能フラグ（`PUBLIC_BOOKING_WIDGET_ENABLED`）・連絡先の部品・`PUBLIC_STUDIO_TEL` は、zebra の HP が持つので消す
   - 消す前に、zebra の同じページと食い違いがないかを確かめる（利用規約の食い違い17か所の一覧は PR #104）
5. zebra の予約ページに、ウィジェットのスクリプトを載せる（zebra リポジトリの作業。受付の開始の前は載せない）
6. 公開 API の CORS（HP のオリジンを許す）と、ウィジェットのファイルの配信（AWS の準備のとき）

## まだ決めていないこと

- ウィジェットのファイルをどこから配るか（このリポジトリの配信〈管理画面と同じ CloudFront など〉か、zebra の HP に写すか）
- 検証用ドメイン `studiozebra-test.xyz` から、手元や dev の API に申込めるようにするか
