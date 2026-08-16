import { randomBytes, createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";

import {
  assignRole,
  reactivateMember,
  removeRole,
  revokeInvite,
  setMemberRoles,
  suspendMember,
} from "./admin";
import { noMfa, setupTenant } from "./dbtest-fixture";

let f: Awaited<ReturnType<typeof setupTenant>>;

beforeAll(async () => {
  f = await setupTenant("admin");
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

describe("role assignment (member:manage_roles ✦, AUTHZ.md §7.1)", () => {
  it("✦: an owner without a fresh factor gets MFA_REQUIRED, not FORBIDDEN", async () => {
    await expectDenied(
      assignRole({
        tenantId: f.tenantId,
        actor: noMfa(f.seats.owner.memberId),
        memberId: f.seats.employee.memberId,
        roleId: f.roleId("manager"),
      }),
      "MFA_REQUIRED",
    );
  });

  it("a manager does not hold member:manage_roles → FORBIDDEN, no escalation row", async () => {
    await expectDenied(
      assignRole({
        tenantId: f.tenantId,
        actor: f.seats.manager.actor,
        memberId: f.seats.employee.memberId,
        roleId: f.roleId("employee"),
      }),
      "FORBIDDEN",
    );
    expect(await f.audits("authz.escalation_denied")).toHaveLength(0);
  });

  it("grant-subset: an admin cannot assign the CEO role (holds fewer codes); denial is audited", async () => {
    const before = await f.permissionsVersion();
    await expectDenied(
      assignRole({
        tenantId: f.tenantId,
        actor: f.seats.admin.actor,
        memberId: f.seats.employee.memberId,
        roleId: f.roleId("owner"),
      }),
      "FORBIDDEN",
      /cannot assign "CEO"/,
    );
    const rows = await f.audits("authz.escalation_denied");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorId).toBe(f.seats.admin.memberId);
    expect(rows[0]!.metadata).toMatchObject({ rule: "grant_subset" });
    expect(rows[0]!.targetId).toBe(f.seats.employee.memberId);
    // The mutation rolled back: no assignment, no version bump.
    expect(await f.permissionsVersion()).toBe(before);
    expect(
      await f.platform.memberRole.count({
        where: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, roleId: f.roleId("owner") },
      }),
    ).toBe(0);
  });

  it("no self-escalation: an admin cannot give themself CEO", async () => {
    await expectDenied(
      assignRole({
        tenantId: f.tenantId,
        actor: f.seats.admin.actor,
        memberId: f.seats.admin.memberId,
        roleId: f.roleId("owner"),
      }),
      "FORBIDDEN",
      /yourself/,
    );
    const rows = await f.audits("authz.escalation_denied");
    expect(rows.at(-1)!.metadata).toMatchObject({ rule: "no_self_escalation" });
  });

  it("the seeded Admin template holds no other template's full set — it can assign none of them", async () => {
    // Employee carries CME codes (project:edit …) the admin lacks: the
    // subset rule bites even "downwards". Custom roles are the way out.
    await expectDenied(
      assignRole({
        tenantId: f.tenantId,
        actor: f.seats.admin.actor,
        memberId: f.seats.manager.memberId,
        roleId: f.roleId("employee"),
      }),
      "FORBIDDEN",
      /project:/,
    );
  });

  it("the owner assigns Employee to the manager: audit + permissionsVersion bump; idempotent", async () => {
    const before = await f.permissionsVersion();
    const r = await assignRole({
      tenantId: f.tenantId,
      actor: f.seats.owner.actor,
      memberId: f.seats.manager.memberId,
      roleId: f.roleId("employee"),
    });
    expect(r.changed).toBe(true);
    expect(await f.permissionsVersion()).toBe(before + 1);
    const rows = await f.audits("member.role_assigned");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorId).toBe(f.seats.owner.memberId);
    expect(rows[0]!.metadata).toMatchObject({ roleId: f.roleId("employee") });

    const again = await assignRole({
      tenantId: f.tenantId,
      actor: f.seats.owner.actor,
      memberId: f.seats.manager.memberId,
      roleId: f.roleId("employee"),
    });
    expect(again.changed).toBe(false);
    expect(await f.audits("member.role_assigned")).toHaveLength(1);
  });

  it("removeRole writes member.role_removed", async () => {
    // The admin cannot revoke it either (same subset math) …
    await expectDenied(
      removeRole({
        tenantId: f.tenantId,
        actor: f.seats.admin.actor,
        memberId: f.seats.manager.memberId,
        roleId: f.roleId("employee"),
      }),
      "FORBIDDEN",
    );
    // … the owner can.
    const r = await removeRole({
      tenantId: f.tenantId,
      actor: f.seats.owner.actor,
      memberId: f.seats.manager.memberId,
      roleId: f.roleId("employee"),
    });
    expect(r.changed).toBe(true);
    expect(await f.audits("member.role_removed")).toHaveLength(1);
  });

  it("setMemberRoles applies the diff in one transaction (adds then removes)", async () => {
    const r = await setMemberRoles({
      tenantId: f.tenantId,
      actor: f.seats.owner.actor,
      memberId: f.seats.employee.memberId,
      roleIds: [f.roleId("manager")], // swap employee → manager
    });
    expect(r.added).toEqual([f.roleId("manager")]);
    expect(r.removed).toEqual([f.roleId("employee")]);
    const held = await f.platform.memberRole.findMany({
      where: { tenantId: f.tenantId, memberId: f.seats.employee.memberId },
    });
    expect(held.map((h) => h.roleId)).toEqual([f.roleId("manager")]);
    // Restore for later tests.
    await setMemberRoles({
      tenantId: f.tenantId,
      actor: f.seats.owner.actor,
      memberId: f.seats.employee.memberId,
      roleIds: [f.roleId("employee")],
    });
  });

  it("unknown member / role → NOT_FOUND", async () => {
    await expectDenied(
      assignRole({
        tenantId: f.tenantId,
        actor: f.seats.owner.actor,
        memberId: "00000000-0000-7000-8000-000000000000",
        roleId: f.roleId("employee"),
      }),
      "NOT_FOUND",
    );
  });
});

describe("last-owner invariant (AUTHZ.md §7.3)", () => {
  it("the sole owner cannot drop their own owner role", async () => {
    await expectDenied(
      removeRole({
        tenantId: f.tenantId,
        actor: f.seats.owner.actor,
        memberId: f.seats.owner.memberId,
        roleId: f.roleId("owner"),
      }),
      "FORBIDDEN",
      /last active owner/,
    );
    expect((await f.audits("authz.escalation_denied")).at(-1)!.metadata).toMatchObject({
      rule: "last_owner",
    });
  });

  it("the sole owner cannot be suspended (by an admin holding member:remove)", async () => {
    await expectDenied(
      suspendMember({
        tenantId: f.tenantId,
        actor: f.seats.admin.actor,
        memberId: f.seats.owner.memberId,
      }),
      "FORBIDDEN",
      /last active owner/,
    );
    const owner = await f.platform.member.findUniqueOrThrow({ where: { id: f.seats.owner.memberId } });
    expect(owner.status).toBe("ACTIVE");
  });

  it("with a second ACTIVE owner, the first can step down; two concurrent step-downs cannot both succeed", async () => {
    // Owner seats the admin as a second owner (owner holds every code).
    await assignRole({
      tenantId: f.tenantId,
      actor: f.seats.owner.actor,
      memberId: f.seats.admin.memberId,
      roleId: f.roleId("owner"),
    });
    // Both owners try to remove the OTHER at the same time: exactly one wins.
    const results = await Promise.allSettled([
      removeRole({
        tenantId: f.tenantId,
        actor: f.seats.owner.actor,
        memberId: f.seats.admin.memberId,
        roleId: f.roleId("owner"),
      }),
      removeRole({
        tenantId: f.tenantId,
        actor: f.seats.admin.actor,
        memberId: f.seats.owner.memberId,
        roleId: f.roleId("owner"),
      }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok).toHaveLength(1);
    const holders = await f.platform.memberRole.count({
      where: { tenantId: f.tenantId, roleId: f.roleId("owner") },
    });
    expect(holders).toBe(1);
    // Restore: whoever kept the owner role re-seats the original owner.
    const survivor = (await f.platform.memberRole.findFirstOrThrow({
      where: { tenantId: f.tenantId, roleId: f.roleId("owner") },
    })).memberId;
    if (survivor !== f.seats.owner.memberId) {
      await assignRole({
        tenantId: f.tenantId,
        actor: f.seats.admin.actor,
        memberId: f.seats.owner.memberId,
        roleId: f.roleId("owner"),
      });
      await removeRole({
        tenantId: f.tenantId,
        actor: f.seats.owner.actor,
        memberId: f.seats.admin.memberId,
        roleId: f.roleId("owner"),
      });
    }
    expect(
      await f.platform.memberRole.count({
        where: { tenantId: f.tenantId, roleId: f.roleId("owner"), memberId: f.seats.owner.memberId },
      }),
    ).toBe(1);
  });
});

describe("suspend / reactivate (member:remove)", () => {
  it("an employee cannot suspend anyone (no member:remove)", async () => {
    await expectDenied(
      suspendMember({
        tenantId: f.tenantId,
        actor: f.seats.employee.actor,
        memberId: f.seats.manager.memberId,
      }),
      "FORBIDDEN",
    );
  });

  it("an admin suspends the manager: status SUSPENDED, roles kept, audited; the manager's effective set is empty", async () => {
    await suspendMember({
      tenantId: f.tenantId,
      actor: f.seats.admin.actor,
      memberId: f.seats.manager.memberId,
    });
    const m = await f.platform.member.findUniqueOrThrow({ where: { id: f.seats.manager.memberId } });
    expect(m.status).toBe("SUSPENDED");
    expect(m.suspendedAt).toBeInstanceOf(Date);
    expect(
      await f.platform.memberRole.count({ where: { tenantId: f.tenantId, memberId: m.id } }),
    ).toBe(1);
    expect(await f.audits("member.suspended")).toHaveLength(1);
    // A suspended member cannot act.
    await expectDenied(
      suspendMember({ tenantId: f.tenantId, actor: f.seats.manager.actor, memberId: f.seats.employee.memberId }),
      "FORBIDDEN",
    );
  });

  it("you cannot suspend yourself", async () => {
    await expectDenied(
      suspendMember({ tenantId: f.tenantId, actor: f.seats.admin.actor, memberId: f.seats.admin.memberId }),
      "FORBIDDEN",
      /yourself/,
    );
  });

  it("reactivate (by the admin who suspended) restores ACTIVE and clears suspendedAt; audited", async () => {
    await reactivateMember({
      tenantId: f.tenantId,
      actor: f.seats.admin.actor,
      memberId: f.seats.manager.memberId,
    });
    const m = await f.platform.member.findUniqueOrThrow({ where: { id: f.seats.manager.memberId } });
    expect(m.status).toBe("ACTIVE");
    expect(m.suspendedAt).toBeNull();
    expect(await f.audits("member.reactivated")).toHaveLength(1);
  });
});

describe("invite revocation (member:invite)", () => {
  let inviteId: string;

  beforeAll(async () => {
    const invite = await f.platform.memberInvite.create({
      data: {
        tenantId: f.tenantId,
        email: `revoke-${f.tenantId.slice(0, 8)}@test.invalid`,
        proposedRoleIds: [f.roleId("employee")],
        tokenHash: createHash("sha256").update(randomBytes(16)).digest("hex"),
        invitedByMemberId: f.seats.owner.memberId,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    inviteId = invite.id;
  });

  it("an employee (no member:invite) is refused", async () => {
    await expectDenied(
      revokeInvite({ tenantId: f.tenantId, actor: f.seats.employee.actor, inviteId }),
      "FORBIDDEN",
    );
  });

  it("an admin revokes: status REVOKED + member.invite_revoked; a second revoke is refused", async () => {
    await revokeInvite({ tenantId: f.tenantId, actor: f.seats.admin.actor, inviteId });
    const inv = await f.platform.memberInvite.findUniqueOrThrow({ where: { id: inviteId } });
    expect(inv.status).toBe("REVOKED");
    const rows = await f.audits("member.invite_revoked");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.targetId).toBe(inviteId);
    await expectDenied(
      revokeInvite({ tenantId: f.tenantId, actor: f.seats.admin.actor, inviteId }),
      "FORBIDDEN",
      /REVOKED/,
    );
  });
});
