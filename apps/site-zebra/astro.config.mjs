import { defineConfig } from "astro/config";

// URL のパスは今の HP と同じにし、正式なホスト名は www にする（docs/product-specs/index.md、TECH_STACK.md）
export default defineConfig({
  site: "https://www.studiozebra-1st.com",
  trailingSlash: "always",
  build: {
    // /studio/ を /studio/index.html として出力する（今の HP と同じ末尾スラッシュの URL）
    format: "directory",
  },
});
