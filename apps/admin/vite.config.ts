import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    // 手元の管理 API（pnpm dev:api）へ中継する。同じオリジンになるので、API に CORS は要らない
    proxy: { "/admin": "http://localhost:8787" },
  },
});
