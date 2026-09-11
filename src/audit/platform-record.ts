import type { Prisma } from "@/generated/prisma/client";

import { AUDIT_EVENTS, isAuditAction, type AuditAction } from "./catalog";

/**
 * The shape of a platform-plane audit row, as PURE policy.
 *
 * Split from the writer (src/db/platform-audit.ts) for the same reason
 * ./platform-gate is split from ./session: the writer reaches the Prisma
 * client, which throws without a connection string, and CI's unit job
 * runs before `migrate deploy`. The refusals below are the interesting
 * part, so they are the part that must be testable with nothing running.
 *
 * THE MODEL THIS ENFORCES. A platform-plane event is an event about a
 * User acting on the platform plane. It is NOT a tenant event that
 * happens to carry a null tenant:
 *
 *   tenant_id  NULL          — there is no tenant; it is not "unknown"
 *   visibility PLATFORM      — from the catalog, never a parameter
 *   actor_type PLATFORM_ADMIN with actor_id = User.id, or SYSTEM/NULL
 *                              when nobody authenticated
 *
 * That last line settles a reading of `ActorType` the schema never spelt
 * out, and it is worth stating: **ActorType names the plane and the id
 * namespace, not the authority level.** MEMBER → a Member.id, CONTACT →
 * a Contact.id, PLATFORM_ADMIN → a User.id on the platform plane, SYSTEM
 * → no actor at all. Someone who reaches the console sign-in WITHOUT
 * SUPERADMIN is therefore still PLATFORM_ADMIN — that is where they
 * acted — and whether they held authority is `metadata.superadmin`. A
 * `superadmin: false` row is one of the most interesting rows this log
 * can contain, and no other signal in the product reports it.
 */

export type PlatformAuditInput = {
  readonly action: AuditAction;
  /** User.id of the platform principal; omit or null ⇒ actorType SYSTEM. */
  readonly actorUserId?: string | null;
  readonly targetType?: string;
  readonly targetId?: string | null;
  readonly metadata?: Prisma.InputJsonValue;
};

/** The request fields an audit row carries when there is a request. */
export type AuditRequestContext = {
  readonly requestId?: string | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
};

export type PlatformAuditRow = {
  readonly tenantId: null;
  readonly actorType: "PLATFORM_ADMIN" | "SYSTEM";
  readonly actorId: string | null;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly metadata: Prisma.InputJsonValue | undefined;
  readonly requestId: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly visibility: "PLATFORM";
};

/**
 * Build the row, refusing anything that would file a platform event in
 * the wrong place. The mirror of `record()`'s two refusals, pointing the
 * other way — that one rejects PLATFORM actions from tenant context;
 * this one rejects TENANT actions from platform context, so neither
 * plane can borrow the other's catalog entries by accident.
 */
export function platformAuditRow(
  input: PlatformAuditInput,
  req?: AuditRequestContext | undefined,
): PlatformAuditRow {
  if (!isAuditAction(input.action)) {
    throw new Error(
      `recordPlatformEvent: unknown action "${String(input.action)}" — add it to the catalog`,
    );
  }
  const spec = AUDIT_EVENTS[input.action];
  if (spec.visibility !== "PLATFORM") {
    throw new Error(
      `recordPlatformEvent: "${input.action}" is a TENANT event — record() it inside withTenant`,
    );
  }
  if ("mirroredToTenant" in spec && spec.mirroredToTenant) {
    // A mirrored event is TWO rows, and the mirror is not implemented
    // anywhere (DATA_MODEL §3.1 promises it; nothing reads the flag at
    // runtime). Writing only the platform half here would look like the
    // promise had been kept. Refuse until mirroring exists.
    throw new Error(
      `recordPlatformEvent: "${input.action}" is mirrored — mirroring is not implemented (PLAN §0)`,
    );
  }
  return {
    tenantId: null,
    actorType: input.actorUserId ? "PLATFORM_ADMIN" : "SYSTEM",
    actorId: input.actorUserId ?? null,
    action: input.action,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    metadata: input.metadata,
    requestId: req?.requestId ?? null,
    ip: req?.ip ?? null,
    userAgent: req?.userAgent ?? null,
    visibility: spec.visibility,
  };
}
