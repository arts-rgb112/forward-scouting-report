import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // 로컬 시연/검증 전용 — staging API 의 CORS 를 우회하려고 넣은 프록시.
  // 배포엔 영향 없음(dev 서버에서만 동작). 필요 없어지면 지워도 됨.
  server: {
    proxy: {
      "/api": {
        target: "https://forward-scouting-report.onrender.com",
        changeOrigin: true,
        secure: true,
      },
    },
  },
});
