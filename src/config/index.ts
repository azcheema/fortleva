import { createHash } from "node:crypto";

import { z } from "zod";

/**
 * INV-D2 (ARCHITECTURE.md ARC-11): this module is the single owner of the
 * app host, cookie attributes, and mail sender identity. No other file may
 * hardcode a hostname, cookie name, or sender address — the Phase 7 domain
 * cutover must be an env edit plus DNS, nothing else.
 */

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  // Canonical origin of the app plane, e.g. https://os.naxdor.com — later the
  // real product domain. Absolute URLs are built from this and only this.
  APP_URL: z.url().default("http://localhost:3000"),
  // Origin of the platform-ops console (ops.naxdor.com for v1). Falls back to
  // APP_URL in dev where both planes run in one process.
  OPS_URL: z.url().optional(),
  // Sender identity: "Fortleva <no-reply@mailer.naxdor.com>" shape, split so
  // templates and the mail adapter never compose addresses themselves.
  MAIL_FROM_NAME: z.string().default("Fortleva"),
  MAIL_FROM_ADDRESS: z.email().default("dev@localhost.invalid"),
  /**
   * PERMIT THE DEV MAIL TRANSPORT IN A PRODUCTION BUILD — set by, and
   * only by, the Playwright harness's `webServer.env`.
   *
   * `next start` sets `NODE_ENV=production`, so `isProduction` is true
   * for the e2e server, and `src/mailer` refuses to send through the dev
   * transport there (rightly: an unwired SES must be an error and not a
   * silent drop). That refusal makes every mail-sending FLOW untestable
   * end to end — `inviteContact` sends after its transaction commits, so
   * pressing Invite in the harness would 500 after writing the row, and
   * the token the acceptance page needs exists only in that mail. The
   * portal invitation is the product's first such flow; nothing before
   * it ever needed the outbox from a browser.
   *
   * It is a deliberate hole with a deliberately unmistakable name, and
   * it is opt-IN: absent, the guard behaves exactly as it always has.
   * `src/mailer` logs loudly whenever it is honoured so a real
   * deployment that ever set it could not do so quietly.
   */
  // PERMISSIVE ON PURPOSE. An earlier version of this was
  // `z.enum(["0","1"])`, which made `MAIL_DEV_OUTBOX=true` — the value
  // anybody would actually type — a `envSchema.parse` failure at module
  // load, i.e. the whole application refusing to boot with a message
  // about an enum. A footgun on a flag nobody sets is still a footgun.
  // Anything but the literal "1" is off (see `allowDevMailOutbox`).
  MAIL_DEV_OUTBOX: z.string().optional(),
  /**
   * HOW MANY PROXIES STAND IN FRONT OF THIS DEPLOYMENT — the only thing
   * that makes a client address trustworthy enough to rate-limit on.
   *
   * `src/lib/client-ip.ts` carries the reasoning and the arithmetic. The
   * default is 1 because that is the deployment RUNBOOK documents (one
   * TLS-terminating proxy forwarding `x-forwarded-for`) and the one
   * Vercel provides; 0 says "nothing in front of me", which makes every
   * request share one bucket rather than trust a header the caller
   * wrote. Raise it for a CDN in front of the proxy. **At 0 — or with a
   * chain shorter than declared — every caller is ONE subject `unknown`**,
   * and with Upstash configured that is an outage, not a weakness: the
   * per-IP sign-in bucket (10 / 10 min) becomes plane-wide, so ten requests
   * from anybody close sign-in — and the six session-gated password checks
   * — for EVERYONE on that plane, and five wrong guesses from anywhere shut
   * any one account (`src/auth/rate-limit-hook.ts`). The count of hops is
   * what makes per-caller limits per caller.
   */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(8).default(1),
  DATABASE_URL: z.string().optional(),
  DIRECT_URL: z.string().optional(),
  // File storage (SECURITY.md §5): Cloudflare R2, EU jurisdiction. All
  // four present ⇒ R2 transport; otherwise the local-disk dev transport.
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  // HMAC secret for the dev-only "presigned" local-storage URLs. Falls
  // back to BETTER_AUTH_SECRET, then a per-process random (dev only).
  DEV_STORAGE_SECRET: z.string().optional(),
  BETTER_AUTH_SECRET: z.string().optional(),
  // Rate limiting (SECURITY.md §3.7): Upstash Redis REST (EU region).
  // Both present => real limiter; otherwise a no-op that logs once.
  //
  // AN EMPTY VALUE IS "UNSET", and the e2e harness depends on it. `next
  // start` loads `.env.local` for every key the environment has not
  // already defined, and defined-but-empty counts as defined — so an
  // empty value is the only way a parent process can keep the founder's
  // dev Redis out of a server it starts (`playwright.config.ts`). Without
  // the preprocess, "" would fail `z.url()` and the app would not boot.
  UPSTASH_REDIS_REST_URL: z.preprocess((v) => (v === "" ? undefined : v), z.url().optional()),
  UPSTASH_REDIS_REST_TOKEN: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
});

const env = envSchema.parse(process.env);

export const isProduction = env.NODE_ENV === "production";

/** See TRUSTED_PROXY_HOPS above and `src/lib/client-ip.ts` for the rule. */
export const trustedProxyHops = env.TRUSTED_PROXY_HOPS;

/**
 * See MAIL_DEV_OUTBOX above. The e2e harness sets it; nothing else may.
 *
 * **TWO CONDITIONS, AND THE SECOND IS THE ONE THAT MATTERS** — the shape
 * `next.config.ts` already argues for at length about
 * `NEXT_SKIP_TYPECHECK`, and for exactly its reason: a lone env flag is
 * FORGEABLE. `next start` and `playwright.config.ts` both load
 * `.env.local` before anything reads this, and every hosting platform
 * has an env panel, so a flag alone could turn production mail into a
 * silent write to a file on disk. The security review raised it against
 * this repository's own documented precedent.
 *
 * So the escape hatch additionally requires the app to be serving itself
 * on a LOOPBACK address, which is a structural fact about the process
 * rather than a string somebody can set: a real deployment's `APP_URL`
 * is the origin its clients resolve, and a deployment whose origin is
 * 127.0.0.1 has no clients. The harness is the only thing in this
 * product that runs a production build on loopback
 * (`E2E_BASE_URL=http://127.0.0.1:<port>`), which is precisely the case
 * this exists for.
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
export const allowDevMailOutbox =
  env.MAIL_DEV_OUTBOX === "1" && LOOPBACK_HOSTS.has(new URL(env.APP_URL).hostname);

export const appUrl = new URL(env.APP_URL);
export const opsUrl = new URL(env.OPS_URL ?? env.APP_URL);

/**
 * TWO THINGS A PRODUCTION PROCESS WILL NOT RUN WITH — both found by slice
 * 81's fresh reviews, both cheaper to refuse here than to explain after a
 * deploy. A throw at module load fails CLOSED but is not a crash of
 * `next start`, which swallows module-load errors from its start-up
 * preload: `next build` stops, and a started server answers 500 to every
 * request that loads this module — which is every page and the proxy — and
 * logs this message each time. A health check on a static asset can still
 * pass; check a page.
 *
 * 1. **`BETTER_AUTH_SECRET`.** Better Auth refuses its own DEFAULT secret
 *    in production, but it also accepts `AUTH_SECRET` and
 *    `BETTER_AUTH_SECRETS` — and two secrets here derive from
 *    `BETTER_AUTH_SECRET` by name alone: `portalAuthSecret` and
 *    `rateLimitSubjectKey`. A deployment that set only one of the other two
 *    would boot happily with both derived from the empty string — a public
 *    constant — making portal-signed verification tokens forgeable (whose
 *    change-email branch mints a session) and the limiter's HMACs
 *    reversible. Nothing that runs as production lacks it today: the e2e
 *    and Neon-smoke workflows set a throwaway, and `next build` reads
 *    `.env.local` locally.
 * 2. **An EMPTY Upstash value off loopback.** Empty means unset so that the
 *    e2e harness can keep `.env.local`'s dev Redis out of the server it
 *    starts (`playwright.config.ts`). Before that, an empty URL failed
 *    `z.url()` and stopped the boot — and an empty value is what Docker
 *    Compose or a CI template writes for a variable somebody forgot. So the
 *    leniency takes the MAIL_DEV_OUTBOX test above: a production process
 *    serving itself on loopback is the harness; any other is a deployment
 *    whose rate limiter would silently be the no-op. An ABSENT value is
 *    still allowed, logged — the documented state of a deployment without
 *    Upstash (RUNBOOK).
 */
if (isProduction && !env.BETTER_AUTH_SECRET) {
  throw new Error(
    "BETTER_AUTH_SECRET must be set in production (src/config): the portal plane's secret and the rate limiter's key derive from it by name",
  );
}
const blankUpstash = ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"].filter((k) => process.env[k] === "");
if (isProduction && blankUpstash.length > 0 && !LOOPBACK_HOSTS.has(appUrl.hostname)) {
  throw new Error(
    `${blankUpstash.join(" and ")} set but EMPTY in production (src/config): unset it to run without the rate limiter, or give it a value`,
  );
}

/** The three session planes are separate identities by decision 6. */
export type Plane = "member" | "portal" | "platform";

/**
 * SECURITY.md §2.2: one session cookie per plane, `__Host-` prefixed.
 * The prefix is browser-enforced armor: it requires Secure + Path=/ and
 * REJECTS any Domain attribute, which is INV-D1's backstop.
 */
export const sessionCookieName = (plane: Plane): string =>
  `__Host-flv.${plane}`;

/**
 * INV-D1 (ARC-11): while the app lives under naxdor.com, a cookie with
 * Domain=.naxdor.com would broadcast sessions to every sibling Naxdor
 * property. This type structurally has no `domain` field; the CI test in
 * inv-d1.test.ts additionally scans the source tree for violations.
 */
export type CookieAttributes = {
  readonly path: "/";
  readonly secure: true;
  readonly httpOnly: true;
  readonly sameSite: "lax" | "strict";
};

export const sessionCookieAttributes = (
  plane: Plane,
): CookieAttributes => ({
  path: "/",
  secure: true,
  httpOnly: true,
  // Platform console gets strict: it is the highest-privilege plane and has
  // no legitimate cross-site entry point.
  sameSite: plane === "platform" ? "strict" : "lax",
});

/**
 * The PORTAL plane's own Better Auth secret, derived from the shared
 * one rather than added as a new env var to provision.
 *
 * WHY IT EXISTS (security review of Phase 3 slice 1). Better Auth's
 * email-verification tokens are self-contained JWTs signed with the
 * instance secret and carrying NO plane claim — just
 * `{email, updateTo?, requestType?}`. They touch no table, so the
 * "separate tables are the barrier" property that protects SESSION
 * tokens does not protect these at all: with one shared secret, a token
 * minted on one plane verifies on another, `/verify-email` resolves
 * `email` against THAT plane's user model, and the change-email branch
 * MINTS A SESSION before any password is checked (so did the member
 * instance's `autoSignInAfterVerification` until C30 turned it off).
 *
 * A plane claim in the payload would need a hook on every instance and
 * would still be one forgotten hook away from the same hole. A distinct
 * secret makes every portal-signed artifact structurally unverifiable
 * on the other two planes, and vice versa, with nothing to remember.
 * SECURITY.md §3.3 already named per-plane secrets as future hardening;
 * this is the case that makes them load-bearing rather than hygiene.
 *
 * Derivation, not a second env var: there are no portal sessions or
 * tokens in existence yet, so nothing is invalidated, and the operator
 * has one secret to rotate. If BETTER_AUTH_SECRET is unset, Better
 * Auth's own dev fallback applies to the other planes and this derives
 * from the same empty string — dev-only, like theirs.
 */
export const portalAuthSecret = createHash("sha256")
  .update(`${env.BETTER_AUTH_SECRET ?? ""}:portal-plane`)
  .digest("hex");

export const mailFrom = {
  name: env.MAIL_FROM_NAME,
  address: env.MAIL_FROM_ADDRESS,
  get header(): string {
    return `${this.name} <${this.address}>`;
  },
} as const;

/** Build an absolute URL on the canonical app origin. Deep links in email
 * carry links, not data (ARC-09), and always point here. */
export const absoluteUrl = (path: string): string =>
  new URL(path, appUrl).toString();

/**
 * Host→plane resolution (ARC-11 / decision 9): ops.naxdor.com serves
 * ONLY the platform console; os.naxdor.com serves tenant + portal.
 * In dev both share localhost and path prefixes separate the planes.
 * The hostname→tenantId lookup for v2 subdomains stubs in here too —
 * this function is the tenant-resolution seam's host half.
 */
export const planeForHost = (host: string): "platform" | "app" => {
  if (opsUrl.host !== appUrl.host && host === opsUrl.host) return "platform";
  return "app";
};

/**
 * View-as-Contact's route prefix and request header (Phase 3 slice 5).
 *
 * RE-EXPORTED FROM A LEAF MODULE rather than declared here, and the
 * reason is measured: one `"use client"` component needs the prefix,
 * and importing THIS module from a client component shipped the env
 * schema, the `portalAuthSecret` derivation and a crypto polyfill into a
 * 444 KB browser chunk — because Turbopack tree-shakes exports but keeps
 * top-level side effects, and lines 1 and 44 of this file are exactly
 * that. `./view-as.ts` imports nothing. See its header for the full
 * account.
 *
 * Server code may keep importing either path; the client component must
 * use `@/config/view-as`.
 */
export { VIEW_AS_HEADER, VIEW_AS_PREFIX } from "./view-as";

/**
 * File storage endpoints (INV-D2: hosts live here and only here). The
 * R2 endpoint is a separate apex by construction — downloads are served
 * off-origin with Content-Disposition: attachment (SECURITY.md §5).
 */
export type R2Config = {
  readonly accountId: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
  /** https://<account>.eu.r2.cloudflarestorage.com — EU jurisdiction. */
  readonly endpoint: string;
};

export const r2Config: R2Config | null =
  env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET
    ? {
        accountId: env.R2_ACCOUNT_ID,
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        bucket: env.R2_BUCKET,
        endpoint: `https://${env.R2_ACCOUNT_ID}.eu.r2.cloudflarestorage.com`,
      }
    : null;

/** Local-disk dev transport: bytes under .dev-storage/, "presigned"
 * URLs point at the dev-only route handler on the app origin. */
export const devStorageConfig = {
  routePath: "/api/dev-storage",
  signingSecret:
    env.DEV_STORAGE_SECRET ??
    env.BETTER_AUTH_SECRET ??
    `dev-storage-${Math.random().toString(36).slice(2)}`,
  /** Absolute URL of the dev-storage handler for a storage key. */
  urlFor(key: string): URL {
    const path = key.split("/").map(encodeURIComponent).join("/");
    return new URL(`${this.routePath}/${path}`, appUrl);
  },
} as const;

/** Upstash Redis REST credentials for the rate limiter (INV-D2: hosts live here). */
export const upstashConfig: { readonly url: string; readonly token: string } | null =
  env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN
    ? { url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN }
    : null;

/**
 * The key every rate-limit SUBJECT is HMAC'd under before it leaves this
 * process for Upstash (SECURITY.md §4 and §9.2: "keys are HMAC-hashed
 * identifiers only"). A subject is an IP address, an email address or a
 * principal id — personal data, every one — and Upstash is a US-parent
 * sub-processor kept to near-zero personal data on exactly that promise.
 *
 * Derived from BETTER_AUTH_SECRET as `portalAuthSecret` is, for its
 * reasons: one secret for the operator to rotate, and in production this
 * module fails closed without it (above — Better Auth alone would not: it
 * also accepts `AUTH_SECRET`). Rotating it re-keys every counter,
 * which forgives whatever was in flight — a reset, never a lockout. In
 * dev with the secret unset this derives from the empty string, which
 * hides nothing from a dictionary; dev-only, like theirs.
 */
export const rateLimitSubjectKey: Buffer = createHash("sha256")
  .update(`${env.BETTER_AUTH_SECRET ?? ""}:ratelimit-subject`)
  .digest();
