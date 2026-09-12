import { assertInScope } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { withTenant } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { fail } from "@/lib/domain-error";
import { normalizeDescription } from "@/lib/rich-text/normalize";
import { descriptionToken } from "./description-token";
import { writeActivity } from "./activity";
import { guarded } from "./db-errors";
import type { WorkCtx } from "./states";

/**
 * The description write path (ARC-19, PLAN 2W). The browser sends a
 * ProseMirror document; the SERVER decides what is stored and derives
 * `descriptionText` and both checklist counters from it — never the
 * client, which would otherwise put words in the search index that
 * nobody can see on the page (`src/lib/rich-text/normalize.ts`).
 *
 * A routine field edit: an activity row, no audit event — the carve-out
 * AGENTS.md records, extended by founder decision 2026-09-12 to cover a
 * field a client can see.
 */

/** Two saves by the same member inside this window share one history row. */
const COALESCE_MS = 10 * 60 * 1000;

export type DescriptionSaved = {
  readonly checklistTotal: number;
  readonly checklistDone: number;
  /** The token for the editor's NEXT save. */
  readonly token: string;
};

/** `work_item:edit` + scope; a stale base token is refused, never overwritten. */
export async function updateItemDescription(
  ctx: WorkCtx,
  itemId: string,
  input: { doc: unknown; baseToken: string },
): Promise<DescriptionSaved> {
  // Normalise BEFORE the transaction: it is pure, it is where a crafted
  // document is refused, and a refusal should cost no database work.
  const next = normalizeDescription(input.doc);
  return withTenant(ctx.tenantId, { type: "member", id: ctx.actor.memberId }, async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:edit");
      const item = await tx.workItem.findFirst({
        where: { tenantId: ctx.tenantId, id: itemId, deletedAt: null },
        select: {
          id: true,
          clientId: true,
          projectId: true,
          visibility: true,
          description: true,
        },
      });
      if (!item) deny("NOT_FOUND");
      await assertInScope(tx, ctx.actor, { projectId: item!.projectId });
      if (descriptionToken(item!.description) !== input.baseToken) fail("STALE_DESCRIPTION");

      // The read above is its own statement, so two autosaves landing
      // together would both pass it. The write therefore carries the
      // document it expects to replace: `IS NOT DISTINCT FROM` is jsonb
      // equality (key order is Postgres's, not the client's) and handles
      // the NULL case, so exactly one of two racing saves updates a row.
      const stored = next.doc === null ? null : JSON.stringify(next.doc);
      const expected = item!.description === null ? null : JSON.stringify(item!.description);
      // RETURNING, not a row count: the token this hands back is what the
      // editor carries into its NEXT save, so it must be hashed from the
      // document POSTGRES holds, never from the one this process sent
      // (see `descriptionToken` — jsonb re-orders keys). The row it
      // returns is the canonical form, at no extra round trip.
      const written = await tx.$queryRaw<{ description: unknown }[]>`
        UPDATE work_item
           SET description = ${stored}::jsonb,
               description_text = ${next.text},
               checklist_total = ${next.checklistTotal},
               checklist_done = ${next.checklistDone},
               updated_at = now()
         WHERE tenant_id = ${ctx.tenantId}
           AND id = ${item!.id}
           AND deleted_at IS NULL
           AND description IS NOT DISTINCT FROM ${expected}::jsonb
        RETURNING description`;
      if (written.length === 0) fail("STALE_DESCRIPTION");

      // History: one row per editing session, not per autosave. The field
      // is not portal-safe, so the row is INTERNAL by construction
      // (activity.ts) and the CHECK since 20260912120000 refuses it any
      // other way.
      const recent = await tx.workItemActivity.findFirst({
        where: {
          tenantId: ctx.tenantId,
          workItemId: item!.id,
          field: "description",
          actorMemberId: ctx.actor.memberId,
          createdAt: { gt: new Date(Date.now() - COALESCE_MS) },
        },
        select: { id: true },
      });
      if (!recent) await writeActivity(tx, ctx, item!, { field: "description" });

      return {
        checklistTotal: next.checklistTotal,
        checklistDone: next.checklistDone,
        token: descriptionToken(written[0]!.description ?? null),
      };
    }),
  );
}
