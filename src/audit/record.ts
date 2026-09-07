import type { Prisma } from "@/generated/prisma/client";
import type { TenantDb } from "@/db";
import { tenantContextStorage } from "@/db/context";
import { getRequestContext } from "@/lib/request-context";

import { AUDIT_EVENTS, isAuditAction, type AuditAction } from "./catalog";

/**
 * The one capture mechanism (SECURITY.md §7, DATA_MODEL.md §3):
 * explicit record() calls in the service layer, inside the SAME
 * transaction as the mutation they describe. Visibility comes from the
 * static catalog, never the call site. metadata is minimized by the
 * caller: never plaintext of encrypted fields, never personnummer.
 */

export type AuditInput = {
  readonly action: AuditAction;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly metadata?: Prisma.InputJsonValue;
  /** Platform admin User.id when acting under impersonation. */
  readonly impersonatorId?: string;
};

export async function record(tx: TenantDb, input: AuditInput): Promise<void> {
  await recordMany(tx, [input]);
}

/**
 * The same trail, written in ONE statement.
 *
 * A cascade audits per row — one `comment.deleted` per comment, one
 * `document.deleted` per attachment — because a row nobody can trace to
 * its target is not a trail. Calling `record()` in a loop makes that N
 * round trips inside the caller's transaction, each re-reading the
 * request context, so a long thread would push an ordinary delete
 * toward its budget. The validation, the principal and the request
 * context are identical across the batch by construction: they come
 * from the one transaction context all of these rows belong to.
 *
 * Every input is checked BEFORE anything is written, so a batch with one
 * bad action writes nothing rather than half a trail.
 */
export async function recordMany(tx: TenantDb, inputs: readonly AuditInput[]): Promise<void> {
  if (inputs.length === 0) return;
  for (const input of inputs) {
    if (!isAuditAction(input.action)) {
      throw new Error(`audit.record: unknown action "${String(input.action)}" — add it to the catalog`);
    }
  }
  const ctx = tenantContextStorage.getStore();
  if (!ctx) {
    throw new Error("audit.record: no tenant context — use withPlatform for platform events");
  }
  for (const input of inputs) {
    if (AUDIT_EVENTS[input.action].visibility === "PLATFORM") {
      throw new Error(
        `audit.record: "${input.action}" is a PLATFORM event — emit it through withPlatform, not from tenant context`,
      );
    }
  }
  // requestId/ip/userAgent from the ALS store or the Next request scope
  // (DATA_MODEL.md §3); NULL outside any request (jobs, tests).
  const req = await getRequestContext();

  const actorType =
    ctx.principal.type === "member"
      ? "MEMBER"
      : ctx.principal.type === "contact"
        ? "CONTACT"
        : ctx.principal.type === "platform_admin"
          ? "PLATFORM_ADMIN"
          : "SYSTEM";

  await tx.auditEvent.createMany({
    data: inputs.map((input) => ({
      tenantId: ctx.tenantId,
      actorType,
      actorId: "id" in ctx.principal ? ctx.principal.id : null,
      impersonatorId: input.impersonatorId ?? null,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      metadata: input.metadata,
      requestId: req?.requestId ?? null,
      ip: req?.ip ?? null,
      userAgent: req?.userAgent ?? null,
      // Tenant-plane emitters write TENANT rows; a PLATFORM-visibility
      // action recorded from tenant context is a catalog misuse.
      visibility: AUDIT_EVENTS[input.action].visibility,
    })),
  });
}
