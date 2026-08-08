import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/* eslint-disable no-restricted-imports -- dbtest cleanup uses the raw layer */
import { getPlatformClient, runtimeClient } from "@/db/client";
import { withTenant } from "@/db";
import { effectivePermissions } from "@/authz/authorize";
import { PERMISSIONS } from "@/authz/catalog";
import { AuthzError } from "@/authz/errors";

import { acceptInvite, createInvite, previewInvite } from "./invites";
import { provisionTenant } from "./provisioning";

const run = randomUUID().slice(0, 8);
const owner = { id: randomUUID(), email: `own-${run}@test.invalid` };
const invitee = { id: randomUUID(), email: `inv-${run}@test.invalid` };
let tenantId: string;
let ownerMemberId: string;

beforeAll(async () => {
  const platform = getPlatformClient();
  for (const u of [owner, invitee]) {
    await platform.user.create({ data: { id: u.id, name: u.email, email: u.email } });
  }
  const result = await provisionTenant({
    name: `Members ${run}`,
    slug: `members-${run}`,
    ownerUserId: owner.id,
  });
  tenantId = result.tenantId;
  ownerMemberId = result.ownerMemberId;
});

afterAll(async () => {
  const platform = getPlatformClient();
  await platform.memberInvite.deleteMany({ where: { tenantId } });
  await platform.memberRole.deleteMany({ where: { tenantId } });
  await platform.rolePermission.deleteMany({ where: { tenantId } });
  await platform.role.deleteMany({ where: { tenantId } });
  await platform.member.deleteMany({ where: { tenantId } });
  await platform.tenant.delete({ where: { id: tenantId } });
  await platform.user.deleteMany({ where: { id: { in: [owner.id, invitee.id] } } });
  await platform.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.audit_maintenance', 'on', true)`;
    await tx.auditEvent.deleteMany({ where: { tenantId } });
  });
  await platform.$disconnect();
  await runtimeClient.$disconnect();
});

describe("tenant provisioning (B6 matrix stamped as rows)", () => {
  it("creates the four system roles with canonical templateKeys", async () => {
    await withTenant(tenantId, { type: "member", id: ownerMemberId }, async (tx) => {
      const roles = await tx.role.findMany({ orderBy: { templateKey: "asc" } });
      expect(roles.map((r) => r.templateKey).sort()).toEqual([
        "admin",
        "employee",
        "manager",
        "owner",
      ]);
      expect(roles.every((r) => r.isSystem)).toBe(true);
      expect(roles.find((r) => r.templateKey === "owner")?.name).toBe("CEO");
    });
  });

  it("the owner's effective set is the full catalog", async () => {
    await withTenant(tenantId, { type: "member", id: ownerMemberId }, async (tx) => {
      const held = await effectivePermissions(tx, ownerMemberId);
      expect(held.size).toBe(PERMISSIONS.length);
    });
  });

  it("grants carry source=TEMPLATE (B3 lineage from the first row)", async () => {
    await withTenant(tenantId, { type: "member", id: ownerMemberId }, async (tx) => {
      const nonTemplate = await tx.rolePermission.count({
        where: { source: { not: "TEMPLATE" } },
      });
      expect(nonTemplate).toBe(0);
    });
  });
});

describe("invite lifecycle", () => {
  let employeeRoleId: string;
  let token: string;

  it("owner invites to the Employee role; token round-trips via preview", async () => {
    await withTenant(tenantId, { type: "member", id: ownerMemberId }, async (tx) => {
      const role = await tx.role.findFirst({ where: { templateKey: "employee" } });
      employeeRoleId = role!.id;
    });

    await createInvite({
      tenantId,
      actorMemberId: ownerMemberId,
      email: invitee.email.toUpperCase(), // normalization check
      roleIds: [employeeRoleId],
    });

    const platform = getPlatformClient();
    const invite = await platform.memberInvite.findFirst({
      where: { tenantId, email: invitee.email },
    });
    expect(invite?.status).toBe("PENDING");
    expect(invite?.tokenHash).toMatch(/^[0-9a-f]{64}$/);

    // The dev outbox holds the raw token link — extract it as the
    // invited user would from their email.
    const { readFileSync } = await import("node:fs");
    const outbox = readFileSync(".dev-outbox/outbox.jsonl", "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { to: string; text: string })
      .filter((m) => m.to === invitee.email);
    const match = outbox.at(-1)?.text.match(/\/invite\/([A-Za-z0-9_-]+)/);
    expect(match).toBeTruthy();
    token = match![1]!;

    const preview = await previewInvite(token);
    expect(preview?.status).toBe("PENDING");
    expect(preview?.email).toBe(invitee.email);
  });

  it("acceptance creates member + roles atomically; wrong email is rejected", async () => {
    await expect(
      acceptInvite({ token, userId: invitee.id, userEmail: "wrong@test.invalid" }),
    ).rejects.toThrow(AuthzError);

    const { memberId } = await acceptInvite({
      token,
      userId: invitee.id,
      userEmail: invitee.email,
    });

    await withTenant(tenantId, { type: "member", id: memberId }, async (tx) => {
      const held = await effectivePermissions(tx, memberId);
      expect(held.has("project:view")).toBe(true);
      expect(held.has("invoice:view")).toBe(false); // employee: no invoicing
      expect(held.has("member:invite")).toBe(false);
    });

    await expect(
      acceptInvite({ token, userId: invitee.id, userEmail: invitee.email }),
    ).rejects.toThrow(/ACCEPTED/);
  });

  it("subset guard: an employee cannot invite at Manager level", async () => {
    const platform = getPlatformClient();
    const employeeMember = await platform.member.findFirst({
      where: { tenantId, userId: invitee.id },
    });
    const managerRole = await platform.role.findFirst({
      where: { tenantId, templateKey: "manager" },
    });

    await expect(
      createInvite({
        tenantId,
        actorMemberId: employeeMember!.id,
        email: `nope-${run}@test.invalid`,
        roleIds: [managerRole!.id],
      }),
    ).rejects.toThrow(AuthzError); // fails at member:invite (gate 4)
  });
});
