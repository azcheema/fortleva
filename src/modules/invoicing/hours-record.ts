import type { TenantDb } from "@/db";
import { isoDateOf } from "@/lib/duration";
import { namedTaskShared } from "@/modules/time/reports";

/**
 * THE HOURS AN INVOICE BILLED — its record and its marks (Phase 4 slice 110;
 * founder decisions C75 (a), C80 (e), (f)). Helpers every invoicing verb that
 * touches hours shares, inside the caller's transaction and after the caller's
 * gates and invoice lock (the one lock order: the invoice FIRST, then the
 * hours by id, then lines, records and marks — migration 20261010180000's
 * header).
 *
 * Two things, never confused:
 *   - the MARK — `time_entry.invoice_line_id`, the line an hour is on NOW;
 *   - the RECORD — `invoice_line_time_entry`, what a line billed, as a
 *     snapshot of the hour when it was added; never rewritten. A freed or
 *     re-billed hour leaves an issued invoice's record standing.
 *
 * Billed hours are never locked (C75 (a)): nothing here stops an edit of an
 * hour. And nothing here shows a CHANGED hour on an issued invoice (C80 (e) —
 * the warning is the time grid's): the Hours card reads the record, and only
 * where each hour's MARK is now (the design review's M7).
 */

/** At most this many rows on an invoice's Hours card; the rest are counted. */
export const INVOICE_HOURS_CARD_MAX = 500;

/**
 * Lock every hour marked on `invoiceId`'s lines, by id. A credit note's issue
 * calls it right after locking the invoice it credits, before the series is
 * taken: freeing them later then never waits behind a member's edit (the
 * design review's M2).
 */
export async function lockInvoiceHours(tx: TenantDb, tenantId: string, invoiceId: string): Promise<string[]> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT e.id
      FROM time_entry e
      JOIN invoice_line l ON l.tenant_id = e.tenant_id AND l.id = e.invoice_line_id
     WHERE e.tenant_id = ${tenantId} AND l.invoice_id = ${invoiceId}
     ORDER BY e.id
       FOR UPDATE OF e`;
  return rows.map((r) => r.id);
}

/** A credit in full frees the hours (C80 (f)): every mark on `invoiceId`'s lines cleared. Returns how many. */
export async function freeInvoiceHours(tx: TenantDb, tenantId: string, invoiceId: string): Promise<number> {
  const freed = await tx.timeEntry.updateMany({
    where: { tenantId, invoiceLine: { invoiceId } },
    data: { invoiceLineId: null },
  });
  return freed.count;
}

/**
 * A DRAFT's hours back on the ready list, before their line (or the draft) is
 * deleted — the FK RESTRICTs it otherwise (Prisma cannot express `SET NULL
 * (column)` on the composite key). Locked by id first. Their records go with
 * the line, by its cascade. Returns how many.
 */
export async function releaseDraftHours(
  tx: TenantDb,
  tenantId: string,
  where: { readonly lineId: string } | { readonly invoiceId: string },
): Promise<number> {
  const rows =
    "lineId" in where
      ? await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM time_entry
           WHERE tenant_id = ${tenantId} AND invoice_line_id = ${where.lineId}
           ORDER BY id
             FOR UPDATE`
      : await tx.$queryRaw<{ id: string }[]>`
          SELECT e.id
            FROM time_entry e
            JOIN invoice_line l ON l.tenant_id = e.tenant_id AND l.id = e.invoice_line_id
           WHERE e.tenant_id = ${tenantId} AND l.invoice_id = ${where.invoiceId}
           ORDER BY e.id
             FOR UPDATE OF e`;
  if (rows.length === 0) return 0;
  const released = await tx.timeEntry.updateMany({
    where: { tenantId, id: { in: rows.map((r) => r.id) } },
    data: { invoiceLineId: null },
  });
  return released.count;
}

/**
 * THE CORRECTED COPY TAKES THE HOURS (C77 (c), C80 (f); the design review's
 * H1). Called by `creditInFull` after the original was credited in full in
 * this very transaction (its issue kept the hours marked), with the copy's
 * lines already written as the original's, in order. Every hour still marked
 * on an original line moves onto the copy's line in the same place, its
 * record copied exactly — an hour edited, moved or deleted since it was
 * billed moves too: the copy bills what the original did. The database
 * accepts this only under `app.invoice_copy_of` (both guards). Returns how
 * many hours moved.
 */
export async function moveHoursToCopy(tx: TenantDb, tenantId: string, originalId: string, copyId: string): Promise<number> {
  const order = [{ position: "asc" as const }, { id: "asc" as const }];
  const from = await tx.invoiceLine.findMany({ where: { invoiceId: originalId }, orderBy: order, select: { id: true } });
  const to = await tx.invoiceLine.findMany({ where: { invoiceId: copyId }, orderBy: order, select: { id: true, clientId: true } });
  if (from.length !== to.length) throw new Error("moveHoursToCopy: the copy's lines are not the original's");
  await tx.$executeRaw`SELECT set_config('app.invoice_copy_of', ${originalId}, true)`;
  let moved = 0;
  // In sequence: one transaction, one connection (AGENTS.md's trap).
  for (let i = 0; i < from.length; i += 1) {
    const marked = await tx.timeEntry.findMany({ where: { tenantId, invoiceLineId: from[i]!.id }, select: { id: true } });
    if (marked.length === 0) continue;
    const ids = new Set(marked.map((m) => m.id));
    const records = await tx.invoiceLineTimeEntry.findMany({
      where: { invoiceLineId: from[i]!.id },
      select: {
        timeEntryId: true,
        projectId: true,
        workItemId: true,
        localDate: true,
        rawSeconds: true,
        billedSeconds: true,
        billRate: true,
      },
    });
    const copied = records.filter((r) => ids.has(r.timeEntryId));
    if (copied.length > 0) {
      await tx.invoiceLineTimeEntry.createMany({
        data: copied.map((r) => ({
          tenantId,
          clientId: to[i]!.clientId,
          invoiceId: copyId,
          invoiceLineId: to[i]!.id,
          timeEntryId: r.timeEntryId,
          projectId: r.projectId,
          workItemId: r.workItemId,
          localDate: r.localDate,
          rawSeconds: r.rawSeconds,
          billedSeconds: r.billedSeconds,
          billRate: r.billRate,
        })),
      });
    }
    const u = await tx.timeEntry.updateMany({ where: { tenantId, id: { in: [...ids] } }, data: { invoiceLineId: to[i]!.id } });
    moved += u.count;
  }
  // Reset on success only: the setting is transaction-local, so a failure
  // takes it with the transaction — and a reset in a `finally` would run in
  // an aborted transaction and replace the guard's own message with 25P02
  // (both reviews' low).
  await tx.$executeRaw`SELECT set_config('app.invoice_copy_of', '', true)`;
  return moved;
}

/** Which of `workItemIds` a client may see named now — the time report's ONE rule (`namedTaskShared`). */
export async function sharedTasks(
  tx: TenantDb,
  tenantId: string,
  items: readonly { readonly id: string; readonly visibility: string; readonly deletedAt: Date | null; readonly parentId: string | null; readonly rootId: string | null }[],
): Promise<Set<string>> {
  // A SOFT-DELETED task is named only while the tasks above it are still
  // shared (reports.ts's note) — their visibility read in one statement.
  const ancestorIds = [
    ...new Set(items.flatMap((w) => (w.deletedAt !== null ? [w.parentId, w.rootId] : [])).filter((x): x is string => !!x)),
  ];
  const ancestors = new Map(
    ancestorIds.length === 0
      ? []
      : (
          await tx.workItem.findMany({ where: { tenantId, id: { in: ancestorIds } }, select: { id: true, visibility: true } })
        ).map((a) => [a.id, a.visibility] as const),
  );
  const shared = new Set<string>();
  for (const w of items) {
    const ok = namedTaskShared({
      visibility: w.visibility,
      deleted: w.deletedAt !== null,
      ancestors: [w.parentId, w.rootId === w.id ? null : w.rootId].map((a) => (a === null ? null : (ancestors.get(a) ?? "INTERNAL"))),
    });
    if (ok) shared.add(w.id);
  }
  return shared;
}

/** What issuing a draft needs to know about its hours (`issue.ts` — the dialog and the issue alike). */
export type HoursIssueFacts = {
  /** Hours changed since they were added — deleted, another length, day, project or rate, no longer billable. A caution. */
  readonly changed: number;
  /** Lines (by position) whose text names a task of their hours that the client may not see now (the design review's M8). A blocker. */
  readonly privateTaskLines: readonly number[];
  /** Some hour the record names is not marked on that line (the database refuses the issue: `INVOICE_HOURS_MISMATCH`). A blocker. */
  readonly mismatch: boolean;
};

const NO_HOURS: HoursIssueFacts = { changed: 0, privateTaskLines: [], mismatch: false };

/**
 * What issuing needs to know of a draft's hours, in the database: how many
 * changed since they were added, whether any is no longer marked on its line
 * (one statement over every record, however many — the security review's
 * low), and which lines still carry the GENERATED text of a task the client
 * may not see now.
 *
 * The private-task test matches the text the line builder writes for a task
 * — its title, or "title — project" — never a substring (the code review's
 * medium: a project "Website design" with an internal task "Design" made the
 * default one-line-per-project text look like a private task's). A title a
 * member typed into a line by hand is theirs to have written.
 */
export async function readHoursIssueFacts(tx: TenantDb, tenantId: string, invoiceId: string): Promise<HoursIssueFacts> {
  const facts = await tx.$queryRaw<{ n: number; changed: number; mismatch: boolean | null }[]>`
    SELECT count(*)::int AS n,
           count(*) FILTER (WHERE e.id IS NULL OR e.deleted_at IS NOT NULL OR NOT e.billable
                               OR e.duration_seconds IS DISTINCT FROM h.raw_seconds
                               OR e.project_id IS DISTINCT FROM h.project_id
                               OR e.local_date IS DISTINCT FROM h.local_date
                               OR e.bill_rate IS DISTINCT FROM h.bill_rate)::int AS changed,
           bool_or(e.id IS NULL OR e.invoice_line_id IS DISTINCT FROM h.invoice_line_id) AS mismatch
      FROM invoice_line_time_entry h
      LEFT JOIN time_entry e ON e.tenant_id = h.tenant_id AND e.id = h.time_entry_id
     WHERE h.tenant_id = ${tenantId} AND h.invoice_id = ${invoiceId}`;
  const f = facts[0];
  if (!f || f.n === 0) return NO_HOURS;
  // The tasks recorded per line — distinct pairs, never every record.
  const pairs = await tx.$queryRaw<{ line_id: string; work_item_id: string }[]>`
    SELECT DISTINCT h.invoice_line_id AS line_id, h.work_item_id
      FROM invoice_line_time_entry h
     WHERE h.tenant_id = ${tenantId} AND h.invoice_id = ${invoiceId} AND h.work_item_id IS NOT NULL`;
  const privateTaskLines: number[] = [];
  if (pairs.length > 0) {
    const taskIds = [...new Set(pairs.map((p) => p.work_item_id))];
    const tasks = await tx.workItem.findMany({
      where: { tenantId, id: { in: taskIds } },
      select: { id: true, title: true, visibility: true, deletedAt: true, parentId: true, rootId: true },
    });
    const shared = await sharedTasks(tx, tenantId, tasks);
    const hidden = new Map(tasks.filter((t) => !shared.has(t.id)).map((t) => [t.id, t.title.slice(0, 2000).trim().toLowerCase()] as const));
    if (hidden.size > 0) {
      const lines = await tx.invoiceLine.findMany({ where: { invoiceId }, select: { id: true, position: true, description: true } });
      for (const line of lines) {
        const text = line.description.trim().toLowerCase();
        const named = pairs.some((p) => {
          const title = p.line_id === line.id ? hidden.get(p.work_item_id) : undefined;
          return title !== undefined && title !== "" && (text === title || text.startsWith(`${title} — `));
        });
        if (named) privateTaskLines.push(line.position);
      }
      privateTaskLines.sort((a, b) => a - b);
    }
  }
  return { changed: f.changed, privateTaskLines, mismatch: f.mismatch === true };
}

/** Where an hour an invoice billed is NOW — its mark, never its edits (C80 (e); the design review's M7). */
export type InvoiceHourState =
  | { readonly kind: "here" }
  | { readonly kind: "returned" }
  | { readonly kind: "billedElsewhere" }
  | { readonly kind: "wontInvoice" }
  | { readonly kind: "other"; readonly invoiceId: string; readonly number: string | null; readonly draft: boolean }
  /** On an invoice of ANOTHER client (the hour was moved there and billed): named nowhere here (the security review's nit). */
  | { readonly kind: "otherClient" }
  /**
   * A split's second half, carrying this invoice's mark with no record of its
   * own (the design review's M6): listed so it can be returned by hand after a
   * part credit (the code review's low). Its length is the hour's now.
   */
  | { readonly kind: "splitHere" };

export type InvoiceHourRow = {
  readonly entryId: string;
  readonly lineId: string;
  /** `YYYY-MM-DD` — as recorded. */
  readonly date: string;
  readonly member: string | null;
  /** The task, for the team ("KEY-12 Title") — this card is never the client's. */
  readonly task: string | null;
  readonly projectKey: string | null;
  readonly rawSeconds: number;
  readonly billedSeconds: number;
  readonly state: InvoiceHourState;
};

export type InvoiceHours = {
  readonly rows: readonly InvoiceHourRow[];
  /** How many rows there are past the card's limit. */
  readonly more: number;
  /** Hours recorded per line id — "From N hours" under a line. */
  readonly perLine: Readonly<Record<string, number>>;
  /** Hours still marked on this invoice. */
  readonly here: number;
};

/** The invoice's Hours card: its record, and where each hour's mark is now. Null when it billed no hours. */
export async function readInvoiceHours(tx: TenantDb, tenantId: string, invoiceId: string): Promise<InvoiceHours | null> {
  const total = await tx.invoiceLineTimeEntry.count({ where: { invoiceId } });
  if (total === 0) return null;
  const own = await tx.invoice.findFirst({ where: { id: invoiceId }, select: { clientId: true } });
  const perLineRows = await tx.invoiceLineTimeEntry.groupBy({ by: ["invoiceLineId"], where: { invoiceId }, _count: { _all: true } });
  const perLine: Record<string, number> = {};
  for (const p of perLineRows) perLine[p.invoiceLineId] = p._count._all;
  const records = await tx.invoiceLineTimeEntry.findMany({
    where: { invoiceId },
    orderBy: [{ localDate: "asc" }, { timeEntryId: "asc" }],
    take: INVOICE_HOURS_CARD_MAX,
    select: { invoiceLineId: true, timeEntryId: true, projectId: true, workItemId: true, localDate: true, rawSeconds: true, billedSeconds: true },
  });
  const entryIds = records.map((r) => r.timeEntryId);
  const entries = new Map(
    (
      await tx.timeEntry.findMany({
        where: { tenantId, id: { in: entryIds } },
        select: {
          id: true,
          invoiceLineId: true,
          billedExternallyAt: true,
          writtenOffAt: true,
          member: { select: { user: { select: { name: true } } } },
          invoiceLine: { select: { invoiceId: true, invoice: { select: { displayNumber: true, status: true, clientId: true } } } },
        },
      })
    ).map((e) => [e.id, e] as const),
  );
  const taskIds = [...new Set(records.map((r) => r.workItemId).filter((x): x is string => !!x))];
  const tasks = new Map(
    taskIds.length === 0
      ? []
      : (
          await tx.workItem.findMany({
            where: { tenantId, id: { in: taskIds } },
            select: { id: true, number: true, title: true, project: { select: { key: true } } },
          })
        ).map((w) => [w.id, `${w.project.key}-${w.number} ${w.title}`] as const),
  );
  const projectIds = [...new Set(records.map((r) => r.projectId))];
  const projects = new Map(
    (await tx.project.findMany({ where: { tenantId, id: { in: projectIds } }, select: { id: true, key: true } })).map((p) => [p.id, p.key] as const),
  );
  // Every hour still marked here, counted beyond the card's limit too.
  const here = await tx.timeEntry.count({ where: { tenantId, invoiceLine: { invoiceId } } });
  const rows: InvoiceHourRow[] = records.map((r) => {
    const e = entries.get(r.timeEntryId);
    let state: InvoiceHourState;
    if (!e) state = { kind: "returned" };
    else if (e.invoiceLine && e.invoiceLine.invoiceId === invoiceId) state = { kind: "here" };
    else if (e.invoiceLine && e.invoiceLine.invoice.clientId !== own?.clientId) state = { kind: "otherClient" };
    else if (e.invoiceLine) {
      state = {
        kind: "other",
        invoiceId: e.invoiceLine.invoiceId,
        number: e.invoiceLine.invoice.displayNumber,
        draft: e.invoiceLine.invoice.status === "DRAFT",
      };
    } else if (e.billedExternallyAt !== null) state = { kind: "billedElsewhere" };
    else if (e.writtenOffAt !== null) state = { kind: "wontInvoice" };
    else state = { kind: "returned" };
    return {
      entryId: r.timeEntryId,
      lineId: r.invoiceLineId,
      date: isoDateOf(r.localDate),
      member: e?.member.user.name?.trim() || null,
      task: r.workItemId ? (tasks.get(r.workItemId) ?? null) : null,
      projectKey: projects.get(r.projectId) ?? null,
      rawSeconds: r.rawSeconds,
      billedSeconds: r.billedSeconds,
      state,
    };
  });
  // A split's second halves: marked here, with no record of this invoice.
  const unrecordedTotal = await tx.timeEntry.count({ where: { tenantId, invoiceLine: { invoiceId }, billedOn: { none: { invoiceId } } } });
  const room = Math.max(0, INVOICE_HOURS_CARD_MAX - rows.length);
  if (unrecordedTotal > 0 && room > 0) {
    const halves = await tx.timeEntry.findMany({
      where: { tenantId, invoiceLine: { invoiceId }, billedOn: { none: { invoiceId } } },
      orderBy: [{ localDate: "asc" }, { id: "asc" }],
      take: room,
      select: {
        id: true,
        invoiceLineId: true,
        localDate: true,
        durationSeconds: true,
        member: { select: { user: { select: { name: true } } } },
        project: { select: { key: true } },
        workItem: { select: { number: true, title: true, project: { select: { key: true } } } },
      },
    });
    for (const h of halves) {
      rows.push({
        entryId: h.id,
        lineId: h.invoiceLineId!,
        date: isoDateOf(h.localDate),
        member: h.member.user.name?.trim() || null,
        task: h.workItem ? `${h.workItem.project.key}-${h.workItem.number} ${h.workItem.title}` : null,
        projectKey: h.project?.key ?? null,
        rawSeconds: h.durationSeconds ?? 0,
        billedSeconds: h.durationSeconds ?? 0,
        state: { kind: "splitHere" },
      });
    }
  }
  return { rows, more: Math.max(0, total + unrecordedTotal - rows.length), perLine, here };
}
