import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

import { isProduction, trustedProxyHops, upstashConfig } from "@/config";
import { clientIpFrom } from "@/lib/client-ip";

/**
 * Rate limiting behind ONE config module (PLAN.md Phase 1b, SECURITY.md
 * §3.7). Upstash Redis (EU) when UPSTASH_REDIS_REST_URL/TOKEN are set;
 * otherwise a fail-OPEN no-op that logs once — the auth routes keep
 * Better Auth's built-in limiter, and the vault reveal budget (3V) uses
 * a fail-CLOSED Postgres counter, never this module.
 *
 * `allowStrict()` is the exception and the reason is written on it: on a
 * path where this bucket is the ONLY control — an unauthenticated Next
 * route with no endpoint limiter under it and no row to count — a no-op
 * is no control, so that call also takes an in-process sliding-window
 * floor which holds with or without Upstash.
 *
 * Buckets are named, fixed policies — call sites never invent numbers.
 * Keys are `<bucket>:<subject>` where the subject is an IP or a user id;
 * neither is logged here.
 */

export type RateLimitBucket = keyof typeof POLICIES;

/** requests / window per subject (sliding window). */
const POLICIES = {
  /** Password sign-in attempts per IP. */
  "auth.sign_in": { limit: 10, window: "10 m" },
  /** Sign-up attempts per IP. */
  "auth.sign_up": { limit: 5, window: "1 h" },
  /** Invite-acceptance attempts per IP (token guessing). */
  "auth.invite_accept": { limit: 10, window: "10 m" },
  /** Step-up code attempts per session/user (SECURITY.md §3.5). */
  "auth.step_up": { limit: 6, window: "10 m" },
  /**
   * Password-reset and email-verification REQUESTS per IP. Each one is
   * an unauthenticated call that writes a verification row and asks the
   * product to send mail to an address the caller named, so it is both
   * a write amplifier and — once SES is live — a way to have the
   * product's own domain deliver a "reset your password" message to
   * anyone an attacker guesses is a user. Added 2026-09-20 with the
   * portal plane, which has by far the most exposed instance of it.
   */
  "auth.credential_request": { limit: 5, window: "15 m" },
  /** Presign requests per user (upload floods). */
  "files.presign": { limit: 120, window: "1 m" },
  /**
   * Portal request submissions per CONTACT (Phase 3 slice 6a). A CHEAP
   * FILTER IN FRONT OF A FAIL-CLOSED ONE, which is the only shape this
   * module may take on a path that must actually hold: the authority is
   * a Postgres count inside the writer's own transaction
   * (`src/modules/work/requests.ts`), and this exists so that a contact
   * who has spent that budget cannot go on paying for a transaction and
   * an advisory lock per attempt. It is a NO-OP until Upstash is
   * provisioned, which is the documented state (PLAN §0) — and that is
   * acceptable here precisely because it is not the control.
   *
   * Keyed on the contact id rather than an IP: the submitter is
   * authenticated, and an office NAT would otherwise let one client's
   * staff spend another's budget. Its limit is above the Postgres one,
   * so the honest refusal is normally the one that fires.
   */
  "portal.request_create": { limit: 20, window: "15 m" },
  /**
   * The portal's task TICK per CONTACT (Phase 3 slice 6c) — "I've done
   * my part" and its retraction.
   *
   * UNLIKE THE BUCKET ABOVE, THIS ONE IS THE ONLY LIMIT ON ITS PATH,
   * and that is a weaker position stated rather than hidden: a toggle
   * creates no row and mints no counter, so there is no Postgres budget
   * to be the authority, and with Upstash unprovisioned (PLAN §0) this
   * is a no-op today. What it protects is not the database — the write
   * is one indexed UPDATE — but the AUDIT TRAIL and the agency's inbox:
   * every flip writes an `AuditEvent`, and every tick can wake a
   * notification once the previous one has been read.
   *
   * Generous on purpose. A client legitimately ticking several tasks in
   * one sitting, changing their mind about one, is the ordinary use;
   * this is sized to catch a script, not a person. Keyed on the contact
   * id for the same reason as the request bucket — the actor is
   * authenticated, and an office NAT must not let one client's staff
   * spend another's budget.
   */
  "portal.task_act": { limit: 60, window: "15 m" },
  /**
   * THE PORTAL INVITATION ACCEPTANCE PAGE (Phase 3, the invite slice's
   * surfaces) — `/portal/invite/[token]`, the ONLY surface in this
   * product that takes a write from somebody with no session.
   *
   * **IT IS SPENT THROUGH `allowStrict`, NOT `allow`, AND THAT IS THE
   * WHOLE POINT OF THIS ENTRY.** Every other bucket here is either a
   * cheap filter in front of a fail-closed Postgres counter
   * (`portal.request_create`), or sits under Better Auth's own built-in
   * limiter (`auth.*`). This one has neither: a Next route is not a
   * Better Auth endpoint, and there is no row to count for a visitor who
   * has presented nothing but a token. With the no-op limiter it would
   * be the only control on its path and no control at all — the exact
   * situation this module's header says is not acceptable. So the
   * accept page also takes the in-process floor below.
   *
   * WHAT IT BOUNDS is `previewContactInvite`, which writes a
   * `platform.system_job` audit row on every single call (`withPlatform`
   * audits its own reads): `audit_event` is append-only with no pruning
   * job before Phase 8, so an unmetered loop over random tokens grows
   * that table without limit. Guessing the token itself is not the
   * threat — it is 32 random bytes — the table is.
   *
   * SIZED FOR AN OFFICE, NOT FOR ONE PERSON. The founder's rule is "a
   * handful of attempts per visitor per hour", and per VISITOR is not
   * what an IP measures: an agency that invites six people at one client
   * may see all six accept within the hour from a single NAT, and a
   * budget of ten would lock the last of them out of their own
   * invitation. Twenty is still a handful each and leaves room for a
   * whole office.
   */
  "portal.invite_accept": { limit: 20, window: "1 h" },
  /**
   * THE SAME PAGE'S READ, metered separately — and the split is about
   * what each half can actually do wrong.
   *
   * The POST above is a WRITE: it sets a password, and twenty an hour is
   * the founder's "handful". This one only resolves a token for display,
   * and the single thing it must bound is the `platform.system_job` row
   * `previewContactInvite` appends on every call. For that harm the
   * distinction that matters is bounded versus unbounded, not twenty
   * versus sixty — a 32-byte token is not being guessed at either rate.
   *
   * **AND ONE BUCKET FOR BOTH WOULD HAVE BUILT A FLAKE**, which is the
   * concrete reason this exists. The floor is per PROCESS and keyed on
   * the address, and behind `next start` nothing sets `x-forwarded-for`,
   * so every request in a Playwright run shares the subject `unknown`.
   * The visual and Swedish-width walks each visit this page once per
   * theme per device; `playwright.config.ts` sets
   * `reuseExistingServer: !CI`, so locally a second run lands on the
   * same process with the first run's spending still in window. On one
   * bucket of twenty, a suite that passed would start failing on its
   * third local re-run, in a spec nobody had touched — exactly the shape
   * of flake AGENTS.md's standing traps are made of. Sixty reads an hour
   * costs the table nothing and keeps the walks honest.
   */
  "portal.invite_preview": { limit: 60, window: "1 h" },
} as const satisfies Record<string, { limit: number; window: `${number} ${"s" | "m" | "h"}` }>;

export type RateLimitResult = {
  readonly ok: boolean;
  /** Remaining requests in the window (Infinity for the no-op limiter). */
  readonly remaining: number;
  /** Epoch ms when the window resets (0 for the no-op limiter). */
  readonly reset: number;
};

export interface Limiter {
  readonly name: "upstash" | "noop";
  limit(bucket: RateLimitBucket, subject: string): Promise<RateLimitResult>;
}

const noopLimiter: Limiter = {
  name: "noop",
  async limit() {
    return { ok: true, remaining: Number.POSITIVE_INFINITY, reset: 0 };
  },
};

class UpstashLimiter implements Limiter {
  readonly name = "upstash" as const;
  private readonly limiters = new Map<RateLimitBucket, Ratelimit>();
  constructor(private readonly redis: Redis) {}

  private for(bucket: RateLimitBucket): Ratelimit {
    let l = this.limiters.get(bucket);
    if (!l) {
      const p = POLICIES[bucket];
      l = new Ratelimit({
        redis: this.redis,
        limiter: Ratelimit.slidingWindow(p.limit, p.window),
        prefix: `flv:rl:${bucket}`,
        analytics: false,
      });
      this.limiters.set(bucket, l);
    }
    return l;
  }

  async limit(bucket: RateLimitBucket, subject: string): Promise<RateLimitResult> {
    try {
      const r = await this.for(bucket).limit(subject);
      return { ok: r.success, remaining: r.remaining, reset: r.reset };
    } catch (e) {
      // Redis unreachable: fail open, loudly. Availability of sign-in
      // beats a stricter limit; the vault budget is fail-closed elsewhere.
      console.error("[ratelimit] upstash error — failing open", e);
      return { ok: true, remaining: 0, reset: 0 };
    }
  }
}

let instance: Limiter | null = null;

/** The one limiter; logged once so a deploy without Upstash is loud, not silent. */
export function getLimiter(): Limiter {
  if (instance) return instance;
  if (upstashConfig) {
    instance = new UpstashLimiter(new Redis({ url: upstashConfig.url, token: upstashConfig.token }));
    console.log("[ratelimit] upstash sliding-window limiter");
  } else {
    instance = noopLimiter;
    console[isProduction ? "warn" : "log"](
      "[ratelimit] no-op limiter (UPSTASH_REDIS_REST_URL/TOKEN unset) — fail-open",
    );
  }
  return instance;
}

/** Test seam. */
export function setLimiter(limiter: Limiter | null): void {
  instance = limiter;
}

/** Convenience: true when the request may proceed. */
export async function allow(bucket: RateLimitBucket, subject: string): Promise<boolean> {
  return (await getLimiter().limit(bucket, subject)).ok;
}

/**
 * THE IN-PROCESS FLOOR — a sliding window in this Node process's memory,
 * enforced whether or not Upstash exists.
 *
 * **WHY IT EXISTS, and why it is a second function rather than a new
 * default.** `allow()` is fail-OPEN by design: without `UPSTASH_*` it is
 * a no-op, and the header above gives the reason — an unreachable Redis
 * must not become an outage of every sign-in surface at once. That
 * trade is right for the `auth.*` buckets because Better Auth's own
 * limiter still sits underneath them, and right for
 * `portal.request_create` because a fail-closed Postgres counter is the
 * real authority behind it. It is NOT right where the bucket is the only
 * control on the path, and the portal invitation acceptance page is
 * exactly that: an unauthenticated route, with no endpoint limiter under
 * it and no row to count. A settled decision that the page "stops
 * answering after a handful of attempts" cannot be delivered by a
 * function that always returns true.
 *
 * Making `allow()` itself fall back to this was the other option and was
 * rejected: it would silently arm a limit on `auth.sign_in`,
 * `auth.sign_up` and the credential endpoints for every caller in the
 * product — including the dbtests, which drive `signInEmail` a dozen
 * times per file from one `"unknown"` address — and a UI slice is the
 * wrong place to change what three planes' sign-in surfaces do. This
 * floor is opt-in per call site, so its blast radius is the call sites
 * that ask for it.
 *
 * **WHAT IT IS NOT.** It is per-process, so it resets on deploy and does
 * not span instances; two app processes each allow the full budget. That
 * is a stated weakness rather than a hidden one — and it is strictly
 * stronger than the no-op it replaces on this path. Upstash, when it is
 * provisioned, becomes the cross-instance authority and this stays as
 * the floor underneath it.
 *
 * **BOUNDED IN BOTH DIRECTIONS.** The number of subjects is capped so an
 * attacker rotating addresses cannot grow the map without limit, and the
 * SUBJECT ITSELF is bounded by `clientIpFrom`, which truncates — a cap
 * on the count is worth nothing if one entry may be a megabyte, and on
 * this path the caller supplies the string. Eviction is least-recently-
 * seen: every call re-inserts its key, refused calls included, so the
 * entries eviction sheds are the ones nobody is using.
 */
/** Exported so the test can exceed it instead of asserting nothing. */
export const LOCAL_SUBJECT_CAP = 20_000;

/** key → the timestamps (ms, ascending) of the ALLOWED hits still in window. */
const localHits = new Map<string, number[]>();

const WINDOW_UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000 } as const;

const windowMs = (window: `${number} ${"s" | "m" | "h"}`): number => {
  const [count, unit] = window.split(" ") as [string, keyof typeof WINDOW_UNIT_MS];
  return Number(count) * WINDOW_UNIT_MS[unit];
};

/** Drop expired subjects, then oldest-seen ones until the map is under its cap. */
function evictLocal(now: number): void {
  const widest = Math.max(...Object.values(POLICIES).map((p) => windowMs(p.window)));
  for (const [key, hits] of localHits) {
    const last = hits[hits.length - 1];
    if (last === undefined || last <= now - widest) localHits.delete(key);
  }
  // Map iterates in insertion order and `allowLocal` re-inserts on every
  // call, so this sheds the least recently SEEN entries. An allowed hit
  // and a refused one both move their key to the back, which is what
  // stops a rotating caller from evicting a subject whose budget is spent.
  for (const key of localHits.keys()) {
    if (localHits.size <= LOCAL_SUBJECT_CAP) break;
    localHits.delete(key);
  }
}

/**
 * True when the request may proceed against the in-process floor. A
 * REFUSED attempt is not recorded, so the window drains on its own and a
 * visitor who waits is never punished twice for the same attempt.
 */
export function allowLocal(bucket: RateLimitBucket, subject: string): boolean {
  const policy = POLICIES[bucket];
  const now = Date.now();
  const key = `${bucket}:${subject}`;
  const span = windowMs(policy.window);
  const hits = (localHits.get(key) ?? []).filter((at) => at > now - span);
  const refused = hits.length >= policy.limit;
  if (!refused) hits.push(now);
  // **DELETE THEN SET, ON BOTH PATHS, and the refused path is the one
  // that matters.** `Map.set` on a key that already exists updates the
  // value and leaves the insertion order alone, so a subject that is
  // currently being REFUSED kept its original position — which made it
  // the FIRST thing `evictLocal` sheds, forgiving exactly the caller
  // whose budget is spent. Re-inserting makes the eviction order mean
  // "least recently seen", which is what the comment on the cap claims
  // and what an eviction policy has to mean to be safe.
  localHits.delete(key);
  localHits.set(key, hits);
  if (refused) return false;
  if (localHits.size > LOCAL_SUBJECT_CAP) evictLocal(now);
  return true;
}

/**
 * The limit for a path where the limit is the ONLY control: the
 * in-process floor AND Upstash, both. The floor is checked first because
 * it is synchronous and cannot fail.
 */
export async function allowStrict(bucket: RateLimitBucket, subject: string): Promise<boolean> {
  if (!allowLocal(bucket, subject)) return false;
  return allow(bucket, subject);
}

/** Test seam for the in-process floor (mirrors `setLimiter`). */
export function resetLocalLimiter(): void {
  localHits.clear();
}

/**
 * Who is asking, for a rate-limit subject.
 *
 * **IT COUNTS FROM THE RIGHT OF `x-forwarded-for` AND IGNORES
 * `x-real-ip`**, and `src/lib/client-ip.ts` holds the whole reason. The
 * short version: this used to read `x-real-ip` first and the LEFTMOST
 * forwarded hop second, both of which a client writes — so on the
 * deployment RUNBOOK documents, `curl -H 'X-Real-Ip: <random>'` in a
 * loop was a fresh subject with a fresh budget on every request, and the
 * floor below never refused anything. That was survivable while every
 * bucket here was a no-op or had a fail-closed Postgres counter behind
 * it, and stopped being survivable the moment `allowStrict` became the
 * only control on an unauthenticated route. Found by a fresh security
 * review of the slice that introduced it.
 */
export const clientIp = (headers: Headers): string =>
  clientIpFrom((name) => headers.get(name), trustedProxyHops);

export const RATE_LIMIT_POLICIES: Readonly<typeof POLICIES> = POLICIES;
