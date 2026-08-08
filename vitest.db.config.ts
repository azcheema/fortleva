import { defineConfig } from "vitest/config";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

// Integration suite: runs against a real Postgres as the REAL
// app_runtime role (TENANCY.md §11 — a local owner/superuser role
// false-passes RLS). Sequential: shared database state.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.dbtest.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
