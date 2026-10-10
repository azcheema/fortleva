import { randomUUID } from "node:crypto";

/* eslint-disable no-restricted-imports -- dbtest fixture uses the raw layer for setup/cleanup */
import { getPlatformClient, runtimeClient } from "@/db/client";
import type { MemberActor } from "@/authz/authorize";
import type { TemplateKey } from "@/authz/catalog";

import { provisionTenant } from "./provisioning";

/**
 * Shared fixture for the member/role administration dbtests: one fresh
 * tenant, the owner, and one member per other template, each seated on
 * exactly that system role. Actors carry a fresh MFA stamp so ✦ codes
 * pass authorize(); `noMfa` builds the same actor without one.
 */
export type Seat = { userId: string; memberId: string; roleId: string; actor: MemberActor };

const freshMfa = () => ({ enrolled: true, verifiedAt: new Date() });

export const actorFor = (memberId: string): MemberActor => ({ memberId, mfa: freshMfa() });
export const noMfa = (memberId: string): MemberActor => ({ memberId });

/**
 * Serialise a value with every UUID-shaped substring masked to `<id>`,
 * for a "the trail must not carry this figure" assertion over audit
 * metadata that legitimately holds ids. A short numeric sentinel can
 * appear INSIDE a 32-hex-digit id — `"600"` did, in `aaa60007-…`, and
 * failed `time.dbtest.ts` in a CI run that touched nothing there
 * (2026-09-25) — so the ids are taken out before the substring test.
 * Lowercase only, which is what `randomUUID()` and Prisma's `uuid(7)`
 * both produce; an uppercase id would bring the flake back, never hide
 * a leak. Prefer `toEqual` on the whole metadata where its shape is
 * known — this is for the scans where it is not.
 */
export const maskIds = (value: unknown): string =>
  JSON.stringify(value).replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
    "<id>",
  );

export async function setupTenant(label: string) {
  const platform = getPlatformClient();
  const run = randomUUID().slice(0, 8);
  const users = {
    owner: randomUUID(),
    admin: randomUUID(),
    manager: randomUUID(),
    employee: randomUUID(),
  };
  for (const [k, id] of Object.entries(users)) {
    const email = `${k}-${label}-${run}@test.invalid`;
    await platform.user.create({ data: { id, name: email, email } });
  }
  const { tenantId, ownerMemberId } = await provisionTenant({
    name: `${label} ${run}`,
    slug: `${label}-${run}`,
    ownerUserId: users.owner,
  });
  const roles = await platform.role.findMany({ where: { tenantId, isSystem: true } });
  const roleId = (key: TemplateKey) => roles.find((r) => r.templateKey === key)!.id;

  const seat = async (key: Exclude<TemplateKey, "owner">): Promise<Seat> => {
    const member = await platform.member.create({
      data: { tenantId, userId: users[key] },
    });
    await platform.memberRole.create({
      data: { tenantId, memberId: member.id, roleId: roleId(key) },
    });
    return { userId: users[key], memberId: member.id, roleId: roleId(key), actor: actorFor(member.id) };
  };

  const seats = {
    owner: {
      userId: users.owner,
      memberId: ownerMemberId,
      roleId: roleId("owner"),
      actor: actorFor(ownerMemberId),
    } satisfies Seat,
    admin: await seat("admin"),
    manager: await seat("manager"),
    employee: await seat("employee"),
  };

  const cleanup = async () => {
    // Invoices (Phase 4 slice 107) RESTRICT their client, project and tenant,
    // and an issued one is deleted only under the maintenance GUC by the
    // platform role. A suite that makes invoices deletes them BEFORE its
    // clients and projects (`deleteInvoices` below); this is the backstop
    // for the tenant's own delete. One statement, so a credit note and the
    // invoice it credits go together (the FK is NO ACTION).
    await deleteInvoices();
    // search_index has NO foreign key to anything, so a row whose source
    // is already gone is unreachable by every delete below and would
    // outlive the tenant unattributable. Swept here, by tenant, so no
    // dbtest that feeds the index has to remember (a73cd12's class).
    await platform.$executeRaw`DELETE FROM search_index WHERE tenant_id = ${tenantId}`;
    // The renewal reminders' dedupe (3V slice 89) has no FK to its subject
    // and RESTRICTs the tenant: any dbtest that runs the job leaves rows.
    await platform.expirationReminderSent.deleteMany({ where: { tenantId } });
    // …and the update reminders' (Phase 5 slice 102), which RESTRICT the
    // tenant too — gone with their project, but a suite that leaves its
    // projects would otherwise fail here on this table first.
    await platform.projectUpdateReminderSent.deleteMany({ where: { tenantId } });
    // The update LAYOUTS (Phase 5 slice 105) RESTRICT the tenant, and a
    // project that picked one RESTRICTs the layout — so this relies on the
    // suite having deleted its projects, as the tenant's own delete does.
    await platform.projectUpdateTemplate.deleteMany({ where: { tenantId } });
    // Phone-notification devices (Phase 5 slice 106) RESTRICT the tenant; the
    // member delete below would cascade them, but say it rather than rely on
    // the order.
    await platform.pushSubscription.deleteMany({ where: { tenantId } });
    await platform.memberInvite.deleteMany({ where: { tenantId } });
    await platform.memberRole.deleteMany({ where: { tenantId } });
    await platform.rolePermission.deleteMany({ where: { tenantId } });
    await platform.role.deleteMany({ where: { tenantId } });
    await platform.member.deleteMany({ where: { tenantId } });
    await platform.tenant.delete({ where: { id: tenantId } });
    await platform.user.deleteMany({ where: { id: { in: Object.values(users) } } });
    await platform.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.audit_maintenance', 'on', true)`;
      await tx.auditEvent.deleteMany({ where: { tenantId } });
    });
    await platform.$disconnect();
    await runtimeClient.$disconnect();
  };

  /**
   * Every invoice of the tenant (lines and records of sends cascade), issued ones included, then
   * its numbering series (slice 108, RESTRICTs the tenant, refuses DELETE
   * outside the GUC) and the invoices' PDF files (RESTRICTed by the invoice
   * until it goes) — the platform role under the maintenance GUC.
   */
  async function deleteInvoices(): Promise<void> {
    await platform.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.invoice_maintenance', 'on', true)`;
      // Slice 110: an hour's mark RESTRICTs its line — cleared first (the
      // billing guard lets platform maintenance); the records of hours go
      // with their invoices.
      await tx.timeEntry.updateMany({ where: { tenantId, invoiceLineId: { not: null } }, data: { invoiceLineId: null } });
      await tx.invoice.deleteMany({ where: { tenantId } });
      await tx.invoiceSeries.deleteMany({ where: { tenantId } });
      await tx.fileObject.deleteMany({ where: { tenantId, kind: "INVOICE_PDF" } });
    });
  }

  const audits = (action: string) =>
    platform.auditEvent.findMany({ where: { tenantId, action }, orderBy: { createdAt: "asc" } });

  const permissionsVersion = async () =>
    (await platform.tenant.findUniqueOrThrow({ where: { id: tenantId } })).permissionsVersion;

  return { platform, tenantId, roleId, seats, cleanup, deleteInvoices, audits, permissionsVersion };
}
