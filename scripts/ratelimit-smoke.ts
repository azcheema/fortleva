// THE RATE LIMITER AGAINST A REAL UPSTASH DATABASE — the one check of
// `src/ratelimit`'s Upstash leg that no suite makes, because every suite
// runs on the no-op limiter on purpose (CI has no Upstash; the local
// harnesses strip it — `vitest.db.config.ts`, `playwright.config.ts`).
//
//   pnpm exec tsx scripts/ratelimit-smoke.ts
//
// Reads UPSTASH_REDIS_REST_URL / _TOKEN from `.env.local`, exactly as the
// dev server does, and against that database:
//   1. spends `auth.sign_in_address` (its limit per 15 min) for a RANDOM
//      subject that belongs to nobody — once past the limit, and expects
//      exactly the last attempt refused;
//   2. lists that bucket's keys and expects one that carries the subject's
//      digest and none that carries the subject itself (SECURITY.md §4,
//      §9.2 — the database holds HMACs, never an address);
//   3. deletes the keys it made, so it leaves nothing behind.
// It prints counts and verdicts, never the database's URL, its token or a
// key. The windows are fixed quarter-hours that the sliding window weighs
// across, so a run whose attempts straddle a boundary (:00, :15, :30, :45)
// can let an attempt more through than the limit — re-run it before
// believing a FAIL on step 1. Exit 0 = all three held; 1 = one did not; 2 = Upstash not configured.

import { randomUUID } from "node:crypto";

import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

async function main(): Promise<number> {
  const { upstashConfig } = await import("../src/config");
  if (!upstashConfig) {
    console.error("UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set — nothing to smoke.");
    return 2;
  }
  const { Redis } = await import("@upstash/redis");
  const { getLimiter, RATE_LIMIT_POLICIES, subjectDigest } = await import("../src/ratelimit");

  const limiter = getLimiter();
  if (limiter.name !== "upstash") {
    console.error(`expected the Upstash limiter, got "${limiter.name}"`);
    return 1;
  }

  const bucket = "auth.sign_in_address" as const;
  const { limit } = RATE_LIMIT_POLICIES[bucket];
  // Shaped like a real subject (`<credential store>:<address>`,
  // `src/auth/rate-limit-hook.ts`) so the digest is computed over what
  // production computes it over; `.invalid` and a fresh uuid, so it is
  // nobody's and no two runs share a budget.
  const subject = `contact:smoke-${randomUUID()}@ratelimit.invalid`;
  const redis = new Redis({ url: upstashConfig.url, token: upstashConfig.token });
  const prefix = `flv:rl:${bucket}:`;
  const digest = subjectDigest(subject);

  let failed = false;
  const check = (ok: boolean, what: string): void => {
    console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
    if (!ok) failed = true;
  };

  try {
    const answers: boolean[] = [];
    for (let i = 0; i <= limit; i++) answers.push((await limiter.limit(bucket, subject)).ok);
    check(
      answers.slice(0, limit).every(Boolean) && answers[limit] === false,
      `${limit} allowed, then refused (${answers.map((a) => (a ? "allow" : "refuse")).join(", ")})`,
    );

    const keys = await scanAll(redis, `${prefix}*`);
    const ours = keys.filter((k) => k.includes(digest));
    check(ours.length > 0, `the bucket holds ${ours.length} key(s) carrying the subject's digest`);
    const local = subject.slice(subject.indexOf(":") + 1, subject.indexOf("@"));
    check(
      !keys.some((k) => k.includes(subject) || k.includes(local)),
      `none of the bucket's ${keys.length} key(s) carries the subject or any part of it`,
    );
  } finally {
    const mine = (await scanAll(redis, `${prefix}*`)).filter((k) => k.includes(digest));
    if (mine.length > 0) await redis.del(...mine);
    console.log(`cleaned up ${mine.length} key(s)`);
  }
  return failed ? 1 : 0;
}

/** Every key matching `pattern`, through SCAN — never KEYS, which blocks the server. */
async function scanAll(redis: import("@upstash/redis").Redis, pattern: string): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | number = 0;
  do {
    const [next, batch]: [string | number, string[]] = await redis.scan(cursor, { match: pattern, count: 500 });
    out.push(...batch);
    cursor = next;
  } while (String(cursor) !== "0");
  return out;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    // The message only, with any URL or Upstash host masked: an error can
    // carry the request it failed on, and the host is not ours to print.
    const message = error instanceof Error ? error.message : "unknown error";
    const masked = message.replace(/https?:\/\/\S+/g, "<url>").replace(/[\w.-]+\.upstash\.io/g, "<host>");
    console.error(`smoke failed: ${masked.slice(0, 200)}`);
    process.exit(1);
  },
);
