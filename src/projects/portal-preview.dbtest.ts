import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { withTenant } from "@/db";
import { hasAccess } from "@/entitlements/resolver";
import { setupTenant } from "@/members/dbtest-fixture";
import { setHoursSharingMode, setPortalEnabled } from "@/projects/service";

import { readPortalPreview } from "./portal-preview";

/**
 * THE MEMBER-SIDE PORTAL PREVIEW, measured against the real schema, the
 * real `app_runtime` role and a real contact principal.
 *
 * ITS CENTRAL ASSERTION IS THAT THE PREVIEW SEES LESS THAN THE MEMBER
 * DOES. Every other test in this file follows from that one: the member
 * running it holds `project:view` on the project and can read every row
 * in it, yet the panel they are shown contains only the CLIENT_VISIBLE
 * ones of a portal-enabled, unarchived project — because the read runs
 * under a synthesised CONTACT principal and `portal_gate` decides, not
 * a filter in TypeScript. A preview that ran under the member's own
 * principal would pass a shape test and fail this one.
 *
 * WHAT ONLY A DATABASE CAN SAY, and is therefore here: that flipping
 * `Project.portalEnabled` off empties the panel through a trigger and
 * ten policies rather than through an `if`; that an ARCHIVED project
 * stops publishing (founder decision, 2026-09-21); that the narrowing
 * really is a `where` and not a filter, so a second project of the same
 * client never materialises; and that the tenant's own module switch
 * reaches the contact plane.
 *
 * Tenant slugs come from `setupTenant("pview")`, and the prefix `pview-`
 * is registered in `DBTEST_PREFIXES` (e2e/fixtures/seed-cli.ts) so
 * `sweep-dbtests` can collect this suite's orphans. `e2e-` is the
 * BROWSER harness's prefix and is swept by AGE — a dbtest using it would
 * have its fixtures deleted mid-run by a concurrent e2e run.
 */

const run = randomUUID().slice(0, 8);

const S = {
  internalTask: `PVINTERNAL-${run}`,
  otherProjectTask: `PVOTHERPROJECT-${run}`,
};
const SHOWN = {
  shared: `Shared task ${run}`,
  phase: `Design ${run}`,
};

let f: Awaited<ReturnType<typeof setupTenant>>;
let clientId: string;
let projectId: string;
let secondProjectId: string;
let primaryId: string;
let collaboratorId: string;
const states: Record<string, string> = {};

const ownerCtx = () => ({ tenantId: f.tenantId, actor: f.seats.owner.actor });
const employeeCtx = () => ({ tenantId: f.tenantId, actor: f.seats.employee.actor });

let nextNumber = 1;
async function item(input: {
  projectId: string;
  title: string;
  category: "TODO" | "IN_PROGRESS" | "DONE";
  visibility: "INTERNAL" | "CLIENT_VISIBLE";
  milestoneId?: string;
  targetDate?: Date;
}): Promise<string> {
  const id = randomUUID();
  // `portalEnabled` is NEVER written here: it is trigger-derived from
  // the project (`stamp_portal_enabled`, BEFORE INSERT), which is the
  // rule AGENTS.md states and which this fixture therefore exercises.
  await f.platform.workItem.create({
    data: {
      id,
      tenantId: f.tenantId,
      clientId,
      projectId: input.projectId,
      number: nextNumber++,
      title: input.title,
      stateId: states[`${input.projectId}:${input.category}`]!,
      stateCategory: input.category,
      rootId: id,
      rank: `Zz${randomUUID().replace(/-/g, "")}1`,
      visibility: input.visibility,
      milestoneId: input.milestoneId ?? null,
      targetDate: input.targetDate ?? null,
    },
  });
  return id;
}

async function statesFor(pid: string) {
  let rank = 0;
  for (const category of ["BACKLOG", "TODO", "IN_PROGRESS", "DONE", "CANCELLED", "TRIAGE"] as const) {
    const id = randomUUID();
    states[`${pid}:${category}`] = id;
    await f.platform.workflowState.create({
      data: {
        id,
        tenantId: f.tenantId,
        projectId: pid,
        name: `${category}-${run}`,
        category,
        rank: `a${(rank++).toString().padStart(4, "0")}`,
        isDefault: category === "BACKLOG",
      },
    });
  }
}

beforeAll(async () => {
  f = await setupTenant("pview");
  clientId = randomUUID();
  projectId = randomUUID();
  secondProjectId = randomUUID();
  primaryId = randomUUID();
  collaboratorId = randomUUID();

  await f.platform.client.create({ data: { id: clientId, tenantId: f.tenantId, name: `Acme ${run}` } });
  await f.platform.project.createMany({
    data: [
      { id: projectId, tenantId: f.tenantId, clientId, key: `PVA${run.slice(0, 2).toUpperCase()}`, name: `Site ${run}`, portalEnabled: true },
      { id: secondProjectId, tenantId: f.tenantId, clientId, key: `PVB${run.slice(0, 2).toUpperCase()}`, name: `Other ${run}`, portalEnabled: true },
    ],
  });
  await statesFor(projectId);
  await statesFor(secondProjectId);

  const phaseId = randomUUID();
  await f.platform.milestone.create({
    data: {
      id: phaseId,
      tenantId: f.tenantId,
      clientId,
      projectId,
      name: SHOWN.phase,
      rank: "a0",
      visibility: "CLIENT_VISIBLE",
    },
  });

  const invitedAt = new Date("2026-09-01T09:00:00Z");
  await f.platform.contact.createMany({
    data: [
      // The COLLABORATOR was invited FIRST, so `invitedAt asc` alone
      // would pick it — which is what makes the profile preference
      // below a measurement rather than a coincidence.
      {
        id: collaboratorId,
        tenantId: f.tenantId,
        clientId,
        name: "Collab",
        email: `pv-collab-${run}@test.invalid`,
        portalProfile: "CONTACT_COLLABORATOR",
        portalStatus: "ACTIVE",
        invitedAt,
        emailVerified: true,
      },
      {
        id: primaryId,
        tenantId: f.tenantId,
        clientId,
        name: "Primary",
        email: `pv-primary-${run}@test.invalid`,
        portalProfile: "CONTACT_PRIMARY",
        portalStatus: "ACTIVE",
        invitedAt: new Date("2026-09-02T09:00:00Z"),
        emailVerified: true,
      },
      // Suspended and never-invited contacts are NOT an audience:
      // `authorizePortal()` refuses both, so counting them would tell a
      // member somebody is watching when nobody is.
      {
        id: randomUUID(),
        tenantId: f.tenantId,
        clientId,
        name: "Suspended",
        email: `pv-susp-${run}@test.invalid`,
        portalProfile: "CONTACT_PRIMARY",
        portalStatus: "SUSPENDED",
        invitedAt,
        emailVerified: true,
      },
      {
        id: randomUUID(),
        tenantId: f.tenantId,
        clientId,
        name: "Recorded only",
        email: `pv-none-${run}@test.invalid`,
        portalProfile: "CONTACT_PRIMARY",
        portalStatus: "NO_ACCESS",
      },
    ],
  });

  // THE EMPLOYEE IS ASSIGNED TO THIS PROJECT, and that is what makes the
  // refusal below a measurement of the PERMISSION rather than of scope.
  // Without it `assertInScope` denies first and the test would pass with
  // `project:edit` restored — which it did, on the mutation run.
  await f.platform.memberProject.create({
    data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, projectId },
  });

  await item({ projectId, title: SHOWN.shared, category: "TODO", visibility: "CLIENT_VISIBLE", milestoneId: phaseId });
  await item({ projectId, title: S.internalTask, category: "TODO", visibility: "INTERNAL" });
  // DATED, and EARLIER than anything in the project under test — so
  // that a narrowing which silently did nothing would put THIS project's
  // group at `projects[0]` on every run rather than on about half of
  // them (code review: the projection orders by `targetDate` then id,
  // and a v4 `randomUUID` tie-break is a coin flip).
  await item({
    projectId: secondProjectId,
    title: S.otherProjectTask,
    category: "TODO",
    visibility: "CLIENT_VISIBLE",
    targetDate: new Date("2026-01-01T00:00:00Z"),
  });
});

afterAll(async () => {
  if (f) {
    await f.platform.$executeRaw`DELETE FROM search_index WHERE tenant_id = ${f.tenantId}`;
    await f.platform.workItem.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.milestone.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.workflowState.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.memberProject.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.contact.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.project.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.client.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
    await f.cleanup();
  }
});

const titles = (p: Awaited<ReturnType<typeof readPortalPreview>>) =>
  (p.tasks?.tasks ?? []).map((t) => t.title).sort();

describe("the Portal tab's preview", () => {
  it("shows the client's view, not the member's — and names the contact it speaks for", async () => {
    const preview = await readPortalPreview(ownerCtx(), projectId);

    expect(preview.blockers).toEqual([]);
    expect(titles(preview)).toEqual([SHOWN.shared]);
    // The member can read this row all day on the Backlog; the contact
    // principal cannot, so the preview does not show it.
    expect(JSON.stringify(preview)).not.toContain(S.internalTask);
    // Neither does a second portal-enabled project of the SAME client —
    // the narrowing is a `where`, not a filter over a wider answer.
    expect(JSON.stringify(preview)).not.toContain(S.otherProjectTask);
    expect(preview.tasks?.projectId).toBe(projectId);
    expect(preview.tasks?.tasks[0]?.phase).toBe(SHOWN.phase);
    // CONTACT_PRIMARY, though the collaborator was invited first and
    // both profiles hold the capability: the pick is the WIDEST profile
    // that holds `portal.work_item.view`, derived from the frozen
    // capability table rather than named, so a profile added later is
    // ranked without touching the service.
    expect(preview.contact?.id).toBe(primaryId);
    expect(preview.contact?.profile).toBe("CONTACT_PRIMARY");
    expect(preview.audience).toBe(2);
  });

  it("empties through the switch — a trigger and ten policies, not an if", async () => {
    await setPortalEnabled(ownerCtx(), projectId, false);
    try {
      const off = await readPortalPreview(ownerCtx(), projectId);
      expect(off.blockers).toEqual(["PORTAL_OFF"]);
      expect(off.tasks).toBeNull();
      // Still an audience: nobody lost their access, the project stopped
      // publishing. Two different facts, two different remedies.
      expect(off.audience).toBe(2);
    } finally {
      await setPortalEnabled(ownerCtx(), projectId, true);
    }
    expect(titles(await readPortalPreview(ownerCtx(), projectId))).toEqual([SHOWN.shared]);
  });

  it("an ARCHIVED project stops publishing, with the switch still on", async () => {
    await f.platform.project.update({
      where: { tenantId_id: { tenantId: f.tenantId, id: projectId } },
      data: { status: "ARCHIVED", archivedAt: new Date() },
    });
    try {
      const archived = await readPortalPreview(ownerCtx(), projectId);
      expect(archived.blockers).toEqual(["PROJECT_ARCHIVED"]);
      expect(archived.tasks).toBeNull();
      // The switch is untouched, which is exactly why the member needs
      // telling: nothing on the project row says "not published".
      const row = await f.platform.project.findUniqueOrThrow({
        where: { tenantId_id: { tenantId: f.tenantId, id: projectId } },
        select: { portalEnabled: true },
      });
      expect(row.portalEnabled).toBe(true);
    } finally {
      await f.platform.project.update({
        where: { tenantId_id: { tenantId: f.tenantId, id: projectId } },
        data: { status: "ACTIVE", archivedAt: null },
      });
    }
  });

  it("reports every blocker that applies, not the first", async () => {
    await setPortalEnabled(ownerCtx(), projectId, false);
    await f.platform.contact.updateMany({
      where: { tenantId: f.tenantId, clientId },
      data: { portalStatus: "SUSPENDED" },
    });
    try {
      const preview = await readPortalPreview(ownerCtx(), projectId);
      expect([...preview.blockers].sort()).toEqual(["NO_AUDIENCE", "PORTAL_OFF"]);
      expect(preview.contact).toBeNull();
      expect(preview.audience).toBe(0);
      expect(preview.tasks).toBeNull();
    } finally {
      await f.platform.contact.updateMany({
        where: { tenantId: f.tenantId, id: { in: [primaryId, collaboratorId] } },
        data: { portalStatus: "ACTIVE" },
      });
      await setPortalEnabled(ownerCtx(), projectId, true);
    }
  });

  it("the tenant's own module switch reaches the contact plane", async () => {
    // `work`, not `portal`, and the distinction is the finding this test
    // produced. `portal.work_item.view` rides on BOTH modules
    // (`capabilities.ts`), so switching `work` off leaves the member
    // holding `project:manage_portal` — module `portal` — while the
    // contact's capability fails gate 3. That is the only shape in which
    // MODULE_OFF is reachable at all: with `portal` off the member
    // cannot open this page (the test below).
    await f.platform.tenantPreference.create({
      data: { tenantId: f.tenantId, key: "module.work.enabled", value: false },
    });
    try {
      const preview = await readPortalPreview(ownerCtx(), projectId);
      expect(preview.blockers).toEqual(["MODULE_OFF"]);
      // And the projection agrees: `authorizePortal` denies on gate 3,
      // `portalReadOrNull` swallows it, the panel is empty. The member's
      // explanation and the contact's refusal come from one verdict.
      expect(preview.tasks).toBeNull();
    } finally {
      await f.platform.tenantPreference.deleteMany({
        where: { tenantId: f.tenantId, key: "module.work.enabled" },
      });
    }
  });

  it("an unverified contact is not an audience — admission is not the same test", async () => {
    // `authorizePortal()` admits ACTIVE + invited; `portalGateDecision`
    // refuses an unverified address BEFORE any portal page runs
    // ("unverified"), so a contact who satisfies the first and not the
    // second cannot sign in at all. Counting them told the member the
    // portal was live when nobody could reach it — and suppressed the
    // NO_AUDIENCE blocker that exists to say so.
    await f.platform.contact.updateMany({
      where: { tenantId: f.tenantId, clientId },
      data: { emailVerified: false },
    });
    try {
      const preview = await readPortalPreview(ownerCtx(), projectId);
      expect(preview.audience).toBe(0);
      expect(preview.contact).toBeNull();
      expect(preview.blockers).toEqual(["NO_AUDIENCE"]);
      expect(preview.tasks).toBeNull();
    } finally {
      await f.platform.contact.updateMany({
        where: { tenantId: f.tenantId, id: { in: [primaryId, collaboratorId] } },
        data: { emailVerified: true },
      });
    }
  });

  it("everything open and nothing marked CLIENT_VISIBLE reads as NOTHING_SHARED, not as a blank panel", async () => {
    // The first state of this tab for most projects, because INTERNAL is
    // the default everywhere. Without this blocker the member saw the
    // CONTACT'S empty state — "ask your contact at the agency" — which
    // is the client's voice addressed to the agency.
    await f.platform.workItem.updateMany({
      where: { tenantId: f.tenantId, projectId, title: SHOWN.shared },
      data: { visibility: "INTERNAL" },
    });
    try {
      const preview = await readPortalPreview(ownerCtx(), projectId);
      expect(preview.blockers).toEqual(["NOTHING_SHARED"]);
      expect(preview.tasks).toBeNull();
      // The audience is intact: nobody lost access, there is simply
      // nothing to look at.
      expect(preview.audience).toBe(2);
    } finally {
      await f.platform.workItem.updateMany({
        where: { tenantId: f.tenantId, projectId, title: SHOWN.shared },
        data: { visibility: "CLIENT_VISIBLE" },
      });
    }
  });

  it("NOTHING_SHARED never stacks on a real blocker — it is the LAST word, not an extra one", async () => {
    await setPortalEnabled(ownerCtx(), projectId, false);
    try {
      const preview = await readPortalPreview(ownerCtx(), projectId);
      // The panel is empty, but "nothing is shared" is not why, and
      // saying so would send the member to fix the wrong thing.
      expect(preview.blockers).toEqual(["PORTAL_OFF"]);
    } finally {
      await setPortalEnabled(ownerCtx(), projectId, true);
    }
  });

  it("with the PORTAL module off the member gets no tab at all — the four gates, not one", async () => {
    // The wiring bug this slice found and fixed: `project:manage_portal`
    // is module `portal`, so gate 3 refuses the MEMBER before any
    // preview is computed. A tab gated on the permission alone (the
    // `isAuthorized` shape every other tab uses) stayed lit and walked
    // the member into an error boundary; it is gated on `hasAccess` now,
    // and the page turns this denial into a 404.
    await f.platform.tenantPreference.create({
      data: { tenantId: f.tenantId, key: "module.portal.enabled", value: false },
    });
    try {
      await expect(readPortalPreview(ownerCtx(), projectId)).rejects.toBeInstanceOf(AuthzError);
      const held = await withTenant(
        f.tenantId,
        { type: "member", id: f.seats.owner.memberId },
        (tx) => hasAccess(tx, f.tenantId, f.seats.owner.actor, "project:manage_portal"),
      );
      expect(held).toBe(false);
    } finally {
      await f.platform.tenantPreference.deleteMany({
        where: { tenantId: f.tenantId, key: "module.portal.enabled" },
      });
    }
  });
});

describe("project:manage_portal", () => {
  it("refuses an employee the preview, the switch and the hours mode", async () => {
    // The narrowing this slice makes: all three ran on `project:edit`
    // (C M E) until 2026-09-21, so an employee could switch a client's
    // portal on. They can still edit every other field of the project.
    await expect(readPortalPreview(employeeCtx(), projectId)).rejects.toBeInstanceOf(AuthzError);
    await expect(setPortalEnabled(employeeCtx(), projectId, false)).rejects.toBeInstanceOf(AuthzError);
    await expect(setHoursSharingMode(employeeCtx(), projectId, "HOURS")).rejects.toBeInstanceOf(
      AuthzError,
    );
    // …and nothing moved.
    const row = await f.platform.project.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: f.tenantId, id: projectId } },
      select: { portalEnabled: true, hoursSharingMode: true },
    });
    expect(row).toEqual({ portalEnabled: true, hoursSharingMode: "NONE" });
  });

  it("a project outside the member's tenant is NOT_FOUND, not a shape", async () => {
    await expect(readPortalPreview(ownerCtx(), randomUUID())).rejects.toBeInstanceOf(AuthzError);
  });
});
