// 組み立てのときに読む環境変数の型（Astro の import.meta.env。https://docs.astro.build/en/guides/environment-variables/）
interface ImportMetaEnv {
  /** 予約ページに予約ウィジェットを出すか（src/booking-widget-flag.ts）。`true` で出す。ない・空・`false` なら今の仕組み */
  readonly PUBLIC_BOOKING_WIDGET_ENABLED?: string;
  /** 予約ページの連絡先に出すスタジオの電話番号（src/studio-tel.ts）。ない・空なら電話番号の行を出さない。リポジトリには架空の値だけを書く */
  readonly PUBLIC_STUDIO_TEL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
