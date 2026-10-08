import { defineConfig } from "vitest/config";
import { config as loadEnv } from "dotenv";
import { createECDH } from "node:crypto";
import { fileURLToPath } from "node:url";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

// THE SUITE RUNS ON THE NO-OP LIMITER, AS IN CI — never on the founder's
// dev Redis, which `.env.local` has named since 2026-10-01. Files here
// drive `signInEmail` a dozen times from one "unknown" address, and a
// real limiter would turn the later 200s into 429s — and, since Redis
// outlives the process, keep doing it into the NEXT run. A test that wants
// a limit injects one (`setLimiter`). Deleted here, in the parent, so the
// forked workers never see it.
delete process.env["UPSTASH_REDIS_REST_URL"];
delete process.env["UPSTASH_REDIS_REST_TOKEN"];
// AND NEVER REAL MAIL (Phase 5 slice 103): a loopback process already stays on
// the dev transport unless `MAIL_TRANSPORT=amazon-ses` asks otherwise
// (src/config, `mailTransportKind`) — so the flag and the credentials both go,
// and a founder trying real sending from `.env.local` cannot send a dbtest's
// mail to a fixture address.
delete process.env["MAIL_TRANSPORT"];
delete process.env["MAIL_SEND_TO_ANYONE"];
delete process.env["AMAZON_SES_ACCESS_KEY_ID"];
delete process.env["AMAZON_SES_SECRET_ACCESS_KEY"];
delete process.env["AMAZON_SES_FEEDBACK_TOPIC_ARN"];
// AND NEVER A REAL PUSH (Phase 5 slice 106): a throwaway VAPID pair of this
// run's own, and the dev transport — so a founder's `.env.local` pair can never
// sign a push to a real device from a dbtest. The push dbtests inject their own
// transport anyway (`deliverPushes(…, {transport})`), and a dbtest's `emit` runs
// outside any request, where the kick does nothing.
{
  const vapid = createECDH("prime256v1");
  vapid.generateKeys();
  const scalar = vapid.getPrivateKey();
  process.env["WEB_PUSH_VAPID_PUBLIC_KEY"] = vapid.getPublicKey().toString("base64url");
  process.env["WEB_PUSH_VAPID_PRIVATE_KEY"] = Buffer.concat([Buffer.alloc(32 - scalar.length), scalar]).toString("base64url");
  process.env["WEB_PUSH_SUBJECT"] = "mailto:dbtest@fortleva.invalid";
  process.env["PUSH_TRANSPORT"] = "dev";
}

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
