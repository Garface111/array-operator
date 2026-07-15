import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

/**
 * Dev server proxies /v1/* to prod API via arrayoperator.com (same-origin path
 * shape as Netlify _redirects). Never points at local public/ desktop site.
 *
 * Preview / future Netlify site for this app: deploy apps/owner-web/dist only.
 * Stable arrayoperator.com continues to publish public/ from main.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      "/v1": {
        target: "https://arrayoperator.com",
        changeOrigin: true,
        secure: true,
      },
    },
  },
  preview: {
    port: 4174,
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
