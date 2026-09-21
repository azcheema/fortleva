import type { Prisma } from "@/generated/prisma/client";
import type { TenantDb } from "@/db";
import { isUuid, tenantContextStorage } from "@/db/context";
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
  /**
   * THE CONTACT A BROKERED PORTAL WRITE IS ACTING FOR (AUTHZ.md §8).
   *
   * A contact-caused write runs under `withTenant(tenantId,
   * {type:'system'})` — that is what "brokered" means — so the
   * principal this function would otherwise read names nobody: the row
   * would come out `SYSTEM` with a null actor, and the one column an
   * operator needs in order to answer "who asked for this" would be
   * empty in the one family of events where the actor is not an
   * employee. AUTHZ.md's brokered-write rule says the opposite in as
   * many words: "an `AuditEvent` naming the contact as actor".
   *
   * IT IS ONLY HONOURED INSIDE A SYSTEM TRANSACTION, and that refusal
   * is the whole safety argument. A member-principal caller passing it
   * would be attributing their own act to a client, which is a forged
   * row in the one table SECURITY.md §7 treats as evidentiary; it
   * throws rather than being ignored, because a silently-dropped
   * attribution reads as success. A contact-principal caller does not
   * need it — `portal_audit_insert` already pins such a row to the
   * contact — and passing it there would mean the caller has the wrong
   * transaction, so that throws too.
   *
   * There is no matching escape for a MEMBER: a system transaction that
   * wants to name a member is a job, and `job.run` is how a job speaks.
   */
  readonly brokeredForContactId?: string;
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

  // Checked over the WHOLE batch before anything is written, like the
  // action check above: a batch with one forged attribution writes
  // nothing rather than half a trail.
  for (const input of inputs) {
    if (input.brokeredForContactId === undefined) continue;
    if (ctx.principal.type !== "system") {
      throw new Error(
        `audit.record: brokeredForContactId is only for a brokered portal write — this transaction is a ${ctx.principal.type} one`,
      );
    }
    // SHAPE, NOT JUST PRINCIPAL (code + security review). The first cut
    // checked only that the transaction was a system one, and then the
    // row build below tested TRUTHINESS — so `""` passed the guard,
    // fell through to `actorType: SYSTEM`, and wrote `actorId: ""`: a
    // row that is neither a valid system row nor a valid contact row,
    // in the one table SECURITY.md §7 treats as evidentiary and
    // `audit_event_immutable` makes permanent. A UUID check costs
    // nothing and no round trip. What it deliberately does NOT do is
    // prove the id names a contact of this tenant — that is a read in
    // the audit hot path; the control for that is
    // `src/portal/brokered-writes.test.ts`, which restricts who may name
    // this field at all.
    if (!isUuid(input.brokeredForContactId)) {
      throw new Error("audit.record: brokeredForContactId must be a contact UUID");
    }
  }

  await tx.auditEvent.createMany({
    data: inputs.map((input) => ({
      tenantId: ctx.tenantId,
      // A brokered portal write names the contact it was performed for;
      // everything else names the principal the transaction runs as.
      actorType: input.brokeredForContactId !== undefined ? ("CONTACT" as const) : actorType,
      actorId: input.brokeredForContactId ?? ("id" in ctx.principal ? ctx.principal.id : null),
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
