import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 期望固定端口与明确的 host：dev server 地址由 tauri.conf.json 的 build.devUrl 引用。
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5273,
    strictPort: true,
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
