import { APIError } from "better-auth/api";

import { type Plane } from "@/config";
import { allow, clientIp, type RateLimitBucket } from "@/ratelimit";

/**
 * The per-IP limiter on Better Auth's credential endpoints (SECURITY.md
 * §3.7), shared by BOTH auth instances.
 *
 * It lives here rather than inline in src/auth/index.ts because the
 * platform instance had no limiter at all until 2026-09-09: the ops
 * console — the plane that reaches `app_platform`, a BYPASSRLS
 * cross-tenant role — was the least protected of the three sign-in
 * surfaces while SECURITY.md's policy table presented it as the most.
 * One mechanism, used twice, is the only shape that cannot drift back
 * apart; a second copy of this middleware would.
 *
 * Paths are the Better Auth endpoint paths WITHIN an instance's
 * basePath, so the same map serves `/api/auth/*` and
 * `/api/platform-auth/*` without knowing which is which.
 */
export const RATE_LIMITED_PATHS: Readonly<Record<string, RateLimitBucket>> = {
  "/sign-in/email": "auth.sign_in",
  "/sign-up/email": "auth.sign_up",
  // The second-factor endpoints are credential endpoints too: without
  // these, an attacker holding a password could grind six digits at
  // whatever rate the runtime allows. `auth.step_up` is the tighter
  // bucket (6 / 10 min) precisely because the search space is small.
  "/two-factor/verify-totp": "auth.step_up",
  "/two-factor/verify-backup-code": "auth.step_up",
};

/**
 * Fails OPEN when Upstash is unconfigured — `allow()` returns true
 * through the no-op limiter (src/ratelimit). That is a deliberate,
 * documented weakness rather than an oversight: Better Auth's own
 * built-in limiter still applies underneath, and a fail-CLOSED limiter
 * here would make an unreachable Redis an outage of the login surface
 * for every plane at once. The fail-closed budgets in this product are
 * the Postgres counters (3V), never this module.
 */
export async function enforceAuthRateLimit(
  ctx: { readonly path: string; readonly headers?: Headers | undefined },
  plane: Plane,
): Promise<void> {
  const bucket = RATE_LIMITED_PATHS[ctx.path];
  if (!bucket) return;
  // The subject is namespaced BY PLANE, which matters now that one
  // limiter serves both instances: without it, ordinary app sign-ins
  // from a shared egress IP (an office NAT, a mobile carrier) would eat
  // the console's 10-per-10-minutes budget and lock the operator out of
  // the ops console — a lockout vector invented by sharing the limiter,
  // on a plane that previously had none.
  const subject = `${plane}:${clientIp(ctx.headers ?? new Headers())}`;
  if (!(await allow(bucket, subject))) {
    throw new APIError("TOO_MANY_REQUESTS", { message: "Too many attempts. Try again later." });
  }
}
