import type { Prisma } from "@/generated/prisma/client";
import type { TenantDb } from "@/db";
import { tenantContextStorage } from "@/db/context";
import { requestContext } from "@/lib/request-context";

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
  if (!isAuditAction(input.action)) {
    throw new Error(`audit.record: unknown action "${String(input.action)}" — add it to the catalog`);
  }
  const ctx = tenantContextStorage.getStore();
  if (!ctx) {
    throw new Error("audit.record: no tenant context — use withPlatform for platform events");
  }
  const spec = AUDIT_EVENTS[input.action];
  if (spec.visibility === "PLATFORM") {
    throw new Error(
      `audit.record: "${input.action}" is a PLATFORM event — emit it through withPlatform, not from tenant context`,
    );
  }
  const req = requestContext();

  const actorType =
    ctx.principal.type === "member"
      ? "MEMBER"
      : ctx.principal.type === "contact"
        ? "CONTACT"
        : ctx.principal.type === "platform_admin"
          ? "PLATFORM_ADMIN"
          : "SYSTEM";

  await tx.auditEvent.create({
    data: {
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
      visibility: spec.visibility,
    },
  });
}
