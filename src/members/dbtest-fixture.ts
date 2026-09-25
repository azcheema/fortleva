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
    // search_index has NO foreign key to anything, so a row whose source
    // is already gone is unreachable by every delete below and would
    // outlive the tenant unattributable. Swept here, by tenant, so no
    // dbtest that feeds the index has to remember (a73cd12's class).
    await platform.$executeRaw`DELETE FROM search_index WHERE tenant_id = ${tenantId}`;
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

  const audits = (action: string) =>
    platform.auditEvent.findMany({ where: { tenantId, action }, orderBy: { createdAt: "asc" } });

  const permissionsVersion = async () =>
    (await platform.tenant.findUniqueOrThrow({ where: { id: tenantId } })).permissionsVersion;

  return { platform, tenantId, roleId, seats, cleanup, audits, permissionsVersion };
}
