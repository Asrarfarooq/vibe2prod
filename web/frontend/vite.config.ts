import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  // Dev-only: point /api at a deployed dashboard, e.g. VITE_API_TARGET=https://<service>.run.app
  const target = loadEnv(mode, ".", "").VITE_API_TARGET || "http://127.0.0.1:8080";
  return {
    plugins: [react()],
    build: {
      outDir: "dist",
      emptyOutDir: true,
      sourcemap: false,
    },
    server: {
      host: "127.0.0.1",
      port: 5173,
      proxy: {
        "/api": { target, changeOrigin: true },
      },
    },
  };
});
