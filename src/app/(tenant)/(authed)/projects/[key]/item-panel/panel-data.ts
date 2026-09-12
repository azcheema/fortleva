import { AuthzError } from "@/authz/errors";
import { handleAuthzRedirect } from "@/authz/redirects";
import {
  getItemDetail,
  resolveItemDetailState,
  type ResolvedItemDetail,
  type WorkCtx,
} from "@/modules/work";
import type { StateSeedKey } from "@/lib/enum-map";

/**
 * The panel's item, for every surface that shows one: the board and
 * backlog peeks and the full page. ONE scope-checked read
 * (`getItemDetail`) — not a lookup inside the list the surface happens to
 * have loaded, which silently fails for an item the list filtered out
 * (the board drops archived items) and would let the panel's content
 * depend on the caller's query rather than on permission.
 *
 * `null` means "no item to show": an unknown number, or one outside this
 * member's scope — the same answer either way, because existence must
 * not leak (AUTHZ §4). A peek then simply does not open; the full page
 * calls `notFound()`.
 */
export async function loadPanelItem(
  ctx: WorkCtx,
  projectId: string,
  number: number,
  returnTo: string,
  t: (key: StateSeedKey) => string,
): Promise<ResolvedItemDetail | null> {
  try {
    const { item } = await getItemDetail(ctx, projectId, number);
    // The state pair resolves HERE, at the server boundary, exactly as
    // the list surfaces do it (DATA_MODEL §6.14).
    return resolveItemDetailState(item, t);
  } catch (e) {
    handleAuthzRedirect(e, returnTo); // MFA step-up, if a ✦ code ever gates a read
    if (e instanceof AuthzError) return null;
    throw e;
  }
}
