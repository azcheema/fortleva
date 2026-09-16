import { AuthzError } from "@/authz/errors";
import { handleAuthzRedirect } from "@/authz/redirects";
import {
  getItemDetail,
  resolveItemDetail,
  type ResolvedItemDetailResult,
  type WorkCtx,
} from "@/modules/work";
import type { StateSeedKey } from "@/lib/enum-map";
import { canTrackTime } from "@/modules/time";

import { getTimerStateAction, type TimerPillState } from "../../../time/actions";

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
  opts: {
    /** The full page's `?before=` — the Activity page strictly older than that row. */
    activityBefore?: string;
  } = {},
): Promise<ResolvedItemDetailResult | null> {
  try {
    // The project's states come from HERE, not from the board's or the
    // backlog's `listItems` result, even where the caller has one. The
    // duplicate read is the accepted cost of the principle above: the
    // panel's content must depend on permission, never on the query the
    // surface happened to run — and on the full page there is no list
    // at all.
    const result = await getItemDetail(ctx, projectId, number, { activityBefore: opts.activityBefore });
    // Every state pair resolves HERE, at the server boundary, exactly as
    // the list surfaces do it (DATA_MODEL §6.14).
    return resolveItemDetail(result, t);
  } catch (e) {
    handleAuthzRedirect(e, returnTo); // MFA step-up, if a ✦ code ever gates a read
    if (e instanceof AuthzError) return null;
    throw e;
  }
}

/**
 * The panel's timer control's first picture (2T — UI.md §5.2 `T`): the
 * member's timer exactly as the layout's pill reads it, through the same
 * per-request `getCurrentTimerOnce`, so a peek costs no second timer read.
 *
 * `null` means "no control here": a project that is archived (the time
 * service refuses its entries — `ARCHIVED`), or a member who may not
 * track time. Permission and entitlement are asked FIRST, through
 * `canTrackTime`, so rendering a panel never runs the time module's
 * bootstrap for a member or a tenant it is not on for — the /home rule.
 * (The time ACTIONS themselves still bootstrap before they authorise, as
 * every time service entry point does; that is not this loader's to fix.)
 */
export async function loadPanelTimer(
  ctx: WorkCtx,
  project: { archivedAt: Date | null },
): Promise<TimerPillState | null> {
  if (project.archivedAt) return null;
  if (!(await canTrackTime(ctx))) return null;
  return getTimerStateAction();
}
