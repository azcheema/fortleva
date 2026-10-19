import { record } from "@/audit/record";
import { assertInScope, resolveScope, type MemberActor } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { accessibleCodes, requireAccess } from "@/entitlements/resolver";
import { fail } from "@/lib/domain-error";
import { newId } from "@/lib/ids";
import {
  SAVED_VIEW_MAX,
  canonicalViewQuery,
  savedViewHref,
  savedViewName,
  searchOf,
  type SavedViewKind,
  type SavedViewLink,
} from "@/lib/saved-view-plan";

import { guarded } from "./db-errors";
import { principalOf, type WorkCtx } from "./states";

/**
 * SAVED VIEWS (slice 136; founder decision C113 — design
 * docs/research/2026-10-19-slice-136-saved-views-design.md).
 *
 *   · A member names the filters they have on the Tasks page, or on one
 *     project's backlog (C113 (b)), and finds them again by name under Tasks
 *     in the left menu (C113 (c)). Opening one and changing a filter changes
 *     nothing until they press "Update view" (C113 (d)).
 *   · ONLY THEIRS (C113 (a)). The database decides that (`own_view`, a
 *     RESTRICTIVE policy keyed on the member principal); every query here
 *     also names the member — the writes too (`updateMany` / `deleteMany`
 *     on id AND member) — so a reader of this file need not know it.
 *   · Gates: `work_item:view` and `project:view` on all four gates — the
 *     codes both lists ask before they show anything — for every read and
 *     write; a backlog view's project in the member's scope to make one or
 *     to change its filters. Renaming and deleting ask no scope: a view of
 *     a project the member no longer reaches is still theirs to remove.
 *   · An impersonating operator, who runs as the member's own principal,
 *     sees the member's views as the member does and changes none.
 *   · Every write audited in its transaction (`saved_view.*`) — the ACT
 *     only: which view and its kind. Never its name, filters or project: the
 *     audit log is the workspace's (an owner's export carries every TENANT
 *     row), and a view's words and filters are its member's alone (C113 (a);
 *     the migration review's M1). No new permission code.
 *
 * Every gate awaited in sequence, never a batch leg (`authz-batches.test.ts`).
 */

const CODES = ["work_item:view", "project:view"] as const;

async function gate(tx: TenantDb, ctx: WorkCtx): Promise<void> {
  for (const code of CODES) await requireAccess(tx, ctx.tenantId, ctx.actor, code);
}

/**
 * Both codes on all four gates, answered ONCE (`accessibleCodes`: one role
 * resolution, the module reads once) — the menu's read runs on every render
 * of the signed-in layout, and the open view's on every render of its page
 * (the code review's L4). Never a batch leg.
 */
async function holds(tx: TenantDb, tenantId: string, actor: MemberActor): Promise<boolean> {
  const held = await accessibleCodes(tx, tenantId, actor, CODES);
  return CODES.every((code) => held.has(code));
}

const refuseImpersonation = (ctx: WorkCtx): void => {
  if (ctx.actor.impersonated) deny("FORBIDDEN", "impersonation never changes a member's saved views");
};

const nameOf = (raw: string): string => {
  const checked = savedViewName(raw);
  if (!checked.ok) fail(checked.code, "saved view name");
  return (checked as { name: string }).name;
};

const queryOf = (kind: SavedViewKind, raw: string, selfId: string): string => {
  const canonical = canonicalViewQuery(kind, searchOf(raw), selfId);
  if (!canonical.ok) fail("VIEW_FILTERS_INVALID");
  return (canonical as { query: string }).query;
};

/**
 * ONE MEMBER'S VIEWS, ONE AT A TIME: two saves at once could otherwise both
 * count 29 and both write, or both find a name free. A transaction-scoped
 * advisory lock (the only kind safe behind Neon's transaction pooler), in the
 * one 64-bit key space every such lock shares — the `saved_view:` prefix
 * changes the hash input, and a collision only serialises two waiters.
 */
async function lockViews(tx: TenantDb, ctx: WorkCtx): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`saved_view:${ctx.tenantId}:${ctx.actor.memberId}`}))`;
}

/** The member's view of this name, whatever its case — by Postgres's `lower()`, the fold the unique index decides with. */
async function viewNamed(tx: TenantDb, ctx: WorkCtx, name: string, exceptId: string | null): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM saved_view
    WHERE tenant_id = ${ctx.tenantId} AND member_id = ${ctx.actor.memberId}
      AND lower(name) = lower(${name}) AND id IS DISTINCT FROM ${exceptId}
    LIMIT 1`;
  return rows.length > 0;
}

type LockedView = { kind: SavedViewKind; project_id: string | null; name: string; query: string };

/** The member's own view, locked for the write; NOT_FOUND for anything else. */
async function lockedView(tx: TenantDb, ctx: WorkCtx, id: string): Promise<LockedView> {
  const [row] = await tx.$queryRaw<LockedView[]>`
    SELECT kind::text AS kind, project_id, name, query FROM saved_view
    WHERE tenant_id = ${ctx.tenantId} AND member_id = ${ctx.actor.memberId} AND id = ${id}
    FOR UPDATE`;
  if (!row) deny("NOT_FOUND");
  return row!;
}

/** A backlog's project: in the member's scope, with its key for the link. */
async function scopedProjectKey(tx: TenantDb, ctx: WorkCtx, projectId: string): Promise<string> {
  await assertInScope(tx, ctx.actor, { projectId });
  const project = await tx.project.findFirst({ where: { tenantId: ctx.tenantId, id: projectId }, select: { key: true } });
  if (!project) deny("NOT_FOUND");
  return project!.key;
}

// ── Writes ───────────────────────────────────────────────────────────

export type SavedViewInput = {
  readonly kind: SavedViewKind;
  /** A backlog's project; null for the Tasks page. */
  readonly projectId: string | null;
  readonly name: string;
  /** The list's query as its page holds it — read strictly and stored canonical. */
  readonly query: string;
};

export type SavedViewWritten = { readonly id: string; readonly name: string; readonly href: string };

/** "Save view" — a new view of the filters on screen, the member's own. */
export async function createSavedView(ctx: WorkCtx, input: SavedViewInput): Promise<SavedViewWritten> {
  refuseImpersonation(ctx);
  if ((input.kind === "BACKLOG") !== (input.projectId !== null)) fail("INVALID_INPUT", "saved view kind and project");
  const name = nameOf(input.name);
  const query = queryOf(input.kind, input.query, ctx.actor.memberId);
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await gate(tx, ctx);
      const projectKey = input.projectId === null ? null : await scopedProjectKey(tx, ctx, input.projectId);
      await lockViews(tx, ctx);
      const count = await tx.savedView.count({ where: { tenantId: ctx.tenantId, memberId: ctx.actor.memberId } });
      if (count >= SAVED_VIEW_MAX) fail("VIEW_LIMIT");
      if (await viewNamed(tx, ctx, name, null)) fail("VIEW_NAME_TAKEN");
      const id = newId();
      await tx.savedView.create({
        data: { id, tenantId: ctx.tenantId, memberId: ctx.actor.memberId, kind: input.kind, projectId: input.projectId, name, query },
        select: { id: true },
      });
      await record(tx, {
        action: "saved_view.created",
        targetType: "SavedView",
        targetId: id,
        metadata: { kind: input.kind },
      });
      return { id, name, href: savedViewHref(input.kind, projectKey, query, id) };
    }),
  );
}

/** "Update view" (C113 (d)) — the view now keeps the filters on screen. */
export async function updateSavedViewQuery(ctx: WorkCtx, id: string, rawQuery: string): Promise<SavedViewWritten & { changed: boolean }> {
  refuseImpersonation(ctx);
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await gate(tx, ctx);
      const row = await lockedView(tx, ctx, id);
      const query = queryOf(row.kind, rawQuery, ctx.actor.memberId);
      const projectKey = row.project_id === null ? null : await scopedProjectKey(tx, ctx, row.project_id);
      const href = savedViewHref(row.kind, projectKey, query, id);
      if (query === row.query) return { id, name: row.name, href, changed: false };
      await tx.savedView.updateMany({ where: { id, tenantId: ctx.tenantId, memberId: ctx.actor.memberId }, data: { query } });
      await record(tx, {
        action: "saved_view.updated",
        targetType: "SavedView",
        targetId: id,
        metadata: { kind: row.kind },
      });
      return { id, name: row.name, href, changed: true };
    }),
  );
}

/** Rename — the database decides "taken" ignoring case. No scope asked (above). */
export async function renameSavedView(ctx: WorkCtx, id: string, rawName: string): Promise<{ name: string; changed: boolean }> {
  refuseImpersonation(ctx);
  const name = nameOf(rawName);
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await gate(tx, ctx);
      await lockViews(tx, ctx);
      const row = await lockedView(tx, ctx, id);
      if (row.name === name) return { name, changed: false };
      if (await viewNamed(tx, ctx, name, id)) fail("VIEW_NAME_TAKEN");
      await tx.savedView.updateMany({ where: { id, tenantId: ctx.tenantId, memberId: ctx.actor.memberId }, data: { name } });
      await record(tx, {
        action: "saved_view.renamed",
        targetType: "SavedView",
        targetId: id,
        metadata: { kind: row.kind },
      });
      return { name, changed: true };
    }),
  );
}

/** Delete — only the view goes; no task changes. No scope asked (above). */
export async function deleteSavedView(ctx: WorkCtx, id: string): Promise<void> {
  refuseImpersonation(ctx);
  await withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await gate(tx, ctx);
    const row = await lockedView(tx, ctx, id);
    await tx.savedView.deleteMany({ where: { id, tenantId: ctx.tenantId, memberId: ctx.actor.memberId } });
    await record(tx, {
      action: "saved_view.deleted",
      targetType: "SavedView",
      targetId: id,
      metadata: { kind: row.kind },
    });
  });
}

// ── Reads ────────────────────────────────────────────────────────────

/**
 * THE LEFT MENU'S READ, inside the layout's own transaction (the member
 * principal): the member's views, by name in the reader's language. A
 * backlog view whose project the member no longer reaches STAYS — it is
 * theirs, it counts toward `SAVED_VIEW_MAX`, and the menu is the only place
 * to rename or delete it — but with NO link and NO project key (`href` and
 * `projectKey` null): its key is not shown and its link would open nothing
 * (the security review's NIT). Asks the two codes itself, so a caller that
 * forgot cannot draw them.
 */
export async function listSavedViewLinks(
  tx: TenantDb,
  tenantId: string,
  actor: MemberActor,
  locale: string,
): Promise<SavedViewLink[]> {
  if (!(await holds(tx, tenantId, actor))) return [];
  const rows = await tx.savedView.findMany({
    where: { tenantId, memberId: actor.memberId },
    select: { id: true, name: true, kind: true, query: true, projectId: true, project: { select: { key: true } } },
  });
  if (rows.length === 0) return [];
  const scope = rows.some((r) => r.projectId !== null) ? await resolveScope(tx, actor) : null;
  const reaches = (projectId: string): boolean => scope !== null && (scope.all || scope.projectIds.includes(projectId));
  const collator = new Intl.Collator(locale);
  return rows
    .map((r): SavedViewLink => {
      if (r.projectId !== null && !reaches(r.projectId)) return { id: r.id, name: r.name, kind: r.kind, projectKey: null, href: null };
      const projectKey = r.project?.key ?? null;
      return { id: r.id, name: r.name, kind: r.kind, projectKey, href: savedViewHref(r.kind, projectKey, r.query, r.id) };
    })
    .sort((a, b) => collator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The view open on a page, as its controls need it. */
export type OpenSavedView = { readonly id: string; readonly name: string; readonly query: string };

/**
 * The view a page's `?view=` names — when it is the reader's, of this list
 * (and, for a backlog, of this project). Anything else is no view: the page
 * then offers "Save view" as for none. The page has already asked its own
 * gates; this asks the two codes again so it can never answer a closed module.
 */
export async function readOpenSavedView(
  ctx: WorkCtx,
  id: string | null,
  list: { readonly kind: SavedViewKind; readonly projectId: string | null },
): Promise<OpenSavedView | null> {
  if (id === null) return null;
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    if (!(await holds(tx, ctx.tenantId, ctx.actor))) return null;
    const row = await tx.savedView.findFirst({
      where: { tenantId: ctx.tenantId, memberId: ctx.actor.memberId, id, kind: list.kind, projectId: list.projectId },
      select: { id: true, name: true, query: true },
    });
    return row;
  });
}
