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
