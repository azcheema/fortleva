import { defineConfig } from "vitest/config";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

// Integration suite: runs against a real Postgres as the REAL
// app_runtime role (TENANCY.md §11 — a local owner/superuser role
// false-passes RLS). Sequential: shared database state.
//
// 30 s per test is a hang guard next to the database. A caller ~100 ms
// away needs more, which is what DBTEST_TIMEOUT_MS is for (the matching
// transaction budget is DB_TX_TIMEOUT_MS in src/db). Since 2026-09-01
// ci.yml sets NEITHER — both db jobs run against a Postgres service
// container on the runner, so this 30 s default is the guard there too;
// only the manual neon-smoke.yml workflow still widens them.
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
