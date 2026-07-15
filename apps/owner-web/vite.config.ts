import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

/**
 * Production: served at arrayoperator.com/m/ (mobile beta).
 * Dev: same /m base so paths match; proxy /v1 → prod API.
 * Desktop vanilla site remains public/ at site root.
 *
 * Preview site (ao-owner-web-preview) can still deploy dist/ at root by
 * overriding: VITE_BASE=/ npm run build
 */
const base = process.env.VITE_BASE || "/m/";

export default defineConfig({
  base,
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

