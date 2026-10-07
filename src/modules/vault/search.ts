import { resolveScope } from "@/authz/authorize";
import { AuthzError } from "@/authz/errors";
import type { TenantDb } from "@/db";

import type { VaultCtx } from "./ctx";
import { enterVault } from "./door";
import { anchorInScope } from "./scope";

/**
 * THE VAULT'S HALF OF SEARCH (slice 97; founder decision C65).
 *
 * `search_index` holds a login's name, username, web address and tags
 * (migration 20261007120000 — never its notes, never a secret), and
 * `src/search/query.ts` reads it. What that reader may NOT decide on its
 * own is the vault's business, so it asks here:
 *
 *   1. WHETHER logins are in the answer at all — the vault's door
 *      (`enterVault`, C52 (a)): not while viewing as someone else,
 *      `credential:view` on all four gates, and a second factor no older
 *      than `vault.stepUpMinutes`. The list sits behind the door, names
 *      included, and search is a list.
 *   2. Which logins a hit may name, and where it goes — each checked
 *      against the LIVE row (C49's anchor rule, `anchorInScope`), not
 *      the index's copy of its anchor.
 */

/**
 * What search may do with logins for this member right now.
 *  - `open`   — they are through the door: logins are searched.
 *  - `locked` — they could open the vault (the code, on all four gates,
 *               not impersonating) but their factor is missing or stale:
 *               search says "Logins aren't searched while the vault is
 *               locked. Open the vault", on EVERY
 *               search, whether or not a login would match (C65 (a)) —
 *               so the line tells nobody what the vault holds.
 *  - `closed` — they cannot open it at all: logins are never mentioned.
 *
 * `open` carries `locksAt`, when the window this member entered under
 * closes — the same instant the vault's own pages lock at (`openVault`) —
 * so a surface that SHOWS a login can lock itself then too (slice 97's
 * security review: a results page left open must not keep login names on
 * a screen after the vault has locked).
 */
export type VaultSearchGate =
  | { readonly state: "open"; readonly locksAt: Date }
  | { readonly state: "locked" }
  | { readonly state: "closed" };

export async function vaultSearchGate(tx: TenantDb, ctx: VaultCtx): Promise<VaultSearchGate> {
  try {
    const { stepUpMinutes } = await enterVault(tx, ctx, "credential:view");
    const verifiedAt = ctx.actor.mfa?.verifiedAt;
    // Unreachable after the door, which refuses a missing stamp — but a
    // lock time is never computed from nothing.
    if (!verifiedAt) return { state: "locked" };
    return { state: "open", locksAt: new Date(verifiedAt.getTime() + stepUpMinutes * 60_000) };
  } catch (e) {
    // Only a refusal answers; anything else (a dead connection) must
    // surface, or a broken gate would look like a locked vault.
    if (!(e instanceof AuthzError)) throw e;
    // The door checks the window LAST — after impersonation and the
    // permission on all four gates — so MFA_REQUIRED means exactly
    // "could open it, with a fresh factor".
    return e.reason === "MFA_REQUIRED" ? { state: "locked" } : { state: "closed" };
  }
}

/** A login a search hit may show: where it opens, and the line under its name. */
export type LoginHit = {
  readonly href: string;
  /** The login's PLACE — its project's key, its client's name — or null for our own. */
  readonly place: string | null;
};

/**
 * The hydrate for logins: of `ids` (index hits), the ones that still exist
 * (not binned), that THIS member reaches by the live row's anchor, and
 * where each opens. Anything else is simply absent from the map, and the
 * caller drops the hit.
 *
 * It ENTERS THE DOOR ITSELF, rather than trusting that the caller did:
 * this function names logins, and every export of this module gates
 * (`vault-boundary.test.ts`). A refusal — the window closed a moment
 * after the gate was asked — answers an empty map, never an error: the
 * search still answers, without logins.
 *
 * The address is `/vault`'s one-place view the login lives in, with
 * `#credential-<id>` — the row's own id (`vault-row.tsx`), so the browser
 * scrolls to it:
 *   - a client's login, its own or one of its projects' →
 *     `/vault?client=<clientId>`;
 *   - our own → `/vault?client=agency`.
 * Both views are never capped, and need nothing but the door: the
 * client's and the project's Vault tabs also need `client:view` /
 * `project:view`, so under a custom role holding `credential:view` alone
 * a hit there would open a 404 (slice 97's reviews). Ids only, never user
 * text, so no hit can become an off-site link.
 */
export async function liveLoginHits(
  tx: TenantDb,
  ctx: VaultCtx,
  ids: readonly string[],
): Promise<ReadonlyMap<string, LoginHit>> {
  const out = new Map<string, LoginHit>();
  if (ids.length === 0) return out;
  try {
    await enterVault(tx, ctx, "credential:view");
  } catch (e) {
    if (e instanceof AuthzError) return out;
    throw e;
  }
  // In SEQUENCE after the door — never a leg of a batch on this
  // transaction's one connection (AGENTS.md's standing trap).
  const scope = await resolveScope(tx, ctx.actor);
  const rows = await tx.credentialItem.findMany({
    where: { tenantId: ctx.tenantId, id: { in: [...ids] }, deletedAt: null },
    select: {
      id: true,
      clientId: true,
      projectId: true,
      client: { select: { name: true } },
      project: { select: { key: true } },
    },
  });
  for (const row of rows) {
    if (!anchorInScope(scope, { clientId: row.clientId, projectId: row.projectId })) continue;
    const anchor = `#credential-${row.id}`;
    if (row.clientId === null) {
      // Our own: no client and (a CHECK) no project.
      out.set(row.id, { href: `/vault?client=agency${anchor}`, place: null });
    } else {
      out.set(row.id, {
        href: `/vault?client=${row.clientId}${anchor}`,
        place: row.project?.key ?? row.client?.name ?? null,
      });
    }
  }
  return out;
}
