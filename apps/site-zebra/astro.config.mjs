import { request } from "node:http";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";

/** 手元の公開 API（pnpm dev:api） */
const DEV_API_ORIGIN = "http://localhost:8787";

/**
 * dev サーバーで `/public/…` を手元の公開 API へ中継する（同じオリジンになるので、API に CORS は要らない）。
 * Vite の server.proxy は使えない：Astro の dev サーバーは、末尾スラッシュの確かめ（trailingSlash: "always"）を
 * Vite の中継より前に置くので、`/public/calendar` が中継の前に 404 になる（docs/harness-log.md）。
 * そこで、Astro のあと（enforce: "post"）に、中継をいちばん前に差し込む。
 * 本番での HP と API のつなぎ方は、AWS の準備のときに決める
 */
function devPublicApiProxy() {
  return {
    name: "zebra:dev-public-api-proxy",
    apply: "serve",
    enforce: "post",
    configureServer(server) {
      return () => {
        server.middlewares.stack.unshift({
          route: "",
          handle(req, res, next) {
            if (req.url === undefined || !req.url.startsWith("/public/")) return next();
            const target = new URL(req.url, DEV_API_ORIGIN);
            const upstream = request(
              target,
              { method: req.method, headers: { ...req.headers, host: target.host } },
              (apiResponse) => {
                res.writeHead(apiResponse.statusCode ?? 502, apiResponse.headers);
                apiResponse.pipe(res);
              },
            );
            upstream.on("error", () => {
              // API を起動していない。ウィジェットは「読み込めませんでした」と出す
              if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
              res.end("公開 API（pnpm dev:api）につながらない");
            });
            req.pipe(upstream);
          },
        });
      };
    },
  };
}

// URL のパスは今の HP と同じにし、正式なホスト名は www にする（docs/product-specs/index.md、TECH_STACK.md）
export default defineConfig({
  site: "https://www.studiozebra-1st.com",
  trailingSlash: "always",
  build: {
    // /studio/ を /studio/index.html として出力する（今の HP と同じ末尾スラッシュの URL）
    format: "directory",
  },
  // 予約ウィジェット（packages/booking-widget、React）を予約ページに埋め込む
  integrations: [react()],
  vite: {
    plugins: [devPublicApiProxy()],
    // dev サーバーで、React の描画の部品（@astrojs/react の client.js）が react-dom/client を CommonJS のまま読み、
    // 「createRoot がない」で描けなかった。前もって ES モジュールにまとめておく（docs/harness-log.md）
    optimizeDeps: { include: ["react-dom/client"] },
  },
});
