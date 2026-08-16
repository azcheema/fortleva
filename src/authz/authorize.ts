import type { TenantDb } from "@/db";

import { PERMISSIONS } from "./catalog";
import { AuthzError, deny } from "./errors";

/**
 * The authorization seam (AUTHZ.md §6): every member-plane check flows
 * through here. No call site touches authz tables or compares role
 * names — enforced by lint and review. Contacts have their own seam
 * (authorizePortal, Phase 3); platform has authorizePlatform.
 */

const KNOWN_CODES = new Set(PERMISSIONS.map((p) => p.code));
const PERMISSION_BY_CODE = new Map(PERMISSIONS.map((p) => [p.code, p]));

/**
 * Step-up ("sudo") window for ✦ codes (SECURITY.md §3.5/§3.6): a second
 * factor verified on THIS session within the window satisfies authorize();
 * older or absent ⇒ MFA_REQUIRED/step_up. Callers with a stricter window
 * (vault, continuity box) call requireRecentMfa() after requireAccess().
 */
export const STEP_UP_WINDOW_MINUTES = 15;

export type MfaState = {
  /** User.twoFactorEnabled — a TOTP factor is enrolled. */
  readonly enrolled: boolean;
  /** Session.mfaVerifiedAt — last interactive factor on this session. */
  readonly verifiedAt: Date | null;
};

export type MemberActor = {
  readonly memberId: string;
  /** Set during platform impersonation — restricts to view-class verbs. */
  readonly impersonated?: boolean;
  /**
   * MFA posture of the session (AUTHZ.md §7.5). Absent means "unknown"
   * and is treated as not enrolled — a ✦ code then denies; only
   * requireTenantContext() should build actors for ✦ paths.
   */
  readonly mfa?: MfaState;
};

const minutesSince = (at: Date, now: Date): number => (now.getTime() - at.getTime()) / 60_000;

/**
 * Sudo-window helper (AUTHZ.md §7.5, SECURITY.md §3.5): throws
 * MFA_REQUIRED unless the actor's session carries a second-factor
 * verification newer than `minutes`. Enrolment missing ⇒ "enrol";
 * stale/absent verification ⇒ "step_up". Pure and synchronous-safe;
 * async for call-site symmetry with authorize().
 */
export async function requireRecentMfa(
  actor: MemberActor,
  minutes: number,
  now: Date = new Date(),
): Promise<void> {
  if (!actor.mfa?.enrolled) deny("MFA_REQUIRED", "enrol");
  const at = actor.mfa?.verifiedAt;
  if (!at || minutesSince(at, now) > minutes) deny("MFA_REQUIRED", "step_up");
}

/**
 * Effective permission set = union across held roles, minus
 * TENANT_REVOKE tombstones (B3). Resolved per request from the DB —
 * never from a JWT (§7.6). Callers memoize per request.
 */
export async function effectivePermissions(
  tx: TenantDb,
  memberId: string,
): Promise<ReadonlySet<string>> {
  const rows = await tx.memberRole.findMany({
    where: { memberId, member: { status: "ACTIVE" } },
    select: {
      role: {
        select: {
          rolePermissions: {
            where: { source: { not: "TENANT_REVOKE" } },
            select: { permission: { select: { code: true } } },
          },
        },
      },
    },
  });
  const codes = new Set<string>();
  for (const row of rows) {
    for (const rp of row.role.rolePermissions) codes.add(rp.permission.code);
  }
  return codes;
}

/** View-class verbs an impersonating platform admin is limited to (§9). */
const VIEW_VERBS = new Set(["view", "view_all"]);

/**
 * Gate 4 for members: permission held? Fails CLOSED on unknown codes —
 * that is a config error, not a user error (AUTHZ.md §2).
 */
export async function authorize(
  tx: TenantDb,
  actor: MemberActor,
  code: string,
): Promise<void> {
  if (!KNOWN_CODES.has(code)) {
    console.error(`authorize: unknown permission code "${code}" — denying (config error)`);
    deny("FORBIDDEN", "unknown permission code");
  }
  if (actor.impersonated) {
    const verb = code.split(":")[1] ?? "";
    if (!VIEW_VERBS.has(verb)) {
      deny("FORBIDDEN", "impersonation is read-only");
    }
  }
  const held = await effectivePermissions(tx, actor.memberId);
  if (!held.has(code)) deny("FORBIDDEN");
  // ✦ codes (§7.5): permission held is necessary, not sufficient — the
  // session must carry an enrolled AND recent second factor. Checked
  // AFTER the permission so MFA_REQUIRED never leaks "would be allowed".
  if (PERMISSION_BY_CODE.get(code)?.requiresMfa) {
    await requireRecentMfa(actor, STEP_UP_WINDOW_MINUTES);
  }
}

export async function isAuthorized(
  tx: TenantDb,
  actor: MemberActor,
  code: string,
): Promise<boolean> {
  try {
    await authorize(tx, actor, code);
    return true;
  } catch (e) {
    if (e instanceof AuthzError) return false;
    throw e;
  }
}

export type ResourceScope = { kind: "all" } | { kind: "ids"; ids: readonly string[] };

/**
 * List-query scoping (AUTHZ.md §4): deny-default — zero assignments
 * means an empty scope; client:view_all is the only override. The
 * MemberClient/MemberProject tables land in Phase 2 with their parent
 * entities; until then only the override path can widen the scope,
 * which is exactly deny-default.
 */
export async function authorizedClientIds(
  tx: TenantDb,
  actor: MemberActor,
): Promise<ResourceScope> {
  const held = await effectivePermissions(tx, actor.memberId);
  if (held.has("client:view_all")) return { kind: "all" };
  // Phase 2: union of MemberClient rows + project→client lift.
  return { kind: "ids", ids: [] };
}
