"use server";

import { requireTenantContext } from "@/members/tenant-context";
import { search } from "@/search/query";
import type { SearchEntityType } from "@/search/shape";

/**
 * The palette's search, as a server action.
 *
 * It returns a FLAT, ALREADY-RANKED list and nothing else — no counts,
 * no facets, no "did you mean". The palette renders what it is given in
 * the order it is given, because the order IS the answer (`ts_rank_cd`,
 * then recency) and anything that re-sorts it has thrown the ranking
 * away.
 *
 * Tenant and member come from `requireTenantContext()`; the query is the
 * only input, and `search()` carries every gate — scope, the per-type
 * permission check, and the hydrate that drops what no longer exists.
 * There is nothing for this action to decide.
 */

export type PaletteHit = {
  /** Unique per row. cmdk selects by string equality on `value`, so two
   * rows sharing one would both light up and Enter would fire the
   * first — `type:id` cannot collide. */
  value: string;
  entityType: SearchEntityType;
  title: string;
  subtitle: string | null;
  href: string;
};

export async function paletteSearchAction(q: string): Promise<PaletteHit[]> {
  const { membership, actor } = await requireTenantContext();
  const outcome = await search({ tenantId: membership.tenantId, actor }, q);
  if (outcome.kind !== "results") return [];
  return outcome.hits.map((h) => ({
    value: `${h.entityType}:${h.entityId}`,
    entityType: h.entityType,
    title: h.title,
    subtitle: h.subtitle,
    href: h.href,
  }));
}
