import { recordPlatformEvent } from "@/db";

import type { AuthAuditSink, LoginMethod } from "./audit-hooks";

/**
 * The PLATFORM plane's audit sink.
 *
 * Until 2026-09-11 the console instance recorded nothing whatsoever: no
 * `auditPlugin`, and `databaseHooks` carrying only the session stamp. So
 * sign-ins, failures and second-factor changes on the plane that reaches
 * `app_platform` — BYPASSRLS, cross-tenant, the highest privilege in the
 * product — left no trace anywhere.
 *
 * ONE ROW PER EVENT, KEYED ON `User.id`, AND THAT IS THE WHOLE POINT.
 * The member sink fans out through `recordForUserMemberships`, which
 * loops over the user's ACTIVE memberships and writes one row each. A
 * platform admin need not be a member of any tenant — nothing in `src/`
 * grants a membership alongside `platformRole`, and
 * `scripts/create-test-member.ts` deliberately leaves the role NULL — so
 * for such a principal that loop runs ZERO times, writes nothing, throws
 * nothing and returns 0. Reusing the member sink here would therefore
 * have produced a console audit trail that silently stayed empty for
 * exactly the accounts that most need one. Membership count is
 * irrelevant to everything below.
 *
 * Each method is a thin adapter, and the shape is deliberately dull: the
 * interesting decisions live in `@/audit/platform-record` (what a
 * platform row IS) and in the shared hooks in `./audit-hooks` (when to
 * emit). This file only says where.
 *
 * `targetType: "user"` with the same id as the actor is not redundant:
 * on a FAILED sign-in there is a target but no actor, so the target is
 * the only way to know whose account was attempted.
 */
export const platformAuditSink: AuthAuditSink = {
  loginSucceeded: (
    userId: string,
    method: LoginMethod,
    user?: Readonly<Record<string, unknown>> | undefined,
  ) =>
    recordPlatformEvent({
      action: "platform.login_succeeded",
      actorUserId: userId,
      targetType: "user",
      targetId: userId,
      // `superadmin: false` is the most interesting row this log can
      // hold, and no other signal in the product reports it. Both auth
      // instances share one `user`/`account` table and the console gates
      // sign-in on the password alone — requirePlatformAdmin() refuses
      // the SESSION afterwards, but the sign-in itself succeeded. So an
      // ordinary member reaching the ops sign-in form and getting their
      // password accepted would otherwise be indistinguishable here from
      // the operator.
      metadata: { method, superadmin: user?.["platformRole"] === "SUPERADMIN" },
    }),

  // No actor: nobody authenticated. Mirrors auth.login_failed's SYSTEM
  // shape on the member plane.
  loginFailed: (userId: string, reason: string) =>
    recordPlatformEvent({
      action: "platform.login_failed",
      targetType: "user",
      targetId: userId,
      metadata: { reason },
    }),

  // The highest-signal row this log can carry: at the code prompt the
  // caller has ALREADY passed the console password.
  mfaVerificationFailed: (
    userId: string,
    opts: { method: LoginMethod; reason: string; stage: "sign_in" | "step_up" },
  ) =>
    recordPlatformEvent({
      action: "platform.mfa_verification_failed",
      // At sign-in nobody has authenticated; a step-up failure comes from
      // a session that has.
      actorUserId: opts.stage === "step_up" ? userId : null,
      targetType: "user",
      targetId: userId,
      metadata: { method: opts.method, reason: opts.reason, stage: opts.stage },
    }),

  mfaChanged: (userId: string, enabled: boolean) =>
    recordPlatformEvent({
      action: enabled ? "platform.mfa_enabled" : "platform.mfa_disabled",
      actorUserId: userId,
      targetType: "user",
      targetId: userId,
    }),

  // The console has no change-email surface, so this cannot fire from an
  // ops route today. It is implemented rather than thrown because the
  // shared hooks call it on any `email` column change, and a sink that
  // threw would turn an unexpected write into a logged failure instead
  // of the row that would tell you it happened — which is precisely the
  // event you would want. It gets its OWN action: filing an email change
  // as a password change with a note would corrupt the trail for the
  // sake of saving one catalog line.
  emailChanged: (userId: string) =>
    recordPlatformEvent({
      action: "platform.email_changed",
      actorUserId: userId,
      targetType: "user",
      targetId: userId,
    }),

  passwordChanged: (userId: string, via: "change" | "reset") =>
    recordPlatformEvent({
      action: "platform.password_changed",
      actorUserId: userId,
      targetType: "user",
      targetId: userId,
      metadata: { via },
    }),
};
