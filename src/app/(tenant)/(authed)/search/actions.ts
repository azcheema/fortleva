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

export type PaletteAnswer = {
  hits: PaletteHit[];
  /**
   * Logins were not searched because the vault is locked (founder decision
   * C65 (a)): the palette says so under its list. True on every answered
   * search by a member who could open it, whatever the query — never a
   * sign that a login matched.
   */
  vaultLocked: boolean;
  /**
   * How long the open vault this was searched under stays open, on the
   * SERVER's clock — null unless it is open. The palette drops its login
   * rows when it runs out (slice 97's security review).
   */
  vaultMsLeft: number | null;
  /**
   * That window's lock instant (ISO) — the key it is known by on every
   * surface (`useVaultDeadline`), so one window has one deadline however
   * often the palette remounts (the last review: a per-mount counter let a
   * new answer inherit an old window's deadline). Null unless open.
   */
  vaultLocksAt: string | null;
};

export async function paletteSearchAction(q: string): Promise<PaletteAnswer> {
  const { membership, actor } = await requireTenantContext();
  const outcome = await search({ tenantId: membership.tenantId, actor }, q);
  if (outcome.kind !== "results") return { hits: [], vaultLocked: false, vaultMsLeft: null, vaultLocksAt: null };
  return {
    hits: outcome.hits.map((h) => ({
      value: `${h.entityType}:${h.entityId}`,
      entityType: h.entityType,
      title: h.title,
      subtitle: h.subtitle,
      href: h.href,
    })),
    vaultLocked: outcome.vault.state === "locked",
    vaultMsLeft: outcome.vault.state === "open" ? outcome.vault.locksAt.getTime() - Date.now() : null,
    vaultLocksAt: outcome.vault.state === "open" ? outcome.vault.locksAt.toISOString() : null,
  };
}
