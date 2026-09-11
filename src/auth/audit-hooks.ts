import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";

import type { AuditAction } from "@/audit/catalog";
import { record } from "@/audit/record";
import { withTenant, type Principal } from "@/db";
import { listMembershipsForUser } from "@/members/service";

/**
 * Auth-layer audit emitters (SECURITY.md §7, DATA_MODEL.md §3 "Auth"
 * row). Identity is global but the audit log is per tenant, so every
 * auth event fans out to the user's ACTIVE memberships: one TENANT row
 * per tenant, actor = that tenant's Member. Metadata is minimal — never
 * a password, code, secret, token or the new/old email.
 *
 * Wired into Better Auth in two places (src/auth/index.ts):
 *   - `memberDatabaseHooks` — row-level hooks (user/account updates,
 *     the session mfaVerifiedAt stamp);
 *   - `auditPlugin()` — an endpoint after-hook that runs AFTER the
 *     twoFactor plugin's own after-hook (plugin order), so it sees the
 *     final `newSession`: null while a 2FA challenge is pending, set
 *     when sign-in really completed.
 * The bodies are plain exported functions so the DB suite can call
 * them directly (auth-audit.dbtest.ts).
 */

type Meta = Record<string, string | number | boolean>;

/** Emit `action` into every ACTIVE tenant of the user. Returns rows written. */
export async function recordForUserMemberships(
  userId: string,
  action: AuditAction,
  opts: { metadata?: Meta; actor?: "member" | "system" } = {},
): Promise<number> {
  const memberships = (await listMembershipsForUser(userId)).filter((m) => m.status === "ACTIVE");
  for (const m of memberships) {
    const principal: Principal =
      opts.actor === "system" ? { type: "system" } : { type: "member", id: m.memberId };
    await withTenant(m.tenantId, principal, (tx) =>
      record(tx, {
        action,
        targetType: "member",
        targetId: m.memberId,
        metadata: opts.metadata,
      }),
    );
  }
  return memberships.length;
}

/**
 * Never let an audit failure break sign-in/sign-up; log loudly instead.
 *
 * WRAP THE WHOLE HANDLER BODY WITH THIS, never just the emitter call.
 * That distinction was a real defect until 2026-09-11 and it is worth
 * spelling out, because the broken version read as safe: the after-hooks
 * below did `internalAdapter.findUserByEmail(…)` and, worse,
 * `ctx.getSignedCookie(…)` OUTSIDE the wrapper, and Better Auth's
 * `runAfterHooks` turns anything an after-hook throws into the RESPONSE —
 * an APIError replaces an already-successful one, anything else becomes a
 * 500. The session row and cookie are written by then, so the user is
 * signed in and told they are not. The cookie read runs on every
 * successful two-factor sign-in, and it verifies a signature against a
 * shared secret: a malformed cookie, a rotated secret or a name collision
 * was enough. On the platform console, where a second factor is
 * mandatory, that is the only way in.
 */
const guarded = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
  try {
    await fn();
  } catch (e) {
    console.error(`[auth-audit] ${label} failed`, e);
  }
};

export type LoginMethod = "password" | "totp" | "backup_code";

export const onLoginSucceeded = (userId: string, method: LoginMethod) =>
  recordForUserMemberships(userId, "auth.login_succeeded", { metadata: { method } });

/** Actor is SYSTEM: nobody authenticated. Target = the member row. */
export const onLoginFailed = (userId: string, reason: string) =>
  recordForUserMemberships(userId, "auth.login_failed", { actor: "system", metadata: { reason } });

export const onMfaChanged = (userId: string, enabled: boolean) =>
  recordForUserMemberships(userId, enabled ? "auth.mfa_enabled" : "auth.mfa_disabled");

/**
 * A second factor was presented and rejected.
 *
 * `stage` decides the actor, and the distinction is real rather than
 * cosmetic: at SIGN-IN nobody has authenticated — the caller holds the
 * password and is attempting the factor — so the actor is SYSTEM, exactly
 * as for `auth.login_failed`. At STEP-UP the session is already
 * authenticated and the member is the actor; what failed was a
 * re-verification.
 */
export const onMfaVerificationFailed = (
  userId: string,
  opts: { method: LoginMethod; reason: string; stage: "sign_in" | "step_up" },
) =>
  recordForUserMemberships(userId, "auth.mfa_verification_failed", {
    actor: opts.stage === "sign_in" ? "system" : "member",
    metadata: { method: opts.method, reason: opts.reason, stage: opts.stage },
  });

/**
 * Backup codes replaced. Not covered by `onMfaChanged`: that keys on
 * `user.twoFactorEnabled`, which a reissue does not touch — so without
 * this, swapping a SUPERADMIN's entire recovery set left no trace.
 *
 * Inherits this helper's known limit, stated rather than discovered
 * later: the fan-out is per ACTIVE MEMBERSHIP, so a platform principal
 * with no active tenant membership writes NO row. Platform-plane
 * auditing is owed separately (PLAN §0).
 */
export const onBackupCodesReissued = (userId: string) =>
  recordForUserMemberships(userId, "auth.backup_codes_reissued");

export const onPasswordChanged = (userId: string, via: "change" | "reset") =>
  recordForUserMemberships(userId, "auth.password_changed", { metadata: { via } });

export const onEmailChanged = (userId: string) =>
  recordForUserMemberships(userId, "auth.email_changed");

/**
 * Sessions created on these paths follow a successful interactive
 * second factor (verify: an invalid code throws before any session
 * exists), both at sign-in completion and at the enrol-time verify.
 * Trusted-device sign-in creates its session on /sign-in/email and so
 * stays NULL: "trusted device satisfies login, never step-up"
 * (SECURITY.md §3.5).
 */
const FRESH_FACTOR_PATHS: ReadonlySet<string> = new Set([
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
]);

export const isFreshFactorPath = (path: string | undefined): boolean =>
  path !== undefined && FRESH_FACTOR_PATHS.has(path);

/**
 * WHERE AN AUTH EVENT GOES — the one thing that differs between the two
 * planes, isolated so everything else can be shared.
 *
 * The member plane fans an event out to every ACTIVE membership of the
 * user, one TENANT row per tenant, actor = that tenant's Member. The
 * platform plane writes ONE row with no tenant at all
 * (src/auth/platform-audit-hooks.ts). Those are genuinely different
 * destinations, but the hook plumbing that decides WHEN to emit — which
 * endpoint, which changed column, which Better Auth quirk — is
 * identical, and a second copy of it is the thing most likely to drift:
 * the console went un-audited for months precisely because its instance
 * was configured by hand beside a member instance that was not.
 *
 * So the plumbing below takes a sink, and each plane supplies one.
 */
export interface AuthAuditSink {
  /**
   * `user` is the session's user row when the caller has it. The member
   * sink ignores it; the platform sink reads `platformRole` off it, so a
   * console sign-in records whether the person actually held authority.
   * Optional because not every call site has the row — and a sink must
   * degrade to a row without the flag rather than to no row at all.
   */
  loginSucceeded(
    userId: string,
    method: LoginMethod,
    user?: Readonly<Record<string, unknown>> | undefined,
  ): Promise<unknown>;
  loginFailed(userId: string, reason: string): Promise<unknown>;
  mfaVerificationFailed(
    userId: string,
    opts: { method: LoginMethod; reason: string; stage: "sign_in" | "step_up" },
  ): Promise<unknown>;
  mfaChanged(userId: string, enabled: boolean): Promise<unknown>;
  emailChanged(userId: string): Promise<unknown>;
  passwordChanged(userId: string, via: "change" | "reset"): Promise<unknown>;
}

/** The member plane's sink: fan out to the user's ACTIVE memberships. */
export const memberAuditSink: AuthAuditSink = {
  loginSucceeded: onLoginSucceeded,
  loginFailed: onLoginFailed,
  mfaVerificationFailed: onMfaVerificationFailed,
  mfaChanged: onMfaChanged,
  emailChanged: onEmailChanged,
  passwordChanged: onPasswordChanged,
};

/**
 * update.before and update.after of one Better Auth write receive the
 * SAME endpoint context object; the before-hook parks the changed keys
 * there so the after-hook (which only sees the full row) knows what
 * changed. Null context (no endpoint scope) means nothing is recorded.
 */
const pendingUserKeys = new WeakMap<object, Set<string>>();
const pendingAccountKeys = new WeakMap<object, Set<string>>();

const park = (store: WeakMap<object, Set<string>>, ctx: object | null, data: object): void => {
  if (!ctx) return;
  const set = store.get(ctx) ?? new Set<string>();
  for (const k of Object.keys(data)) set.add(k);
  store.set(ctx, set);
};

const take = (store: WeakMap<object, Set<string>>, ctx: object | null): Set<string> => {
  if (!ctx) return new Set();
  const set = store.get(ctx) ?? new Set<string>();
  store.delete(ctx);
  return set;
};

/**
 * The user/account row hooks, for either plane.
 *
 * Deliberately does NOT include `session.create`. That hook carries the
 * plane stamp, and on the platform instance it also writes
 * `plane: "PLATFORM"` — the value `getPlatformSession()` checks. Folding
 * it into a shared factory would put the console's admission rule behind
 * a parameter, and getting that parameter wrong locks the operator out of
 * the only administrative plane. Each instance keeps its own literal.
 */
export const auditRowHooks = (
  sink: AuthAuditSink,
): NonNullable<BetterAuthOptions["databaseHooks"]> => ({
  user: {
    update: {
      before: async (data, ctx) => {
        park(pendingUserKeys, ctx, data);
      },
      after: async (user, ctx) => {
        const keys = take(pendingUserKeys, ctx);
        if (!user?.id) return;
        if (keys.has("twoFactorEnabled")) {
          const enabled = (user as { twoFactorEnabled?: boolean }).twoFactorEnabled === true;
          await guarded("mfa_changed", () => sink.mfaChanged(user.id, enabled));
        }
        if (keys.has("email")) {
          await guarded("email_changed", () => sink.emailChanged(user.id));
        }
      },
    },
  },
  account: {
    update: {
      before: async (data, ctx) => {
        park(pendingAccountKeys, ctx, data);
      },
      after: async (account, ctx) => {
        const keys = take(pendingAccountKeys, ctx);
        // updateMany (token reset) yields a count, not a row — that path
        // is covered by emailAndPassword.onPasswordReset instead.
        const row = account as { userId?: string } | number | null;
        if (typeof row !== "object" || !row?.userId) return;
        const userId = row.userId;
        if (keys.has("password")) {
          await guarded("password_changed", () => sink.passwordChanged(userId, "change"));
        }
      },
    },
  },
});

/** Row-level hooks for the member instance. */
export const memberDatabaseHooks: NonNullable<BetterAuthOptions["databaseHooks"]> = {
  session: {
    create: {
      before: async (session, ctx) => {
        if (!isFreshFactorPath(ctx?.path)) return;
        return { data: { ...session, mfaVerifiedAt: new Date() } };
      },
    },
  },
  ...auditRowHooks(memberAuditSink),
};

/** emailAndPassword.onPasswordReset — the token-based reset path. */
export const passwordResetHookFor =
  (sink: AuthAuditSink) =>
  async ({ user }: { user: { id: string } }): Promise<void> => {
    await guarded("password_reset", () => sink.passwordChanged(user.id, "reset"));
  };

export const onPasswordResetHook = passwordResetHookFor(memberAuditSink);

const SIGN_IN_PATH = "/sign-in/email";
/** The twoFactor plugin's challenge cookie (plugins/two-factor/constant, pinned 1.6.26). */
const TWO_FACTOR_COOKIE = "two_factor";

/**
 * Endpoint after-hooks. Must be listed AFTER twoFactor in `plugins`.
 */
export const auditPlugin = (sink: AuthAuditSink): BetterAuthPlugin => ({
  id: "fortleva-audit",
  hooks: {
    after: [
      {
        matcher: (ctx) => ctx.path === SIGN_IN_PATH,
        // The ENTIRE body is guarded, including the adapter read below.
        handler: createAuthMiddleware(async (ctx) =>
          guarded("sign_in", async () => {
            const fresh = ctx.context.newSession;
            if (fresh) {
              // No 2FA, or a trusted device: sign-in is complete here.
              await sink.loginSucceeded(fresh.user.id, "password", fresh.user);
              return;
            }
            const returned = ctx.context.returned as
              | { statusCode?: number; body?: { code?: string } }
              | undefined;
            const status = returned?.statusCode;
            if (status !== 401 && status !== 403) return; // pending 2FA (200) or other
            const email = (ctx.body as { email?: string } | undefined)?.email;
            if (typeof email !== "string") return;
            // Existence never reaches the client — this only decides
            // whether there is a member row to attach the failure to.
            const found = await ctx.context.internalAdapter.findUserByEmail(email.toLowerCase());
            if (!found) return;
            const reason = (returned?.body?.code ?? `http_${status}`).toLowerCase();
            await sink.loginFailed(found.user.id, reason);
          }),
        ),
      },
      {
        matcher: (ctx) => isFreshFactorPath(ctx.path),
        // The ENTIRE body is guarded. The getSignedCookie below verifies a
        // signature against the shared secret and runs on EVERY successful
        // two-factor sign-in; unguarded, a malformed cookie turned a
        // completed sign-in into an error response.
        handler: createAuthMiddleware(async (ctx) =>
          guarded("factor_verify", async () => {
            const method: LoginMethod =
              ctx.path === "/two-factor/verify-totp" ? "totp" : "backup_code";
            // Sign-in completion carries the plugin's challenge cookie; the
            // enrol-time verify (already signed in) does not — that one is
            // recorded as auth.mfa_enabled by the user.update hook instead.
            const challenge = await ctx.getSignedCookie(
              ctx.context.createAuthCookie(TWO_FACTOR_COOKIE).name,
              ctx.context.secret,
            );

            const fresh = ctx.context.newSession;
            if (fresh) {
              if (!challenge) return; // enrol-time verify
              await sink.loginSucceeded(fresh.user.id, method, fresh.user);
              return;
            }

            // NO NEW SESSION: the code was rejected (or this is a step-up
            // on an existing session that failed). Until 2026-09-11 this
            // branch did not exist and the whole class went unrecorded.
            const returned = ctx.context.returned as
              | { statusCode?: number; body?: { code?: string } }
              | undefined;
            const status = returned?.statusCode;
            // ANY 4xx, not just 401/403. Better Auth throttles this
            // endpoint itself and its outcomes fall outside the narrower
            // filter: 400 TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE after five
            // tries against one challenge, 429 ACCOUNT_TEMPORARILY_LOCKED
            // after ten consecutive failures. A pending-2FA sign-in
            // returns 200 and is excluded by the `fresh` check above, not
            // here.
            //
            // ONE OF THOSE TWO IS STILL NOT CAPTURED, and the honest
            // version is worth more than the tidy one: the 429 lockout IS
            // recorded (it throws before the challenge is touched), but
            // the 400 challenge-burn is NOT — `beginAttempt()` calls
            // consumeVerificationValue() and expires the cookie BEFORE
            // throwing, so by the time this hook runs the verification row
            // is gone and the lookup below finds nothing to attribute it
            // to.
            //
            // THIS IS DELIBERATE, NOT OUTSTANDING. Measured on the console
            // 2026-09-11: FIVE invalid-code attempts each write a row, and
            // only the burn that follows them is silent — so the grind is
            // fully visible and "the challenge was ground to death" is
            // derivable from five consecutive rows for one user inside a
            // challenge lifetime. A sixth row would restate what the first
            // five prove.
            //
            // THE OBVIOUS FIX DOES NOT WORK, so do not re-propose it: park
            // the user id from a `hooks.before` and read it here. Better
            // Auth hands a before-hook a SPREAD COPY of the context
            // (`hook.handler({...context, returnHeaders: true})`,
            // api/dispatch.mjs), so a WeakMap keyed on `ctx` would key an
            // object that dies with that hook call; and if ANY before-hook
            // returns a context modification the whole context is replaced
            // by `defuReplaceArrays` before the after-hooks run. There is
            // no identity to key on. Weigh that against the cost of being
            // wrong: a before-hook that throws is a 500 BEFORE the handler
            // runs, on the plane with no second way in.
            if (typeof status !== "number" || status < 400 || status >= 500) return;

            // SIGN-IN failures, attributed from the pending challenge,
            // whose verification row holds the user id — the same row the
            // plugin consumes on success (verify-two-factor.mjs), and one
            // a FAILED code does not consume. `ctx.context.session` is not
            // an option: verifyTwoFactor resolves the session into a LOCAL
            // via getSessionFromCtx and never puts it on the context, so
            // reading it would silently attribute nothing. Step-up
            // failures are recorded in ./step-up instead, which holds the
            // session and can name the member.
            //
            // KNOWN IMPRECISION, chosen deliberately. verifyTwoFactor
            // ignores the challenge cookie whenever a session exists, so a
            // step-up failure in a browser that ALSO holds a live
            // challenge (a sign-in begun and abandoned in another tab,
            // inside the 600 s lifetime) writes a second row here, staged
            // `sign_in`, against the challenge's user. The alternative was
            // to skip whenever a session cookie is present — rejected,
            // because a caller chooses its own cookies, so that would let
            // anyone SUPPRESS this row by attaching a junk session cookie.
            // A rare duplicate is worth more than a suppressible trail.
            if (!challenge) return;
            const pending = await ctx.context.internalAdapter.findVerificationValue(challenge);
            const userId = (pending as { value?: string } | undefined)?.value;
            // A replayed or expired challenge: nothing to file it against,
            // and inventing a target would be worse than the silence.
            if (!userId) return;
            const reason = (returned?.body?.code ?? `http_${status}`).toLowerCase();
            await sink.mfaVerificationFailed(userId, { method, reason, stage: "sign_in" });
          }),
        ),
      },
    ],
  },
});
