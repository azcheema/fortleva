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
  UPSTASH_REDIS_REST_URL: z.url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
});

const env = envSchema.parse(process.env);

export const isProduction = env.NODE_ENV === "production";

export const appUrl = new URL(env.APP_URL);
export const opsUrl = new URL(env.OPS_URL ?? env.APP_URL);

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
 * `email` against THAT plane's user model, and both the member
 * instance (`autoSignInAfterVerification`) and the change-email branch
 * MINT A SESSION before any password is checked.
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
