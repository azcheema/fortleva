import { timingSafeEqual } from "node:crypto";

/**
 * WHO MAY KICK THE JOBS (slice 122, founder decision C98 — going live).
 *
 * Two callers, two gates, one compare:
 *   · Vercel's scheduler (`vercel.json` crons) calls with GET and
 *     `Authorization: Bearer <CRON_SECRET>` — Vercel sends the project's
 *     `CRON_SECRET` itself. A GET with no configured secret is NOT a
 *     request anyone may make, in any environment: the scheduler is the
 *     only GET caller, so there is no "local convenience" for it.
 *   · A person or script calls with POST and `x-jobs-token: <JOBS_RUN_TOKEN>`
 *     (the manual kick, unchanged since ARC-21's dev fallback).
 * Constant-time on equal lengths; a missing header never matches.
 */
export const secretMatches = (given: string | null, expected: string): boolean => {
  if (given === null) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Vercel Cron's header against a secret; false whenever the secret is unset
 * or blank. The secret is TRIMMED before the compare, as a header value is: a
 * value saved with a stray space would otherwise never match, and every cron
 * would 404 in silence (the review's nit).
 */
export const cronAuthorized = (authorization: string | null, secret: string | undefined): boolean => {
  const s = typeof secret === "string" ? secret.trim() : "";
  return s !== "" && secretMatches(authorization, `Bearer ${s}`);
};

/** The one place `CRON_SECRET` is read (RUNBOOK §1): is this request Vercel Cron's? */
export const isCronRequest = (request: Request): boolean =>
  cronAuthorized(request.headers.get("authorization"), process.env["CRON_SECRET"]);
