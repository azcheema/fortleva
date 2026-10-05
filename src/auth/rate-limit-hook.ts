import { APIError } from "better-auth/api";

import { type Plane } from "@/config";
import { allow, clientIp, clientNetwork, type RateLimitBucket } from "@/ratelimit";

import { hasReplaceIntent } from "./replace-intent";

/**
 * The per-IP limiter on Better Auth's credential endpoints (SECURITY.md
 * §3.7), shared by ALL THREE auth instances (member, platform, portal —
 * the portal joined 2026-09-20).
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
 * basePath, so the same map serves `/api/auth/*`,
 * `/api/platform-auth/*` and `/api/portal-auth/*` without knowing which
 * is which.
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
  // The unauthenticated credential endpoints, added 2026-09-20 with the
  // portal plane and covering all three. Every one of these is reachable
  // with nothing but an email address, writes a `verification` row, and
  // asks the product to send mail to whoever was named.
  //
  // THE NAMES ARE THE ONES BETTER AUTH 1.6.26 ACTUALLY MOUNTS. An
  // earlier note in PLAN §0 said "/forget-password" was missing from
  // this map; there is no such endpoint in this version (the review
  // caught it), and a key that matches nothing is worse than an absent
  // one — it reads as coverage. `password.mjs` defines
  // /request-password-reset and /reset-password; /send-verification-email
  // is in email-verification.mjs.
  //
  // The platform instance refuses all three outright, BEFORE this limiter
  // (./closed-endpoints, slice 58); the member instance refuses the third
  // and, since C30, serves the first two again — with its own per-RECIPIENT
  // cap behind them (./mail-budget), which this per-IP bucket does not
  // replace. They stay listed for every plane because a limiter keyed on
  // "which instance still serves it" is one more thing to remember the day
  // a plane re-opens one — which is exactly what C30 was.
  "/request-password-reset": "auth.credential_request",
  "/reset-password": "auth.credential_request",
  "/send-verification-email": "auth.credential_request",
  // THE SIX PASSWORD CHECKS THAT NEED A SESSION, added 2026-10-01 (slice
  // 81's reviews — the security review named the first two, the fix-pass
  // review the four two-factor ones; Better Auth 1.6.26 has no other
  // mounted endpoint that checks the account password, `/delete-user` being
  // off here and refusing before it looks). Each answers "was that the
  // password?", so with a stolen session any of them is a grinder for the
  // one thing a session does not give — a way back in after the session is
  // revoked. `/verify-password` is declared `scope: "server"`, which only
  // shapes the typed client — better-call's router refuses nothing but
  // `SERVER_ONLY` — so it answers over HTTP. Its callers in this
  // product are the factor replacement (`./factor-replace`, slice 84), which
  // asks it first, before anything can be spent, and — on the portal — the
  // client's door to their logins (`./portal-password`, slice 91), where it
  // is server-only: the portal refuses it over HTTP (`./closed-endpoints`). The two-factor four exist on the member and console
  // instances only (the portal registers no `twoFactor`). They spend the
  // sign-in budget per IP because they are sign-in's question. Per USER
  // they are still unbounded (the session is resolved after this hook) —
  // recorded in PLAN's slice-81 entry — though since slice 83 the factor
  // guard refuses three of them, and `enable` on an enrolled account
  // outside the replacement's marker, before the password is ever checked
  // (./factor-guard).
  "/change-password": "auth.sign_in",
  "/verify-password": "auth.sign_in",
  "/two-factor/enable": "auth.sign_in",
  "/two-factor/disable": "auth.sign_in",
  "/two-factor/get-totp-uri": "auth.sign_in",
  "/two-factor/generate-backup-codes": "auth.sign_in",
};

/**
 * The endpoints limited per CREDENTIAL as well as per IP (Phase 3's
 * "per-email limits on login"; SECURITY.md §4). Only password sign-in:
 * it is the one endpoint where the body names the account a guess is
 * aimed at. The reset and confirmation requests already carry a cap per
 * RECIPIENT counted in Postgres (`src/auth/portal.ts`,
 * `src/auth/mail-budget.ts`), which holds without Upstash and is the
 * stronger of the two keys for mail; a second, fail-open one here would
 * add nothing.
 */
export const ADDRESS_LIMITED_PATHS: ReadonlySet<string> = new Set(["/sign-in/email"]);

/**
 * The address a sign-in names, as the per-credential subject — or null when
 * the body names none, which the library's own schema then refuses.
 *
 * Lower-cased because Better Auth looks the account up by
 * `email.toLowerCase()`: two spellings that reach one account must spend
 * one budget, or a guesser alternates `Kane@` and `kane@` for twice the
 * guesses. Trimmed as well, which can only merge spellings, never split
 * them — so if a later version of the library trims too, this is already
 * right. Bounded, because the subject is the caller's string; past 320
 * characters (RFC 5321's longest address) nothing is an address anyway.
 */
export function signInAddress(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const email = (body as { email?: unknown }).email;
  if (typeof email !== "string") return null;
  const address = email.trim().toLowerCase().slice(0, 320);
  return address === "" ? null : address;
}

/**
 * WHICH TABLE OF PASSWORDS a plane checks — the key's namespace for the
 * per-credential buckets, which is deliberately NOT the plane.
 *
 * The member and console instances read the SAME `user` and `account`
 * rows (`./platform`: one credential opens both `/login` and `/ops/login`,
 * and the console's sign-in answers right-or-wrong for any member's
 * password before `requirePlatformAdmin` refuses the session). Keyed per
 * plane, one password had two budgets — ten guesses a quarter of an hour
 * by alternating the two, a superadmin's included. Keyed per store, it has
 * one, and the price is stated: guessing at `/login` spends the budget of
 * `/ops/login` for the same person, because it is the same password. The
 * portal's contacts are another table (decision #6), so an address that is
 * both a member and a contact is two credentials with two budgets, and
 * guessing at the portal locks nobody out of the agency's app.
 */
export const credentialStore = (plane: Plane): "user" | "contact" => (plane === "portal" ? "contact" : "user");

/**
 * Fails OPEN when Upstash is unconfigured — `allow()` returns true
 * through the no-op limiter (src/ratelimit). That is a deliberate,
 * documented weakness rather than an oversight: Better Auth's own
 * built-in limiter still applies underneath, and a fail-CLOSED limiter
 * here would make an unreachable Redis an outage of the login surface
 * for every plane at once. The fail-closed budgets in this product are
 * the Postgres counters (3V), never this module.
 *
 * THREE QUESTIONS, IN THIS ORDER, and each refusal spends nothing of the
 * questions after it: the IP (the endpoint's own bucket — sign-in's is
 * 10 / 10 min); then, for a password sign-in, the credential FROM this
 * source (5 / 15 min); then the credential from anywhere (20 / 15 min). The
 * middle one is what puts a price on a lockout: one source can put at most
 * five into the credential's twenty, so keeping an account shut takes four
 * sources guessing inside one window — four IPv4 addresses or four IPv6
 * /48s (`clientNetwork`; the per-IP question counts the narrower /64,
 * `clientIp`, because every account on the plane shares it). A cost floor,
 * not a count of people: one well-provisioned host can hold several
 * sources. And a source is SHARED — everyone in the owner's /48, or behind
 * their carrier's IPv4 NAT, spends the same per-source budget — so a
 * neighbour there can shut the owner out FROM THAT NETWORK; elsewhere the
 * owner is unaffected. "Spends nothing" is about the questions AFTER a
 * refusal: an owner who retries while their account is shut still spends
 * the per-IP budget and their source's budget each time, so the advice is
 * to wait, then try once.
 */
export async function enforceAuthRateLimit(
  ctx: { readonly path: string; readonly headers?: Headers | undefined; readonly body?: unknown },
  plane: Plane,
): Promise<void> {
  const bucket = RATE_LIMITED_PATHS[ctx.path];
  if (!bucket) return;
  // THE REPLACEMENT'S OWN `enable` (slice 84, both reviews' medium) is not
  // a password guess: `./factor-replace` asked `/verify-password` first,
  // which spent this same per-IP budget, and then the step-up CONSUMED the
  // member's backup code. Charging `enable` again could refuse it AFTER the
  // code was gone — behind an office NAT, one token short — leaving the
  // member a code down with nothing replaced. A request cannot set the
  // marker (./replace-intent), so this exempts nothing an attacker can send.
  if (ctx.path === "/two-factor/enable" && hasReplaceIntent()) return;
  // The subject is namespaced BY PLANE, which matters now that one
  // limiter serves all three instances: without it, ordinary app sign-ins
  // from a shared egress IP (an office NAT, a mobile carrier) would eat
  // the console's 10-per-10-minutes budget and lock the operator out of
  // the ops console — a lockout vector invented by sharing the limiter,
  // on a plane that previously had none.
  const headers = ctx.headers ?? new Headers();
  if (!(await allow(bucket, `${plane}:${clientIp(headers)}`))) throw tooManyAttempts();

  const address = ADDRESS_LIMITED_PATHS.has(ctx.path) ? signInAddress(ctx.body) : null;
  if (address === null) return;
  const store = credentialStore(plane);
  // The SOURCE here is the caller's network — an IPv6 /48, not the /64 the
  // per-IP question counts — because this budget is per account and one
  // person can hold thousands of /64s (`clientNetwork`). A JSON array, not a
  // joined string: an IPv6 prefix has colons and the caller writes the
  // address, so `a:b` + `c` and `a` + `b:c` must not meet.
  const source = clientNetwork(headers);
  if (!(await allow("auth.sign_in_address_ip", JSON.stringify([store, address, source])))) throw tooManyAttempts();
  if (!(await allow("auth.sign_in_address", `${store}:${address}`))) throw tooManyAttempts();
}

/**
 * ONE refusal for every key: the message does not say which budget ran
 * out. What a 429 can still be made to say is stated rather than denied:
 * from a fresh source, a refusal on or before the caller's own fifth try means
 * somebody else has tried that address recently — the owner's own
 * sign-ins count. That is activity, not existence — an address that
 * belongs to nobody fills its buckets exactly as a real one does, so it
 * enumerates no accounts; and learning it costs the prober guesses that
 * help lock the owner out.
 */
const tooManyAttempts = (): APIError =>
  new APIError("TOO_MANY_REQUESTS", { message: "Too many attempts. Try again later." });
