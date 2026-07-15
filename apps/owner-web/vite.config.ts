import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

/**
 * Production web: arrayoperator.com/m/ (mobile beta) — VITE_BASE=/m/
 * Native store: Capacitor webDir — VITE_BASE=./ + VITE_API_BASE=https://arrayoperator.com
 * Preview: VITE_BASE=/
 */
const base = process.env.VITE_BASE || "/m/";

export default defineConfig({
  base,
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  define: {
    // Ensure env is string-replaced for Capacitor builds
    "import.meta.env.VITE_API_BASE": JSON.stringify(
      process.env.VITE_API_BASE || ""
    ),
    "import.meta.env.VITE_SITE_ORIGIN": JSON.stringify(
      process.env.VITE_SITE_ORIGIN || process.env.VITE_API_BASE || ""
    ),
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

