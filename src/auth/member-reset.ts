import { record } from "@/audit/record";
import type { MemberActor } from "@/authz/authorize";
import { AuthzError } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { DomainError } from "@/lib/domain-error";
import { assertActorHoldsAll, roleEffectiveCodes, runGuarded } from "@/members/guards";
import { listMembershipsForUser } from "@/members/service";

import { endSessions, mailSignedOutByOwner, mailTwoFactorResetByOwner } from "./account-security";
import { isConsolePrincipal } from "./member-recovery";

/**
 * AN OWNER'S TWO VERBS ON A TEAMMATE'S SIGN-IN (slice 84, founder decision
 * C50): reset their two-factor, and sign them out everywhere. Both behind
 * `member:reset_two_factor` — owner-only by seed, ✦ so a fresh step-up —
 * because the power to reset includes the power to sign out (a reset signs
 * the teammate out everywhere too).
 *
 * THE RESET IS RUNBOOK §8's SINGLE-ACCOUNT RESET DONE BY THE APP, in one
 * transaction with its audit row: the factor row, the user's
 * `two_factor_enabled` flag (without it the account is locked for good —
 * `./factor-guard` says why), every session, every trusted-device mark and
 * every sign-in waiting for a code (`./account-security`'s purge). The
 * teammate is mailed and re-enrols at their next sign-in, from the
 * first-enrolment ramp. It is the answer for a member who lost the phone
 * AND every backup code — and it is only as safe as the owner's check of
 * who is asking, which is why the screen tells them to confirm by phone or
 * in person, never by email or chat (the mailbox may be the attacker's).
 *
 * WHAT IT REFUSES, and why:
 *  - **oneself** — an owner who has lost their own factor asks another
 *    owner; their own account has `/account`'s replacement.
 *  - **a console principal** — anybody with a `platformRole`: one factor
 *    row serves both planes, and the console's is the operator's.
 *  - **a teammate who belongs to ANOTHER workspace too** (any status). The
 *    factor is the person's, not the workspace's: an owner here resetting
 *    it would weaken the other workspace's security — after a reset the
 *    password alone opens the account, so whoever holds the password could
 *    enrol their own factor and pass the other workspace's step-ups. That
 *    is one tenant's admin reaching into another, which TENANCY.md never
 *    allows; it goes to the operator instead. (Not in C50's text — the
 *    brief did not consider shared accounts; recorded for the founder.)
 *  - **a teammate more powerful than the owner** — the grant-subset rule
 *    (AUTHZ.md §7.1): resetting a factor is a step toward being that
 *    person, so the actor must hold every code the target's ROLES carry —
 *    whatever the target's status, because a suspended member's effective
 *    set is empty and suspend → reset → reactivate would otherwise walk
 *    round the rule (the security review's low). Seeded, only owners hold
 *    the code and owners hold everything, so this bites only a custom role
 *    the code was granted to.
 *  - **nothing to reset** — no factor, enrolled or pending.
 *
 * THE SIGN-OUT refuses oneself (`/account` has "Sign out everywhere else")
 * and a console principal, and nothing else: it only ever reduces access,
 * so a teammate in another workspace may be signed out — they sign in
 * again.
 */

export const MEMBER_SECURITY_CODE = "member:reset_two_factor" as const;

type Input = { readonly tenantId: string; readonly actor: MemberActor; readonly memberId: string };

type Target = { readonly memberId: string; readonly userId: string; readonly email: string };

/** The teammate, after the gate — NOT_FOUND for anybody outside this workspace. */
async function loadTarget(tx: TenantDb, actor: MemberActor, memberId: string): Promise<Target> {
  const m = await tx.member.findFirst({
    where: { id: memberId },
    select: { id: true, userId: true, user: { select: { email: true, platformRole: true } } },
  });
  if (!m) throw new AuthzError("NOT_FOUND", "unknown member");
  if (m.id === actor.memberId) throw new DomainError("ACCOUNT_IS_YOURS");
  if (isConsolePrincipal(m.user.platformRole)) throw new DomainError("ACCOUNT_IS_OPERATORS");
  return { memberId: m.id, userId: m.userId, email: m.user.email };
}

const principalOf = (actor: MemberActor) => ({ type: "member", id: actor.memberId }) as const;

/**
 * Every code the member's assigned roles carry, whatever the member's
 * status — `effectivePermissions` answers nothing for a SUSPENDED member.
 * Read in sequence, never as `Promise.all` legs on one transaction.
 */
async function rolesCodesOf(tx: TenantDb, memberId: string): Promise<Set<string>> {
  const roles = await tx.memberRole.findMany({ where: { memberId }, select: { roleId: true } });
  const codes = new Set<string>();
  for (const { roleId } of roles) for (const code of await roleEffectiveCodes(tx, roleId)) codes.add(code);
  return codes;
}

/** member:reset_two_factor ✦ — the teammate's factor removed, sessions ended, mailed. */
export async function resetMemberTwoFactor(input: Input): Promise<{ sessionsEnded: number }> {
  // 1. WHO, behind the gate: the membership check below is a read across
  // workspaces, and only somebody who may reset is told its answer.
  const first = await withTenant(input.tenantId, principalOf(input.actor), async (tx) => {
    await requireAccess(tx, input.tenantId, input.actor, MEMBER_SECURITY_CODE);
    return loadTarget(tx, input.actor, input.memberId);
  });

  // 2. ONLY THIS WORKSPACE'S. Outside any tenant transaction: inside one,
  // the tenant context would scope the membership read to this workspace
  // and it could never see another (`withUser` sets none of its own).
  const memberships = await listMembershipsForUser(first.userId);
  if (memberships.some((m) => m.tenantId !== input.tenantId)) {
    throw new DomainError("ACCOUNT_IN_OTHER_WORKSPACE");
  }

  // 3. THE RESET, step 1's checks again inside the transaction that does
  // it. Not step 2's: a membership accepted elsewhere between the two is
  // not seen (a window of milliseconds, recorded in PLAN). `runGuarded` so
  // a grant-subset refusal is audited as an escalation.
  const at = new Date();
  const done = await runGuarded(input.tenantId, input.actor, async (tx) => {
    await requireAccess(tx, input.tenantId, input.actor, MEMBER_SECURITY_CODE);
    const target = await loadTarget(tx, input.actor, input.memberId);
    if (target.userId !== first.userId) throw new AuthzError("NOT_FOUND", "unknown member");
    await assertActorHoldsAll(tx, input.actor, await rolesCodesOf(tx, target.memberId), {
      rule: "reset_subset",
      targetType: "Member",
      targetId: target.memberId,
      detail: "cannot reset the two-factor of a member who holds what you do not",
    });

    const user = await tx.user.findUniqueOrThrow({
      where: { id: target.userId },
      select: { twoFactorEnabled: true },
    });
    const factor = await tx.twoFactor.deleteMany({ where: { userId: target.userId } });
    if (!user.twoFactorEnabled && factor.count === 0) throw new DomainError("TWO_FACTOR_NOT_ENROLLED");
    // NOT optional (./factor-guard): the flag is what sign-in reads, and a
    // row deleted under a set flag is a lockout no request can undo.
    await tx.user.update({ where: { id: target.userId }, data: { twoFactorEnabled: false }, select: { id: true } });
    const sessionsEnded = await endSessions(tx, target.userId, null);
    await record(tx, {
      action: "member.two_factor_reset",
      targetType: "Member",
      targetId: target.memberId,
      metadata: { sessionsEnded },
    });
    return { sessionsEnded, email: target.email };
  });

  // After the commit: an unsent mail must not undo a reset that happened.
  try {
    await mailTwoFactorResetByOwner(done.email, at);
  } catch (error) {
    // The member id only: this line can reach a world-readable CI log.
    console.error(`[auth] two-factor reset mail not sent for member ${input.memberId}`, error);
  }
  return { sessionsEnded: done.sessionsEnded };
}

/** member:reset_two_factor ✦ — every session of the teammate ended, mailed. */
export async function signOutMemberEverywhere(input: Input): Promise<{ sessionsEnded: number }> {
  const at = new Date();
  const done = await withTenant(input.tenantId, principalOf(input.actor), async (tx) => {
    await requireAccess(tx, input.tenantId, input.actor, MEMBER_SECURITY_CODE);
    const target = await loadTarget(tx, input.actor, input.memberId);
    const sessionsEnded = await endSessions(tx, target.userId, null);
    await record(tx, {
      action: "member.signed_out_everywhere",
      targetType: "Member",
      targetId: target.memberId,
      metadata: { sessionsEnded },
    });
    return { sessionsEnded, email: target.email };
  });
  // Nothing ended, nothing to tell them — and no inbox to fill by repeating
  // the verb (the security review's nit).
  if (done.sessionsEnded > 0) {
    try {
      await mailSignedOutByOwner(done.email, at);
    } catch (error) {
      console.error(`[auth] signed-out mail not sent for member ${input.memberId}`, error);
    }
  }
  return { sessionsEnded: done.sessionsEnded };
}
