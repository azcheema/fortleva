import { defineConfig } from "vitest/config";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

// Integration suite: runs against a real Postgres as the REAL
// app_runtime role (TENANCY.md §11 — a local owner/superuser role
// false-passes RLS). Sequential: shared database state.
//
// 30 s per test is a hang guard next to the database; the GitHub runner
// is ~100 ms from the EU Neon per round trip and needs more (ci.yml sets
// DBTEST_TIMEOUT_MS; the tx budget is DB_TX_TIMEOUT_MS in src/db).
const TIMEOUT_MS = Number(process.env["DBTEST_TIMEOUT_MS"]) || 30_000;

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
    testTimeout: TIMEOUT_MS,
    hookTimeout: Math.max(TIMEOUT_MS, 90_000),
  },
});
