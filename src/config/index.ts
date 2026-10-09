import { createECDH, createHash } from "node:crypto";

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
  // Amazon SES (ARC-09; Phase 5 slice 103, founder decision C71) — read and
  // checked below (`amazonSesConfig`), as plain strings here so that a bad
  // value stops the boot with a sentence rather than a schema dump. Empty is
  // unset, for the Upstash reason above: it is how a harness keeps
  // `.env.local`'s values out of a process it starts.
  AMAZON_SES_REGION: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  AMAZON_SES_ACCESS_KEY_ID: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  AMAZON_SES_SECRET_ACCESS_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  AMAZON_SES_CONFIGURATION_SET: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  AMAZON_SES_FEEDBACK_TOPIC_ARN: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  // Only the literal "amazon-ses" means anything (`mailTransportKind`).
  MAIL_TRANSPORT: z.string().optional(),
  // The addresses a non-deployment may really mail with MAIL_TRANSPORT set.
  MAIL_DEV_RECIPIENTS: z.string().optional(),
  // "1" in the production deployment's environment ONLY: it may mail anyone
  // (`mailTransportKind`). Anything else is off.
  MAIL_SEND_TO_ANYONE: z.string().optional(),
  // Web Push (Phase 5 slice 106, founder decision C74) — read and checked
  // below (`webPushConfig`). Our VAPID pair, base64url (RFC 8292): a pair or
  // neither. Empty is unset, for the Upstash reason above.
  WEB_PUSH_VAPID_PUBLIC_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  WEB_PUSH_VAPID_PRIVATE_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  // `mailto:` or `https:` — who a push service contacts about our pushes.
  WEB_PUSH_SUBJECT: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  // Only the literal "dev" means anything (`pushTransportKind`).
  PUSH_TRANSPORT: z.string().optional(),
  // Only the literal "fixed" means anything (`fxTransportKind`).
  FX_TRANSPORT: z.string().optional(),
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

/**
 * AMAZON SES — WHERE MAIL IS SENT FROM, AND WHETHER IT IS SENT AT ALL (ARC-09;
 * Phase 5 slice 103, founder decision C71). RUNBOOK §1 lists the variables and
 * §9 the AWS side.
 *
 * **ONLY A REGION IN AN EU MEMBER STATE, IN EVERY MODE.** Everything Fortleva
 * keeps is at rest in the EU (SECURITY.md §9.3), and SES keeps what it sends in
 * the region that sent it — a deployment pointed at `us-east-1` would quietly
 * break that promise, so it does not boot. An allowlist, not a pattern: AWS's
 * `eu-` prefix also names London (`eu-west-2`) and Zurich (`eu-central-2`),
 * neither in the EU (the design review's low). Frankfurt by default, beside
 * the database.
 *
 * **CREDENTIALS COME IN PAIRS.** One without the other in production off
 * loopback is a deploy mistake, not a choice — it would be read as "no SES" and
 * every mail would fail at send. Both absent is the documented state of a
 * deployment that has not set mail up yet: `src/mailer` then refuses each send,
 * as it always has. The names are our own, never `AWS_*`, so no other library's
 * default credential chain can pick them up — or hand SES credentials meant for
 * something else.
 *
 * **THE ENDPOINT IS PINNED HERE** (`email.<region>.amazonaws.com`, INV-D2), so
 * no `AWS_ENDPOINT_URL*` variable can send our signed requests elsewhere.
 */
const EU_SES_REGIONS = ["eu-central-1", "eu-west-1", "eu-west-3", "eu-north-1", "eu-south-1", "eu-south-2"] as const;
const sesRegion = env.AMAZON_SES_REGION ?? "eu-central-1";
if (!(EU_SES_REGIONS as readonly string[]).includes(sesRegion)) {
  throw new Error(
    `AMAZON_SES_REGION must be a region in an EU member state — ${EU_SES_REGIONS.join(", ")} (src/config): "${sesRegion}" would keep mail outside the EU`,
  );
}
const sesKeys = [env.AMAZON_SES_ACCESS_KEY_ID, env.AMAZON_SES_SECRET_ACCESS_KEY].filter((k) => k !== undefined).length;
if (isProduction && sesKeys === 1 && !LOOPBACK_HOSTS.has(appUrl.hostname)) {
  throw new Error(
    "AMAZON_SES_ACCESS_KEY_ID and AMAZON_SES_SECRET_ACCESS_KEY must be set together (src/config): with one alone, no mail can be sent",
  );
}
if (env.AMAZON_SES_CONFIGURATION_SET !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(env.AMAZON_SES_CONFIGURATION_SET)) {
  throw new Error("AMAZON_SES_CONFIGURATION_SET is not a configuration set name (src/config): letters, digits, - and _ only");
}

/**
 * WHO A NON-DEPLOYMENT MAY MAIL FOR REAL: `MAIL_DEV_RECIPIENTS`, a comma list of
 * exact addresses (see `mailTransportKind` below). Lower-cased.
 */
const devRecipients = new Set(
  (env.MAIL_DEV_RECIPIENTS ?? "")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter((a) => a.length > 0),
);

/**
 * WHICH TRANSPORT `src/mailer` USES — and why a developer's machine never sends
 * real mail by accident (the design and security reviews' mediums).
 *
 * - **THE DEPLOYMENT** — a production build whose `APP_URL` is not loopback AND
 *   whose environment says `MAIL_SEND_TO_ANYONE=1` — with SES credentials sends
 *   through Amazon SES, to anyone. The flag is set in the production
 *   environment ONLY (Vercel's Production scope; RUNBOOK §1): "is this the real
 *   deployment" is DECLARED, never guessed — a `next build && next start` on a
 *   tunnel to try the installed app on a phone, or a Preview given the keys by
 *   mistake (on a branch of real data), is a production build off loopback too.
 *   Without the flag, such a process keeps the dev transport, and production's
 *   `send()` refuses every message loudly — a forgotten flag is an error, never
 *   a silent drop.
 * - **EVERYTHING ELSE** — `pnpm dev` (on loopback, a LAN address or a tunnel
 *   alike), every dbtest, the e2e harness's production build — stays on the dev
 *   transport (`.dev-outbox/`) even when `.env.local` holds the credentials,
 *   UNLESS `MAIL_TRANSPORT=amazon-ses` asks for real sending on purpose, and
 *   then ONLY to the addresses in `MAIL_DEV_RECIPIENTS` (`allowedRecipients`;
 *   the transport refuses every other one). A dev server points at the shared
 *   dev database, whose outbox holds fixtures' and real workspaces' rows: one
 *   `POST /api/jobs/run` would otherwise mail them all, and a run of bounces
 *   can get the whole SES account paused — production's mail with it. The flag
 *   without a list stops the boot.
 *
 * The harnesses strip the flags and the credentials too (`vitest.db.config.ts`,
 * `playwright.config.ts`, `e2e/fixtures/seed-cli.ts`).
 */
const realDeployment = isProduction && !LOOPBACK_HOSTS.has(appUrl.hostname) && env.MAIL_SEND_TO_ANYONE === "1";
if (env.MAIL_TRANSPORT === "amazon-ses" && !realDeployment && devRecipients.size === 0) {
  throw new Error(
    "MAIL_TRANSPORT=amazon-ses needs MAIL_DEV_RECIPIENTS (src/config): the addresses this machine may really mail, comma-separated",
  );
}

export type AmazonSesConfig = {
  /** A region in an EU member state (checked above). */
  readonly region: string;
  /** `https://email.<region>.amazonaws.com` — the SESv2 endpoint, pinned (INV-D2). */
  readonly endpoint: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** The configuration set every send names, for its event destinations; `null` = none. */
  readonly configurationSet: string | null;
  /** `null` on a deployment (anyone); otherwise the only addresses that may be mailed. */
  readonly allowedRecipients: ReadonlySet<string> | null;
};

export const amazonSesConfig: AmazonSesConfig | null =
  env.AMAZON_SES_ACCESS_KEY_ID !== undefined && env.AMAZON_SES_SECRET_ACCESS_KEY !== undefined
    ? {
        region: sesRegion,
        endpoint: `https://email.${sesRegion}.amazonaws.com`,
        accessKeyId: env.AMAZON_SES_ACCESS_KEY_ID,
        secretAccessKey: env.AMAZON_SES_SECRET_ACCESS_KEY,
        configurationSet: env.AMAZON_SES_CONFIGURATION_SET ?? null,
        allowedRecipients: realDeployment ? null : devRecipients,
      }
    : null;

export const mailTransportKind: "amazon-ses" | "dev" =
  amazonSesConfig !== null && (realDeployment || env.MAIL_TRANSPORT === "amazon-ses") ? "amazon-ses" : "dev";

// A real transport sending as a placeholder: SES refuses every send from an
// address that is not on its verified identity, so the boot says so instead.
if (mailTransportKind === "amazon-ses" && /(\.invalid|\.test|\.example|\.localhost|@localhost)$/i.test(mailFrom.address)) {
  throw new Error(
    `MAIL_FROM_ADDRESS is a placeholder (${mailFrom.address}) while Amazon SES is the transport (src/config): set it to an address on the SES identity's domain`,
  );
}
// The display name goes into `From:` as it is (`mailFrom.header`): SES refuses a
// non-ASCII name that is not RFC 2047-encoded, and a quote, comma or angle
// bracket breaks the header's parse — every send would fail (the code
// review's low). Plain printable ASCII without RFC 5322's specials, then.
if (mailTransportKind === "amazon-ses" && !/^[A-Za-z0-9 !#$%&'*+\-/=?^_`{|}~.]{1,64}$/.test(mailFrom.name)) {
  throw new Error(
    "MAIL_FROM_NAME must be plain ASCII while Amazon SES is the transport (src/config): letters, digits, spaces and simple punctuation — no accents, quotes, commas, brackets or @",
  );
}

/**
 * THE SNS TOPIC AMAZON SES REPORTS BOUNCES AND COMPLAINTS TO (Phase 5 slice
 * 103), and the one host its messages may name. `POST /api/mail-feedback`
 * accepts a message only from THIS topic (`src/mailer/sns.ts` says why the
 * topic, and not the signature alone, makes a message ours) and fetches only
 * from `sns.<its region>.amazonaws.com` — the host lives here (INV-D2).
 * Unset: the webhook answers 404 to everything. Its region must be SES's,
 * because SES publishes only to a topic in its own region.
 */
export type MailFeedbackConfig = {
  readonly topicArn: string;
  readonly region: string;
  /**
   * The AWS account that owns the topic — and so OUR account: a feedback event
   * counts only when the mail it describes was sent by it (`mail.sendingAccountId`,
   * `src/mailer/sns.ts`).
   */
  readonly accountId: string;
  /** `sns.<region>.amazonaws.com` — the only host a message's URLs may name. */
  readonly snsHost: string;
};

const TOPIC_ARN = /^arn:aws:sns:(eu-[a-z]+-\d):(\d{12}):([A-Za-z0-9_-]{1,256})$/;
const topicMatch = env.AMAZON_SES_FEEDBACK_TOPIC_ARN === undefined ? null : TOPIC_ARN.exec(env.AMAZON_SES_FEEDBACK_TOPIC_ARN);
if (env.AMAZON_SES_FEEDBACK_TOPIC_ARN !== undefined && (topicMatch === null || topicMatch[1] !== sesRegion)) {
  throw new Error(
    `AMAZON_SES_FEEDBACK_TOPIC_ARN must be an SNS topic ARN in ${sesRegion}, the SES region (src/config): arn:aws:sns:${sesRegion}:<account>:<name>`,
  );
}
export const mailFeedbackConfig: MailFeedbackConfig | null =
  topicMatch === null
    ? null
    : {
        topicArn: topicMatch[0],
        region: topicMatch[1]!,
        accountId: topicMatch[2]!,
        snsHost: `sns.${topicMatch[1]!}.amazonaws.com`,
      };

// A topic with nothing routed to it: with no configuration set, SES publishes
// only what the identity's own feedback notifications send there (RUNBOOK §9,
// step 7) — said once at boot, because the silence would otherwise look like
// a list that is simply empty (the design review's medium).
if (mailFeedbackConfig !== null && mailTransportKind === "amazon-ses" && amazonSesConfig?.configurationSet === null) {
  console.warn(
    "[config] AMAZON_SES_FEEDBACK_TOPIC_ARN is set but AMAZON_SES_CONFIGURATION_SET is not — bounces reach the topic only if the identity's own feedback notifications publish to it (RUNBOOK §9)",
  );
}

/**
 * WEB PUSH (Phase 5 slice 106; founder decision C74; ARC-25 Stage B). Our VAPID
 * key pair (RFC 8292) — `scripts/generate-vapid-keys.ts` prints one; a separate
 * pair per environment (RUNBOOK §1). A browser subscribes against our PUBLIC
 * key and then accepts only pushes signed with the matching private key, so a
 * process's keys can only ever reach devices that opted in on a deployment
 * holding the same pair.
 *
 * A PAIR OR NEITHER, and a pair that BELONGS TOGETHER (the private scalar must
 * derive the public point): anything else stops the boot with a sentence — a
 * mismatched pair would let every device subscribe and then refuse every push.
 * Neither: phone notifications are simply not offered (Settings says so).
 */
const vapidHalves = [env.WEB_PUSH_VAPID_PUBLIC_KEY, env.WEB_PUSH_VAPID_PRIVATE_KEY].filter((k) => k !== undefined).length;
if (vapidHalves === 1) {
  throw new Error(
    "WEB_PUSH_VAPID_PUBLIC_KEY and WEB_PUSH_VAPID_PRIVATE_KEY must be set together (src/config): `pnpm tsx scripts/generate-vapid-keys.ts` prints a pair",
  );
}
const vapidPairMatches = (publicKey: string, privateKey: string): boolean => {
  const pub = Buffer.from(publicKey, "base64url");
  const priv = Buffer.from(privateKey, "base64url");
  if (pub.length !== 65 || pub[0] !== 0x04 || priv.length !== 32) return false;
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(priv);
    return ecdh.getPublicKey().equals(pub);
  } catch {
    return false;
  }
};
if (
  env.WEB_PUSH_VAPID_PUBLIC_KEY !== undefined &&
  env.WEB_PUSH_VAPID_PRIVATE_KEY !== undefined &&
  !vapidPairMatches(env.WEB_PUSH_VAPID_PUBLIC_KEY, env.WEB_PUSH_VAPID_PRIVATE_KEY)
) {
  throw new Error(
    "WEB_PUSH_VAPID_PUBLIC_KEY and WEB_PUSH_VAPID_PRIVATE_KEY are not one P-256 key pair (src/config): base64url, 65 and 32 bytes, generated together",
  );
}
const webPushSubject = env.WEB_PUSH_SUBJECT ?? `mailto:${mailFrom.address}`;
if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/.test(webPushSubject)) {
  throw new Error("WEB_PUSH_SUBJECT must be a mailto: address or an https: URL (src/config; RFC 8292 §2.1)");
}

export type WebPushConfig = {
  /** base64url, 65 bytes uncompressed — what browsers subscribe with (`applicationServerKey`). */
  readonly publicKey: string;
  /** base64url, 32 bytes. Never leaves the server. */
  readonly privateKey: string;
  readonly subject: string;
};

export const webPushConfig: WebPushConfig | null =
  env.WEB_PUSH_VAPID_PUBLIC_KEY !== undefined && env.WEB_PUSH_VAPID_PRIVATE_KEY !== undefined
    ? { publicKey: env.WEB_PUSH_VAPID_PUBLIC_KEY, privateKey: env.WEB_PUSH_VAPID_PRIVATE_KEY, subject: webPushSubject }
    : null;

/**
 * HOW PUSHES LEAVE (`src/push/send.ts`):
 * - `"none"` — no key pair: nothing is offered and nothing is sent.
 * - `"dev"` — `PUSH_TRANSPORT=dev`: each request is written to
 *   `.dev-outbox/push.jsonl` (gitignored) instead of being POSTed — the e2e
 *   harness reads and decrypts it. Never on a production build off loopback:
 *   there a forgotten flag would turn every push into a silent drop, so it
 *   stops the boot instead (the mail outbox's rule).
 * - `"web-push"` — otherwise: POST to the browser's push service (Apple,
 *   Google, Mozilla, Microsoft — `pushEndpointUrl` below).
 * Both harnesses generate a throwaway pair of their own with
 * `PUSH_TRANSPORT=dev` (`vitest.db.config.ts`, `playwright.config.ts`); the
 * dbtests also inject their own transport.
 */
if (env.PUSH_TRANSPORT === "dev" && isProduction && !LOOPBACK_HOSTS.has(appUrl.hostname)) {
  throw new Error("PUSH_TRANSPORT=dev on a production build off loopback (src/config): pushes would be written to a file, never sent");
}
export const pushTransportKind: "none" | "dev" | "web-push" =
  webPushConfig === null ? "none" : env.PUSH_TRANSPORT === "dev" ? "dev" : "web-push";

// Real pushes signed as a placeholder (the code and security reviews' low): the
// default subject is `mailto:<MAIL_FROM_ADDRESS>`, whose default is a `.invalid`
// address, and a push service may refuse every signature that names one (Apple
// answers 403) — so the boot says so instead, as SES's sender check does.
if (pushTransportKind === "web-push" && /(\.invalid|\.test|\.example|\.localhost|@localhost)$/i.test(webPushSubject)) {
  throw new Error(
    `WEB_PUSH_SUBJECT is a placeholder (${webPushSubject}) while phone notifications are sent for real (src/config): set it, or MAIL_FROM_ADDRESS, to a real address — or PUSH_TRANSPORT=dev`,
  );
}

/**
 * THE PUSH SERVICES A DEVICE MAY NAME (C74 (g); SECURITY.md §9.2). A push
 * subscription's endpoint is a URL the member's BROWSER chose and the server
 * then POSTs to — so it is fenced like any outbound URL a user supplies: HTTPS,
 * no credentials, the default port, no fragment, and a host that IS one of the
 * four vendors' push services — exactly, or (Apple, Microsoft) a subdomain of
 * theirs, never a name that merely ends in the same letters. Checked when a
 * device is registered AND before every send (a row written under an older
 * list). An IP literal, a trailing dot or a lookalike matches nothing.
 */
const PUSH_SERVICE_HOSTS: readonly string[] = [
  // Google — Chrome, Edge on Android, Samsung Internet, Opera, Brave.
  "fcm.googleapis.com",
  // Mozilla — Firefox.
  "updates.push.services.mozilla.com",
  // Apple — Safari on macOS, and iPhone/iPad home-screen apps.
  "web.push.apple.com",
];
const PUSH_SERVICE_SUFFIXES: readonly string[] = [
  // Apple's other push hosts, should a browser hand one out.
  ".push.apple.com",
  // Microsoft — Edge on Windows (Windows Push Notification Services).
  ".notify.windows.com",
];
const MAX_PUSH_ENDPOINT_LENGTH = 1024;

/** The endpoint as a URL when it is one of the push services above; null otherwise. */
export function pushEndpointUrl(raw: string): URL | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_PUSH_ENDPOINT_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "" || url.hash !== "") {
    return null;
  }
  const host = url.hostname;
  const known =
    PUSH_SERVICE_HOSTS.includes(host) ||
    PUSH_SERVICE_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length && /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host));
  return known ? url : null;
}

/**
 * THE EXCHANGE RATE AN INVOICE'S VAT IS SHOWN IN SEK AT (Phase 4 slice 108;
 * `src/modules/invoicing/fx.ts`). Mervärdesskattelagen lets the seller use the
 * European Central Bank's latest published rate (or Nasdaq Stockholm's middle
 * rate); the ECB's daily reference rates are one public XML file, no key.
 * - `"ecb"` — fetch it, at issue, only for an invoice in another currency
 *   that carries Swedish VAT (C76).
 * - `"fixed"` — `FX_TRANSPORT=fixed`: a fixed table dated yesterday, for the
 *   harnesses (`playwright.config.ts`, `vitest.db.config.ts`). Never on a
 *   production build off loopback: there a forgotten flag would print a made-up
 *   rate on a real invoice, so it stops the boot (PUSH_TRANSPORT's rule). A
 *   NON-production build exposed to the internet would accept it — never issue
 *   real invoices from one (the security review's nit; the push rule's scope).
 */
export const ecbDailyRatesUrl = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
if (env.FX_TRANSPORT === "fixed" && isProduction && !LOOPBACK_HOSTS.has(appUrl.hostname)) {
  throw new Error("FX_TRANSPORT=fixed on a production build off loopback (src/config): invoices would print a made-up exchange rate");
}
export const fxTransportKind: "ecb" | "fixed" = env.FX_TRANSPORT === "fixed" ? "fixed" : "ecb";

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

/**
 * The key a share link's six-digit code is HMAC'd under before it is
 * stored (Phase 3V slice 90, `src/modules/vault/share-token.ts`). A plain
 * hash of a six-digit code is the code — a million candidates reverse in
 * a second — so a database dump plus a forwarded link would open a link
 * with a live code without the recipient's inbox (the migration's
 * pre-apply review). Keyed by a secret the database never holds, the dump
 * alone answers nothing. Derived from BETTER_AUTH_SECRET as the two keys
 * above are, for their reasons; rotating it voids every live code, and the
 * visitor asks for a new one — a reset, never a lockout.
 */
export const shareCodeKey: Buffer = createHash("sha256")
  .update(`${env.BETTER_AUTH_SECRET ?? ""}:vault-share-code`)
  .digest();

/**
 * The key a client's weekly-summary UNSUBSCRIBE link is signed with (Phase 5
 * slice 101, founder decision C69; RFC 8058; `src/notify/client-summary-token.ts`).
 * The link is stateless — the person and their workspace, and an HMAC over
 * both — so every old mail's link keeps working and nothing is stored to look
 * it up; what makes it unforgeable is a secret the database never holds.
 * Derived from BETTER_AUTH_SECRET as the keys above are, for their reasons;
 * rotating it voids every link already mailed, and the person's page then
 * says so and points them at their portal — a reset, never a lockout.
 */
export const clientSummaryLinkKey: Buffer = createHash("sha256")
  .update(`${env.BETTER_AUTH_SECRET ?? ""}:client-summary-link`)
  .digest();
