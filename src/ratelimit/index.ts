import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

import { isProduction, upstashConfig } from "@/config";

/**
 * Rate limiting behind ONE config module (PLAN.md Phase 1b, SECURITY.md
 * §3.7). Upstash Redis (EU) when UPSTASH_REDIS_REST_URL/TOKEN are set;
 * otherwise a fail-OPEN no-op that logs once — the auth routes keep
 * Better Auth's built-in limiter, and the vault reveal budget (3V) uses
 * a fail-CLOSED Postgres counter, never this module.
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
  /** Presign requests per user (upload floods). */
  "files.presign": { limit: 120, window: "1 m" },
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

/** Client IP from proxy headers (Vercel sets x-forwarded-for); "unknown" otherwise. */
export const clientIp = (headers: Headers): string =>
  headers.get("x-real-ip") ??
  headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
  "unknown";

export const RATE_LIMIT_POLICIES: Readonly<typeof POLICIES> = POLICIES;
