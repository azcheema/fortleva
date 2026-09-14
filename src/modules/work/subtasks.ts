import type { TenantDb } from "@/db";
import type { StateSeedKey, StatusValue } from "@/lib/enum-map";

/**
 * THE READ behind the item panel's Subtasks section (slice 9): an item's
 * LIVE children, in the project's one order (rank — the same order the
 * backlog and the board columns use, §6.14), with the two counts the
 * section's meter shows. Archived children are listed (an archived
 * subtask is still the parent's work, and the counts must not disagree
 * with the rows); soft-deleted ones are not (they are gone from every
 * surface, and `deleteItem` cascades to them anyway).
 *
 * Runs INSIDE `getItemDetail`'s transaction, after `requireAccess` and
 * `assertInScope`, so the section can never list the children of an
 * item the panel refused — and, like `readItemActivity`, it is NOT
 * exported from the barrel: a row carries the STATE NAME, which the
 * portal must never show (a contact sees categories, never a tenant's
 * state names), and `portal-projections.test.ts` greps only `portal.ts`
 * files for the forbidden columns, so a portal module that merely
 * CALLED this read would pass it. Phase 3's portal lists a task's
 * visible children through `modules/work/portal.ts` with its own
 * allow-listed select under the contact principal and `portal_gate`.
 * The row carries only what the section renders — no ids the panel
 * would never show.
 *
 * Progress is the plan's rule (§3.1): DONE over everything that is not
 * CANCELLED — a cancelled subtask is neither done nor owed. The state
 * pair is RAW here, as everywhere in this module (no locale); the page
 * boundary resolves it (`resolveItemDetail`).
 *
 * A subtask has no children by construction (`CHECK depth <= 2`, and
 * SUBTASK is the lowest level), so the panel does not ask for one's.
 */

export type SubtaskEntry = {
  id: string;
  number: number;
  title: string;
  /** The column is a Postgres enum; typed as the map's keys so the section needs no guard. */
  stateCategory: StatusValue<"stateCategory">;
  /** RAW pair — see `ItemListEntry.stateName`. */
  stateName: string | null;
  stateSeedKey: StateSeedKey | null;
  assigneeName: string | null;
  visibility: "INTERNAL" | "CLIENT_VISIBLE";
  archivedAt: Date | null;
};

export type ItemSubtasks = {
  /** By rank — the project's one order. */
  rows: SubtaskEntry[];
  /** Children in a DONE state. */
  done: number;
  /** Children in any state but CANCELLED — what `done` is measured against. */
  total: number;
};

export async function readItemSubtasks(tx: TenantDb, tenantId: string, workItemId: string): Promise<ItemSubtasks> {
  const rows = await tx.workItem.findMany({
    where: { tenantId, parentId: workItemId, deletedAt: null },
    orderBy: { rank: "asc" },
    select: {
      id: true,
      number: true,
      title: true,
      stateCategory: true,
      visibility: true,
      archivedAt: true,
      state: { select: { name: true, seedKey: true } },
      assigneeMember: { select: { user: { select: { name: true } } } },
    },
  });
  let done = 0;
  let total = 0;
  for (const r of rows) {
    if (r.stateCategory === "CANCELLED") continue;
    total += 1;
    if (r.stateCategory === "DONE") done += 1;
  }
  return {
    rows: rows.map((r) => ({
      id: r.id,
      number: r.number,
      title: r.title,
      stateCategory: r.stateCategory,
      stateName: r.state.name,
      stateSeedKey: r.state.seedKey,
      assigneeName: r.assigneeMember?.user.name ?? null,
      visibility: r.visibility,
      archivedAt: r.archivedAt,
    })),
    done,
    total,
  };
}
