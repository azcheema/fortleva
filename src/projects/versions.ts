import { record } from "@/audit/record";
import { assertInScope, type MemberActor } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { clean } from "@/clients/service";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { fail, isUniqueViolation } from "@/lib/domain-error";
import { newId } from "@/lib/ids";

import type { ProjectCtx } from "./service";

/**
 * ProjectVersion — what shipped when (DATA_MODEL.md §6.5). Structural-
 * status gate: no visibility column; SHIPPED ⇒ client-visible once the
 * project's portal is on. project:manage_versions for every write;
 * approvals are Phase 3 (contact-writable columns).
 */

const principalOf = (ctx: ProjectCtx) =>
  ({ type: "member", id: ctx.actor.memberId }) as const;

const PERMISSION = "project:manage_versions";

async function loadVersion(tx: TenantDb, actor: MemberActor, versionId: string) {
  const v = await tx.projectVersion.findFirst({ where: { id: versionId } });
  if (!v) deny("NOT_FOUND");
  await assertInScope(tx, actor, { projectId: v!.projectId });
  return v!;
}

export type VersionInput = {
  projectId: string;
  version: string;
  title?: string | null;
  releaseNotes?: string | null;
};

/** A DRAFT version row. `version` is free text ("1.4", "2026-W33"), unique per project. */
export async function createVersion(ctx: ProjectCtx, input: VersionInput): Promise<{ id: string }> {
  const version = clean(input.version);
  if (!version || version.length > 64) fail("INVALID_INPUT", "version");
  const id = newId();
  await withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, PERMISSION);
    await assertInScope(tx, ctx.actor, { projectId: input.projectId });
    const project = await tx.project.findFirst({
      where: { id: input.projectId },
      select: { clientId: true, status: true },
    });
    if (!project) deny("NOT_FOUND");
    if (project!.status === "ARCHIVED") fail("ARCHIVED");
    try {
      await tx.projectVersion.create({
        data: {
          id,
          tenantId: ctx.tenantId,
          clientId: project!.clientId,
          projectId: input.projectId,
          version: version!,
          title: clean(input.title),
          releaseNotes: clean(input.releaseNotes),
          createdByMemberId: ctx.actor.memberId,
        },
      });
    } catch (e) {
      if (isUniqueViolation(e)) fail("VERSION_TAKEN", version!);
      throw e;
    }
    await record(tx, {
      action: "project_version.created",
      targetType: "ProjectVersion",
      targetId: id,
      metadata: { projectId: input.projectId, version },
    });
  });
  return { id };
}

export type VersionPatch = Partial<{
  version: string;
  title: string | null;
  releaseNotes: string | null;
}>;

/** Title/notes stay editable after shipping (release notes get corrected); the version label only while DRAFT. */
export async function updateVersion(
  ctx: ProjectCtx,
  versionId: string,
  patch: VersionPatch,
): Promise<{ changed: string[] }> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, PERMISSION);
    const v = await loadVersion(tx, ctx.actor, versionId);
    const data: Record<string, unknown> = {};
    const changed: string[] = [];
    if ("version" in patch) {
      const version = clean(patch.version);
      if (!version || version.length > 64) fail("INVALID_INPUT", "version");
      if (version !== v.version) {
        if (v.status === "SHIPPED") fail("ALREADY_SHIPPED");
        data.version = version;
        changed.push("version");
      }
    }
    if ("title" in patch && clean(patch.title) !== v.title) {
      data.title = clean(patch.title);
      changed.push("title");
    }
    if ("releaseNotes" in patch && clean(patch.releaseNotes) !== v.releaseNotes) {
      data.releaseNotes = clean(patch.releaseNotes);
      changed.push("releaseNotes");
    }
    if (changed.length === 0) return { changed };
    try {
      await tx.projectVersion.update({ where: { id: versionId }, data });
    } catch (e) {
      if (isUniqueViolation(e)) fail("VERSION_TAKEN");
      throw e;
    }
    await record(tx, {
      action: "project_version.updated",
      targetType: "ProjectVersion",
      targetId: versionId,
      metadata: { projectId: v.projectId, fields: changed },
    });
    return { changed };
  });
}

/** DRAFT → SHIPPED with shippedAt (default now). Idempotent on an already shipped row: ALREADY_SHIPPED. */
export async function shipVersion(
  ctx: ProjectCtx,
  versionId: string,
  opts: { shippedAt?: Date } = {},
): Promise<{ shippedAt: Date }> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, PERMISSION);
    const v = await loadVersion(tx, ctx.actor, versionId);
    if (v.status === "SHIPPED") fail("ALREADY_SHIPPED");
    const shippedAt = opts.shippedAt ?? new Date();
    await tx.projectVersion.update({
      where: { id: versionId },
      data: { status: "SHIPPED", shippedAt },
    });
    await record(tx, {
      action: "project_version.shipped",
      targetType: "ProjectVersion",
      targetId: versionId,
      metadata: { projectId: v.projectId, version: v.version, shippedAt: shippedAt.toISOString() },
    });
    return { shippedAt };
  });
}
