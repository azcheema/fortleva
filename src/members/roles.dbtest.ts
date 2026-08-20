import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withTenant } from "@/db";
import { PERMISSIONS, TEMPLATE_VERSION, permissionsForTemplate } from "@/authz/catalog";
import { effectivePermissions } from "@/authz/authorize";
import { AuthzError } from "@/authz/errors";

import { assignRole } from "./admin";
import { noMfa, setupTenant } from "./dbtest-fixture";
import {
  createRole,
  deleteRole,
  grantPermission,
  listRoles,
  revokePermission,
  setRolePermissions,
} from "./roles";
import { cloneCodesForTemplate, propagateTemplates } from "./templates";

let f: Awaited<ReturnType<typeof setupTenant>>;

beforeAll(async () => {
  f = await setupTenant("roles");
});

afterAll(async () => {
  await f.cleanup();
});

const expectDenied = async (p: Promise<unknown>, reason: AuthzError["reason"], detail?: RegExp) => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AuthzError);
  expect((err as AuthzError).reason).toBe(reason);
  if (detail) expect((err as AuthzError).message).toMatch(detail);
};

const list = (memberId: string) =>
  withTenant(f.tenantId, { type: "member", id: memberId }, (tx) =>
    listRoles(tx, f.tenantId, { memberId }),
  );

const rowsOf = (roleId: string) =>
  f.platform.rolePermission.findMany({
    where: { tenantId: f.tenantId, roleId },
    include: { permission: { select: { code: true } } },
  });

let cloneId: string;
let blankId: string;

describe("listRoles (role:view)", () => {
  it("owner sees the four system roles with their template sets", async () => {
    const roles = await list(f.seats.owner.memberId);
    expect(roles.filter((r) => r.isSystem)).toHaveLength(4);
    const ceo = roles.find((r) => r.templateKey === "owner")!;
    expect(ceo.codes).toHaveLength(PERMISSIONS.filter((p) => !p.deprecated).length);
    expect(ceo.holderCount).toBe(1);
    const emp = roles.find((r) => r.templateKey === "employee")!;
    expect(emp.codes.sort()).toEqual(permissionsForTemplate("employee").map((p) => p.code).sort());
  });

  it("an employee (no role:view) is refused", async () => {
    await expectDenied(list(f.seats.employee.memberId), "FORBIDDEN");
  });
});

describe("createRole (role:create)", () => {
  it("cloning CEO as admin is subset-denied and audited", async () => {
    await expectDenied(
      createRole({ tenantId: f.tenantId, actor: f.seats.admin.actor, name: "Shadow CEO", templateKey: "owner" }),
      "FORBIDDEN",
    );
    expect((await f.audits("authz.escalation_denied")).at(-1)!.metadata).toMatchObject({ rule: "grant_subset" });
    expect(await f.platform.role.count({ where: { tenantId: f.tenantId, name: "Shadow CEO" } })).toBe(0);
  });

  it("owner clones CEO: codes = template minus ✦ (§3.5), TENANT_GRANT source, clonedFromKey set, audited, version bumped", async () => {
    const before = await f.permissionsVersion();
    const { roleId } = await createRole({
      tenantId: f.tenantId,
      actor: f.seats.owner.actor,
      name: "Deputy",
      description: "CEO minus the ✦ set",
      templateKey: "owner",
    });
    cloneId = roleId;
    const role = await f.platform.role.findUniqueOrThrow({ where: { id: roleId } });
    expect(role.isSystem).toBe(false);
    expect(role.templateKey).toBeNull();
    expect(role.clonedFromKey).toBe("owner");
    expect(role.templateVersion).toBe(TEMPLATE_VERSION);
    const rows = await rowsOf(roleId);
    expect(rows.every((r) => r.source === "TENANT_GRANT")).toBe(true);
    const codes = rows.map((r) => r.permission.code).sort();
    expect(codes).toEqual([...cloneCodesForTemplate("owner")].sort());
    expect(codes).not.toContain("role:edit");
    expect(codes).not.toContain("member:manage_roles");
    expect(codes.length).toBe(PERMISSIONS.filter((p) => !p.requiresMfa && !p.deprecated).length);
    expect(await f.permissionsVersion()).toBe(before + 1);
    expect(await f.audits("role.created")).toHaveLength(1);
  });

  it("blank custom role starts empty; duplicate names are refused", async () => {
    const { roleId } = await createRole({ tenantId: f.tenantId, actor: f.seats.admin.actor, name: "Bookkeeper" });
    blankId = roleId;
    expect(await rowsOf(roleId)).toHaveLength(0);
    await expectDenied(
      createRole({ tenantId: f.tenantId, actor: f.seats.admin.actor, name: "Bookkeeper" }),
      "FORBIDDEN",
      /already exists/,
    );
  });
});

describe("role editing (role:edit ✦, §7.1 rule 2, §7.2)", () => {
  it("✦: no fresh factor → MFA_REQUIRED", async () => {
    await expectDenied(
      grantPermission({ tenantId: f.tenantId, actor: noMfa(f.seats.owner.memberId), roleId: blankId, code: "invoice:view" }),
      "MFA_REQUIRED",
    );
  });

  it("system roles are read-only", async () => {
    await expectDenied(
      grantPermission({ tenantId: f.tenantId, actor: f.seats.owner.actor, roleId: f.roleId("employee"), code: "invoice:view" }),
      "FORBIDDEN",
      /read-only/,
    );
    await expectDenied(
      revokePermission({ tenantId: f.tenantId, actor: f.seats.owner.actor, roleId: f.roleId("employee"), code: "issue:view" }),
      "FORBIDDEN",
      /read-only/,
    );
  });

  it("admin grants what they hold to the blank role; cannot grant what they lack (audited)", async () => {
    await grantPermission({ tenantId: f.tenantId, actor: f.seats.admin.actor, roleId: blankId, code: "invoice:view" });
    expect((await rowsOf(blankId)).map((r) => r.permission.code)).toEqual(["invoice:view"]);
    expect(await f.audits("permission.granted")).toHaveLength(1);

    await expectDenied(
      grantPermission({ tenantId: f.tenantId, actor: f.seats.admin.actor, roleId: blankId, code: "project:create" }),
      "FORBIDDEN",
      /project:create/,
    );
    expect((await f.audits("authz.escalation_denied")).at(-1)!.metadata).toMatchObject({
      rule: "role_edit_subset",
      codes: ["project:create"],
    });
  });

  it("rule 2: an admin cannot edit a role whose CURRENT set exceeds theirs (the CEO clone)", async () => {
    await expectDenied(
      revokePermission({ tenantId: f.tenantId, actor: f.seats.admin.actor, roleId: cloneId, code: "invoice:view" }),
      "FORBIDDEN",
    );
  });

  it("revoke on a clone leaves a TENANT_REVOKE tombstone; on a blank role the row is deleted", async () => {
    await revokePermission({ tenantId: f.tenantId, actor: f.seats.owner.actor, roleId: cloneId, code: "client:delete" });
    const tomb = (await rowsOf(cloneId)).find((r) => r.permission.code === "client:delete");
    expect(tomb?.source).toBe("TENANT_REVOKE");
    const summary = (await list(f.seats.owner.memberId)).find((r) => r.id === cloneId)!;
    expect(summary.codes).not.toContain("client:delete");
    expect(summary.revokedCodes).toEqual(["client:delete"]);
    expect((await f.audits("permission.revoked")).at(-1)!.metadata).toMatchObject({ code: "client:delete", tombstone: true });

    await revokePermission({ tenantId: f.tenantId, actor: f.seats.owner.actor, roleId: blankId, code: "invoice:view" });
    expect(await rowsOf(blankId)).toHaveLength(0);
    expect((await f.audits("permission.revoked")).at(-1)!.metadata).toMatchObject({ code: "invoice:view", tombstone: false });
  });

  it("the tombstone survives template propagation; a deleted grant is re-added as TEMPLATE", async () => {
    // Simulate a stale generation: drop a row and rewind templateVersion.
    const projectView = await f.platform.permission.findUniqueOrThrow({ where: { code: "project:view" } });
    await f.platform.rolePermission.delete({
      where: { tenantId_roleId_permissionId: { tenantId: f.tenantId, roleId: cloneId, permissionId: projectView.id } },
    });
    await f.platform.role.update({ where: { id: cloneId }, data: { templateVersion: 0 } });
    // Also rewind the CEO system role after removing one of its TEMPLATE rows.
    const memberInvite = await f.platform.permission.findUniqueOrThrow({ where: { code: "member:invite" } });
    await f.platform.rolePermission.delete({
      where: { tenantId_roleId_permissionId: { tenantId: f.tenantId, roleId: f.roleId("owner"), permissionId: memberInvite.id } },
    });
    await f.platform.role.update({ where: { id: f.roleId("owner") }, data: { templateVersion: 0 } });

    const before = await f.permissionsVersion();
    const result = await withTenant(f.tenantId, { type: "system" }, (tx) => propagateTemplates(tx, f.tenantId));
    expect(result.rolesTouched).toBe(2);
    expect(result.codesGranted).toBe(2);
    expect(await f.permissionsVersion()).toBe(before + 1);

    const cloneRows = await rowsOf(cloneId);
    expect(cloneRows.find((r) => r.permission.code === "client:delete")?.source).toBe("TENANT_REVOKE");
    expect(cloneRows.find((r) => r.permission.code === "project:view")?.source).toBe("TEMPLATE");
    // ✦ codes still never reach the clone.
    expect(cloneRows.some((r) => r.permission.code === "role:edit")).toBe(false);
    expect((await f.platform.role.findUniqueOrThrow({ where: { id: cloneId } })).templateVersion).toBe(TEMPLATE_VERSION);

    const ceoRows = await rowsOf(f.roleId("owner"));
    expect(ceoRows.find((r) => r.permission.code === "member:invite")?.source).toBe("TEMPLATE");
    expect(ceoRows).toHaveLength(PERMISSIONS.filter((p) => !p.deprecated).length);

    const updates = await f.audits("role.updated");
    expect(updates).toHaveLength(2);
    expect(updates.every((u) => u.actorType === "SYSTEM")).toBe(true);
    expect(updates.map((u) => (u.metadata as { granted: string[] }).granted).flat().sort()).toEqual([
      "member:invite",
      "project:view",
    ]);

    // Idempotent: nothing left to do.
    const again = await withTenant(f.tenantId, { type: "system" }, (tx) => propagateTemplates(tx, f.tenantId));
    expect(again).toEqual({ rolesTouched: 0, codesGranted: 0 });
  });

  it("re-granting a tombstoned code flips it back to TENANT_GRANT", async () => {
    await grantPermission({ tenantId: f.tenantId, actor: f.seats.owner.actor, roleId: cloneId, code: "client:delete" });
    expect((await rowsOf(cloneId)).find((r) => r.permission.code === "client:delete")?.source).toBe("TENANT_GRANT");
  });

  it("setRolePermissions diffs to exactly the requested set; effective set of a holder follows", async () => {
    const r = await setRolePermissions({
      tenantId: f.tenantId,
      actor: f.seats.admin.actor,
      roleId: blankId,
      codes: ["invoice:view", "invoice:create"],
    });
    expect(r.granted.sort()).toEqual(["invoice:create", "invoice:view"]);
    expect(r.revoked).toEqual([]);
    await assignRole({ tenantId: f.tenantId, actor: f.seats.owner.actor, memberId: f.seats.employee.memberId, roleId: blankId });
    await withTenant(f.tenantId, { type: "member", id: f.seats.employee.memberId }, async (tx) => {
      const held = await effectivePermissions(tx, f.seats.employee.memberId);
      expect(held.has("invoice:create")).toBe(true);
    });
    const r2 = await setRolePermissions({ tenantId: f.tenantId, actor: f.seats.admin.actor, roleId: blankId, codes: ["invoice:view"] });
    expect(r2.revoked).toEqual(["invoice:create"]);
    await withTenant(f.tenantId, { type: "member", id: f.seats.employee.memberId }, async (tx) => {
      const held = await effectivePermissions(tx, f.seats.employee.memberId);
      expect(held.has("invoice:create")).toBe(false);
    });
  });

  it("unknown code → NOT_FOUND", async () => {
    await expectDenied(
      grantPermission({ tenantId: f.tenantId, actor: f.seats.owner.actor, roleId: blankId, code: "made:up" }),
      "NOT_FOUND",
    );
  });
});

describe("deleteRole (role:delete, §7.2)", () => {
  it("system role → FORBIDDEN; assigned custom role → FORBIDDEN", async () => {
    await expectDenied(
      deleteRole({ tenantId: f.tenantId, actor: f.seats.owner.actor, roleId: f.roleId("employee") }),
      "FORBIDDEN",
      /read-only/,
    );
    await expectDenied(
      deleteRole({ tenantId: f.tenantId, actor: f.seats.owner.actor, roleId: blankId }),
      "FORBIDDEN",
      /assigned to 1 member/,
    );
  });

  it("an unassigned custom role is deleted with its permission rows; audited; version bumped", async () => {
    const before = await f.permissionsVersion();
    await deleteRole({ tenantId: f.tenantId, actor: f.seats.admin.actor, roleId: cloneId });
    expect(await f.platform.role.count({ where: { id: cloneId } })).toBe(0);
    expect(await rowsOf(cloneId)).toHaveLength(0);
    expect(await f.audits("role.deleted")).toHaveLength(1);
    expect(await f.permissionsVersion()).toBe(before + 1);
  });

  it("an employee (no role:delete) is refused", async () => {
    await expectDenied(
      deleteRole({ tenantId: f.tenantId, actor: f.seats.employee.actor, roleId: blankId }),
      "FORBIDDEN",
    );
  });
});
