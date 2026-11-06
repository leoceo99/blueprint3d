import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  worker: { format: "es" },
  build: { target: "es2022", chunkSizeWarningLimit: 2000 },
  optimizeDeps: { exclude: ["replicad-opencascadejs"] },
  test: { environment: "node", testTimeout: 60000, include: ["tests/**/*.test.ts"] },
} as any);
