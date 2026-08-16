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

/** Never let an audit failure break sign-in/sign-up; log loudly instead. */
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
          await guarded("mfa_changed", () => onMfaChanged(user.id, enabled));
        }
        if (keys.has("email")) {
          await guarded("email_changed", () => onEmailChanged(user.id));
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
          await guarded("password_changed", () => onPasswordChanged(userId, "change"));
        }
      },
    },
  },
};

/** emailAndPassword.onPasswordReset — the token-based reset path. */
export const onPasswordResetHook = async ({ user }: { user: { id: string } }): Promise<void> => {
  await guarded("password_reset", () => onPasswordChanged(user.id, "reset"));
};

const SIGN_IN_PATH = "/sign-in/email";
/** The twoFactor plugin's challenge cookie (plugins/two-factor/constant, pinned 1.6.26). */
const TWO_FACTOR_COOKIE = "two_factor";

/**
 * Endpoint after-hooks. Must be listed AFTER twoFactor in `plugins`.
 */
export const auditPlugin = (): BetterAuthPlugin => ({
  id: "fortleva-audit",
  hooks: {
    after: [
      {
        matcher: (ctx) => ctx.path === SIGN_IN_PATH,
        handler: createAuthMiddleware(async (ctx) => {
          const fresh = ctx.context.newSession;
          if (fresh) {
            // No 2FA, or a trusted device: sign-in is complete here.
            await guarded("login_succeeded", () => onLoginSucceeded(fresh.user.id, "password"));
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
          await guarded("login_failed", () => onLoginFailed(found.user.id, reason));
        }),
      },
      {
        matcher: (ctx) => isFreshFactorPath(ctx.path),
        handler: createAuthMiddleware(async (ctx) => {
          const fresh = ctx.context.newSession;
          if (!fresh) return; // step-up verify on an existing session, or invalid code
          // Sign-in completion carries the plugin's challenge cookie; the
          // enrol-time verify (already signed in) does not — that one is
          // recorded as auth.mfa_enabled by the user.update hook instead.
          const challenge = await ctx.getSignedCookie(
            ctx.context.createAuthCookie(TWO_FACTOR_COOKIE).name,
            ctx.context.secret,
          );
          if (!challenge) return;
          const method: LoginMethod =
            ctx.path === "/two-factor/verify-totp" ? "totp" : "backup_code";
          await guarded("login_succeeded", () => onLoginSucceeded(fresh.user.id, method));
        }),
      },
    ],
  },
});
