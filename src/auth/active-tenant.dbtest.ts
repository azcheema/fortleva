import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

/* eslint-disable no-restricted-imports -- dbtest exercises the raw layer */
import { getPlatformClient, runtimeClient } from "@/db/client";
import { provisionTenant } from "@/members/provisioning";
import { getActiveMembership } from "@/members/tenant-context";

import { switchActiveTenant } from "./active-tenant";

/**
 * The workspace switch is the one place a TENANT ID ARRIVES FROM A FORM,
 * so the membership check inside `switchActiveTenant` is a security
 * boundary and not a convenience. The happy path has an e2e; these are
 * the DENIALS, which nothing else covers — delete the ACTIVE test from
 * the implementation and every other gate stays green.
 *
 * Runs against the real schema and the real `app_runtime` role: `session`
 * is an AUTH-class table (no tenant RLS, `portal_deny` still applies),
 * and the read behind the check goes through `withUser`, whose
 * `member_self_select` policy is what makes a foreign id unmatchable.
 */

const run = randomUUID().slice(0, 8);
const emails = {
  owner: `switch-owner-${run}@test.invalid`,
  outsider: `switch-outsider-${run}@test.invalid`,
};

let ownerUserId = "";
let outsiderUserId = "";
let sessionId = "";
let tenantA = "";
let tenantB = "";
/** A tenant the owner is NOT a member of. */
let tenantC = "";

const platform = getPlatformClient();

const pointerOf = async (): Promise<string | null> =>
  (
    await platform.session.findUnique({
      where: { id: sessionId },
      select: { activeTenantId: true },
    })
  )?.activeTenantId ?? null;

afterAll(async () => {
  await platform.session.deleteMany({ where: { userId: { in: [ownerUserId, outsiderUserId] } } });
  for (const tenantId of [tenantA, tenantB, tenantC].filter(Boolean)) {
    await platform.memberRole.deleteMany({ where: { tenantId } });
    await platform.rolePermission.deleteMany({ where: { tenantId } });
    await platform.role.deleteMany({ where: { tenantId } });
    await platform.member.deleteMany({ where: { tenantId } });
    await platform.tenant.deleteMany({ where: { id: tenantId } });
  }
  await platform.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
  await platform.$disconnect();
  await runtimeClient.$disconnect();
});

describe("switchActiveTenant", () => {
  it("sets up: one user, ACTIVE in A and B, not a member of C", async () => {
    const owner = await platform.user.create({
      data: { name: emails.owner, email: emails.owner },
    });
    ownerUserId = owner.id;
    const outsider = await platform.user.create({
      data: { name: emails.outsider, email: emails.outsider },
    });
    outsiderUserId = outsider.id;

    ({ tenantId: tenantA } = await provisionTenant({
      name: `Switch A ${run}`,
      slug: `switch-a-${run}`,
      ownerUserId: owner.id,
    }));
    ({ tenantId: tenantB } = await provisionTenant({
      name: `Switch B ${run}`,
      slug: `switch-b-${run}`,
      ownerUserId: owner.id,
    }));
    ({ tenantId: tenantC } = await provisionTenant({
      name: `Switch C ${run}`,
      slug: `switch-c-${run}`,
      ownerUserId: outsider.id,
    }));

    const session = await platform.session.create({
      data: {
        token: `switch-${run}`,
        userId: owner.id,
        expiresAt: new Date(Date.now() + 86_400_000),
        updatedAt: new Date(),
      },
    });
    sessionId = session.id;
    expect(await pointerOf()).toBeNull();
  });

  it("writes the pointer for a tenant the caller is ACTIVE in", async () => {
    expect(await switchActiveTenant({ sessionId, userId: ownerUserId, tenantId: tenantB })).toBe(
      "ok",
    );
    expect(await pointerOf()).toBe(tenantB);
  });

  it("refuses a tenant the caller is not a member of, and writes NOTHING", async () => {
    expect(await switchActiveTenant({ sessionId, userId: ownerUserId, tenantId: tenantC })).toBe(
      "not_active_member",
    );
    // Still B: a refusal must not clear the pointer either.
    expect(await pointerOf()).toBe(tenantB);
  });

  it("refuses an id that names no tenant at all", async () => {
    expect(
      await switchActiveTenant({ sessionId, userId: ownerUserId, tenantId: randomUUID() }),
    ).toBe("not_active_member");
    expect(await pointerOf()).toBe(tenantB);
  });

  it("refuses a SUSPENDED membership — a denial, not a silent no-op", async () => {
    await platform.member.updateMany({
      where: { tenantId: tenantA, userId: ownerUserId },
      data: { status: "SUSPENDED" },
    });
    expect(await switchActiveTenant({ sessionId, userId: ownerUserId, tenantId: tenantA })).toBe(
      "not_active_member",
    );
    expect(await pointerOf()).toBe(tenantB);
    await platform.member.updateMany({
      where: { tenantId: tenantA, userId: ownerUserId },
      data: { status: "ACTIVE" },
    });
  });

  it("refuses to move a session that belongs to ANOTHER user", async () => {
    const theirs = await platform.session.create({
      data: {
        token: `switch-other-${run}`,
        userId: outsiderUserId,
        expiresAt: new Date(Date.now() + 86_400_000),
        updatedAt: new Date(),
      },
    });
    // The outsider IS an active member of C, so only the session's owner
    // is in question here — the `userId` in the update's WHERE.
    expect(
      await switchActiveTenant({ sessionId: theirs.id, userId: ownerUserId, tenantId: tenantB }),
    ).toBe("not_active_member");
    const after = await platform.session.findUnique({
      where: { id: theirs.id },
      select: { activeTenantId: true },
    });
    expect(after?.activeTenantId).toBeNull();
  });

  it("a pointer whose membership is suspended AFTER the write is ignored on read", async () => {
    expect(await pointerOf()).toBe(tenantB);
    await platform.member.updateMany({
      where: { tenantId: tenantB, userId: ownerUserId },
      data: { status: "SUSPENDED" },
    });
    // `getActiveMembership` re-derives from the database every request
    // and filters to ACTIVE before it reads the pointer, so a pointer
    // that has gone stale grants nothing — it simply stops being used.
    const session = {
      user: { id: ownerUserId },
      session: { activeTenantId: tenantB },
    } as unknown as Parameters<typeof getActiveMembership>[0];
    const active = await getActiveMembership(session);
    expect(active?.tenantId).toBe(tenantA);
    await platform.member.updateMany({
      where: { tenantId: tenantB, userId: ownerUserId },
      data: { status: "ACTIVE" },
    });
  });
});
