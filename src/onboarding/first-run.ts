import { isAuthorized, scopeWhere, type MemberActor } from "@/authz/authorize";
import { withTenant } from "@/db";
import { hasAccess } from "@/entitlements/resolver";
import { readPreferences, updatePreferences } from "@/preferences/service";

/**
 * THE GETTING-STARTED LIST on Home (Phase 6 slice 121; founder decision
 * C97 (d); design §7, R13).
 *
 * WHO SEES IT: a member holding `settings:edit` (owner, admin) — the people
 * who set a workspace up — while `onboarding.checklist` is on and at least
 * one shown step is still undone. A workspace whose steps are all done
 * never sees it; "Hide" turns it off for the whole workspace.
 *
 * EACH STEP TICKS ITSELF from the workspace's own data — existence only,
 * never a name: the company's legal name set (the invoice details); a
 * client; a project; a second member or a pending invite; a task. A step
 * LINKS to where it is done only when the viewer may do it there (its code,
 * through every gate where a module is involved); the company step is shown
 * only while the invoicing module is open to the viewer.
 *
 * NO LOGO STEP: the product has no logo upload yet (Phase 7 branding) — the
 * founder's question named one, and the slice record says so.
 *
 * Reads only, so no audit; the reads run in sequence, never as legs of one
 * batch (AGENTS.md's `Promise.all` trap, `authz-batches.test.ts`).
 */

export type FirstRunStepKey = "company" | "client" | "project" | "team" | "tasks";
export type FirstRunStep = { readonly key: FirstRunStepKey; readonly done: boolean; readonly href: string | null };
export type FirstRunList = { readonly steps: readonly FirstRunStep[]; readonly done: number };

type Ctx = { readonly tenantId: string; readonly actor: MemberActor };

export async function readFirstRunList(ctx: Ctx): Promise<FirstRunList | null> {
  return withTenant(ctx.tenantId, { type: "member", id: ctx.actor.memberId }, async (tx) => {
    if (!(await isAuthorized(tx, ctx.actor, "settings:edit"))) return null;
    const prefs = await readPreferences(tx, ctx.tenantId);
    if (!prefs.onboarding.checklist) return null;

    const steps: FirstRunStep[] = [];
    if (await hasAccess(tx, ctx.tenantId, ctx.actor, "invoice:view")) {
      const tenant = await tx.tenant.findFirst({ where: { id: ctx.tenantId }, select: { legalName: true } });
      steps.push({ key: "company", done: Boolean(tenant?.legalName?.trim()), href: "/settings/invoicing" });
    }
    const client = await tx.client.findFirst({ where: { tenantId: ctx.tenantId }, select: { id: true } });
    steps.push({
      key: "client",
      done: client !== null,
      href: (await hasAccess(tx, ctx.tenantId, ctx.actor, "client:create")) ? "/clients#new-client" : null,
    });
    // The import link's project comes from the viewer's OWN scope — a
    // custom role holding `settings:edit` without `client:view_all` must
    // never be shown another client's project key (the security review).
    // Whether ANY project exists (the step's tick) is the workspace's fact.
    const scope = await scopeWhere(tx, ctx.actor, { clientField: "clientId", projectField: "id" });
    const project = await tx.project.findFirst({
      where: { ...scope, tenantId: ctx.tenantId, status: { not: "ARCHIVED" } },
      orderBy: { createdAt: "asc" },
      select: { key: true },
    });
    const anyProject = await tx.project.findFirst({ where: { tenantId: ctx.tenantId }, select: { id: true } });
    steps.push({
      key: "project",
      done: anyProject !== null,
      href: (await hasAccess(tx, ctx.tenantId, ctx.actor, "project:create")) ? "/projects#new-project" : null,
    });
    const members = await tx.member.count({ where: { tenantId: ctx.tenantId, status: "ACTIVE" } });
    const invite = await tx.memberInvite.findFirst({
      where: { tenantId: ctx.tenantId, status: "PENDING", expiresAt: { gt: new Date() } },
      select: { id: true },
    });
    steps.push({
      key: "team",
      done: members > 1 || invite !== null,
      href: (await hasAccess(tx, ctx.tenantId, ctx.actor, "member:invite")) ? "/members" : null,
    });
    const task = await tx.workItem.findFirst({ where: { tenantId: ctx.tenantId, deletedAt: null }, select: { id: true } });
    const mayImport =
      project !== null &&
      (await hasAccess(tx, ctx.tenantId, ctx.actor, "work_item:create")) &&
      (await hasAccess(tx, ctx.tenantId, ctx.actor, "work_item:edit"));
    steps.push({ key: "tasks", done: task !== null, href: mayImport ? `/projects/${project!.key}/import` : null });

    const done = steps.filter((s) => s.done).length;
    // Every step done: nothing to say — the list disappears by itself.
    if (done === steps.length) return null;
    return { steps, done };
  });
}

/** "Hide" on the card: the workspace switch off, through the preferences' own gate and audit. */
export async function hideFirstRunList(ctx: Ctx): Promise<void> {
  await updatePreferences({ tenantId: ctx.tenantId, actor: ctx.actor }, { onboarding: { checklist: false } });
}
