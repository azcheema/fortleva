import { recordMany, type AuditInput } from "@/audit/record";
import { lockCounter, nextCounters, withTenant, type TenantDb } from "@/db";
import { moduleOpenUnderSystem } from "@/entitlements/resolver";
import { DomainError } from "@/lib/domain-error";
import { dateColumn, isoDateOf, localDateString } from "@/lib/duration";
import { newId } from "@/lib/ids";
import { REPEAT_MAX_DESCRIPTION_BYTES, REPEAT_MAX_SUBTASKS, copyDueDate, isRepeatRhythm, owedCopy } from "@/lib/repeat-rules";
import { retryOnContention } from "@/lib/retry";
import { ranksBetween } from "@/lib/rank";
import { normalizeDescription, type NormalizedDescription } from "@/lib/rich-text/normalize";
import { emit } from "@/notify/emit";
import { readPreferences } from "@/preferences/service";

import { writeSystemActivityMany } from "./activity";
import { mentionableMembers } from "./mentions";
import { NIL_UUID, lockItemRow, lockPredecessor, lockProjectRanks } from "./rank-lock";
import { PROJECT_MAKES_COPIES_WHERE, copyableSubtree, descriptionBytes, projectMakesCopies } from "./repeat";
import { ensureProjectStates } from "./states";
import { untickChecklists } from "./templates/definition";

/**
 * REPEATING TASKS — THE COPIER (slice 127; founder decision C103 —
 * docs/research/2026-10-17-slice-127-repeating-tasks-design.md §3.3–§3.6).
 * The per-workspace body of the jobs route's repeat step
 * (`src/jobs/repeating-tasks.ts` finds the workspaces). Runs as SYSTEM with
 * RLS live, one workspace at a time.
 *
 * For each series whose next day has come in the workspace's zone, ONE copy
 * — for the latest repeat day on or before today (`owedCopy`): a day that
 * passed while no kick ran is not made later, so a copy is never born late,
 * and a series is never a pile of backdated tasks (§3.5). On schedule,
 * always: an earlier copy still open does not hold the next back (C103 (b)).
 *
 * WHAT A COPY IS (§3.3): the holder as it is NOW — title, description with
 * every checkbox unticked, type, kind, labels, estimate — and its live
 * subtasks by the template rule, each likewise (no dates). The copy starts
 * on its repeat day and is due the day before the next one (C103 (d)). Never
 * priority, milestone, comments, files, time, followers, a contact
 * hand-over or the stage (where new tasks start). ALWAYS INTERNAL, every row
 * written out (C103 (f) — the worst-bug default is never left to a column).
 *
 * WHO GETS IT (§3.4, C103 (c)): each row's member assignee, when that member
 * can still take it — ACTIVE, `work_item:view`, reaching the project
 * (`mentionableMembers`, pinned equal to `hasAccess` + `assertInScope`);
 * else unassigned. A person is told once a copy: about the top task if they
 * hold it, else the first subtask they hold.
 *
 * THE ONE ORDER (§3.6): the stage key (`ensureProjectStates`, first seed
 * only) → the task counter → the rank queue → the project's bottom row (FOR
 * UPDATE) → the holder's parent (FOR SHARE) → the holder (FOR SHARE) → the
 * series row (FOR UPDATE, re-read: still this holder, still owed) → the
 * writes. A person's set/stop takes the task(s) then the series — item before
 * series in both. Two kicks at once queue on the counter and the second finds
 * the series moved; the UNIQUE `(repeat_id, made_for)` is the database's belt.
 *
 * BOUNDED: the caller's deadline and a slice of its own per workspace, at
 * most `REPEAT_SERIES_CAP` series a workspace a kick (least recently touched
 * first, so one that keeps failing goes to the back — the security review's
 * M-1), each copy at most `REPEAT_MAX_SUBTASKS` tasks under it and
 * `REPEAT_MAX_DESCRIPTION_BYTES` of descriptions. One series' failure is
 * logged (ids, the error's name and code — never its message) and the next
 * runs.
 */

const SYSTEM = { type: "system" } as const;

/** The most series one workspace copies in one kick. */
export const REPEAT_SERIES_CAP = 200;

/** Descriptions are read this many at a time — a copy may carry up to 101 of up to 512 KB. */
const DESCRIPTION_CHUNK = 20;

/** One copy's transaction: up to 101 tasks with their labels, history, audit and notices (the templates' copier gets 60 s for up to 1 000). */
const COPY_TX_MS = 30_000;
/** The longest any one statement waits for a lock before the copy gives up and retries. */
const COPY_LOCK_WAIT_MS = 5_000;
/** One workspace's share of a kick (the security review's M-1): the next workspace always gets a turn. */
export const REPEAT_TENANT_SLICE_MS = 15_000;

export type RepeatRun = {
  /** The workspace's day the run decided by; null when the module is closed. */
  readonly today: string | null;
  /** Series found due this kick. */
  readonly considered: number;
  /** Copies made. */
  readonly made: number;
  /** Series another kick or a person moved, stopped or changed meanwhile — nothing written. */
  readonly settled: number;
  readonly failed: number;
  /** The work module is closed to the workspace: nothing looked at. */
  readonly closed: boolean;
  /** The deadline cut the loop; the rest are copied next kick. */
  readonly outOfTime: boolean;
};

/** One copy made — the dbtest reads it back by these. */
export type CopyMade = { readonly copyId: string; readonly number: number; readonly madeFor: string; readonly subtasks: number };

export async function makeRepeatCopies(
  tenantId: string,
  now: Date = new Date(),
  opts: { readonly deadline?: number; readonly cap?: number } = {},
): Promise<RepeatRun> {
  // The caller's deadline, or this workspace's own slice of the kick if sooner.
  const deadline = Math.min(opts.deadline ?? Number.POSITIVE_INFINITY, Date.now() + REPEAT_TENANT_SLICE_MS);
  const out = { today: null as string | null, considered: 0, made: 0, settled: 0, failed: 0, closed: false, outOfTime: false };

  // 1. The workspace's gate, its day and the due series — one system
  // transaction, in sequence.
  const prep = await withTenant(tenantId, SYSTEM, async (tx) => {
    if (!(await moduleOpenUnderSystem(tx, tenantId, "work"))) return null;
    const prefs = await readPreferences(tx, tenantId);
    const today = localDateString(now, prefs.timezone);
    const due = await tx.workItemRepeat.findMany({
      where: {
        tenantId,
        nextOn: { lte: dateColumn(today) },
        // §3.5: a deleted holder waits (the bin may bring it back); an
        // archived, completed, cancelled or paused project, or one whose
        // client is archived, makes no copies. The per-series transaction
        // asks both again under its locks (the pre-apply review's M1).
        workItem: { deletedAt: null, project: PROJECT_MAKES_COPIES_WHERE },
      },
      select: { id: true },
      // LEAST RECENTLY TOUCHED first: a copy moves its series (touching it),
      // and a failure touches it on purpose (below) — so a series that fails
      // every kick goes to the back instead of heading the list for ever.
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      take: opts.cap ?? REPEAT_SERIES_CAP,
    });
    return { today, ids: due.map((d) => d.id) };
  });
  if (prep === null) return { ...out, closed: true };
  out.today = prep.today;

  // 2. One series at a time, each in its own transaction.
  for (const seriesId of prep.ids) {
    if (Date.now() >= deadline) {
      out.outOfTime = true;
      break;
    }
    out.considered += 1;
    try {
      // A BOUNDED wait on every lock (the review's M4): a statement parked
      // on a lock ignores the transaction's budget, and this one holds the
      // project's counter and queue while it waits — every New task there
      // would wait behind it. Spent, the series stays due for the next kick.
      const made = await retryOnContention(() =>
        withTenant(tenantId, SYSTEM, (tx) => copyOne(tx, tenantId, seriesId, prep.today), {
          timeoutMs: COPY_TX_MS,
          lockTimeoutMs: COPY_LOCK_WAIT_MS,
        }),
      );
      if (made) out.made += 1;
      else out.settled += 1;
    } catch (e) {
      out.failed += 1;
      const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
      console.error(`repeating-tasks: tenant ${tenantId} series ${seriesId} failed: ${e instanceof Error ? e.name : typeof e}${code}`);
      // To the back of the list (M-1): its own short transaction, after the
      // failed one rolled back; nothing else about the series changes.
      // Bounded like the copy: behind a concurrent kick's copy of the same
      // series it gives up rather than overrun this workspace's slice.
      await withTenant(
        tenantId,
        SYSTEM,
        (tx) => tx.workItemRepeat.updateMany({ where: { tenantId, id: seriesId }, data: { updatedAt: new Date() } }),
        { lockTimeoutMs: COPY_LOCK_WAIT_MS },
      ).catch(() => undefined);
    }
  }
  return out;
}

/** A stored description, unticked and through the one gate — or null when it says nothing or will not pass. */
function freshDescription(doc: unknown): NormalizedDescription | null {
  if (doc === null || doc === undefined) return null;
  try {
    const n = normalizeDescription(untickChecklists(doc));
    return n.doc === null ? null : n;
  } catch (e) {
    if (!(e instanceof DomainError)) throw e;
    return null;
  }
}

type SourceRow = {
  id: string;
  type: "EPIC" | "TASK" | "SUBTASK";
  kind: "TASK" | "BUG" | "REQUEST";
  title: string;
  description: unknown;
  estimateMinutes: number | null;
  assigneeMemberId: string | null;
  labels: { labelId: string }[];
};

/** A source row without its description, which is read only within the budget. */
const SOURCE_HEAD = {
  id: true,
  type: true,
  kind: true,
  title: true,
  estimateMinutes: true,
  assigneeMemberId: true,
  labels: { select: { labelId: true } },
} as const;

/**
 * One series' copy, inside its own system transaction. Null when no copy is
 * made: nothing is owed any more — another kick made it, or a person changed
 * or stopped the series, while this one waited — or the holder or its project
 * stopped qualifying (nothing written, the series not moved); or a copy for
 * the owed day exists already, when the series' next day is moved on and
 * audited, and nothing else is written.
 */
export async function copyOne(tx: TenantDb, tenantId: string, seriesId: string, today: string): Promise<CopyMade | null> {
  // The PROBE: which task and project, read unlocked — the queue key comes
  // before any row lock, so the rows cannot be locked yet (rows.ts's rule).
  const probe = await tx.workItemRepeat.findFirst({
    where: { tenantId, id: seriesId },
    select: { workItemId: true, workItem: { select: { projectId: true, parentId: true } } },
  });
  if (!probe) return null;
  const { projectId, parentId } = probe.workItem;

  await ensureProjectStates(tx, tenantId, projectId);
  await lockCounter(tx, `work_item:${projectId}`);
  await lockProjectRanks(tx, projectId);
  // The bottom row, FOR UPDATE, straight after the queue: the copy goes after
  // it, and nothing else can move the bottom while the queue is held. Taken
  // BEFORE the holder, so a holder that IS the bottom row is locked once, at
  // the stronger mode, and never upgraded under a colleague's share. (The
  // reverse of `createItem`, which takes its parent's share first and the
  // bottom after: both run under the project's queue, so no cycle closes.)
  const bottom = await lockPredecessor(tx, tenantId, projectId, null, NIL_UUID);
  // Parent before child (deleteItem's order), both FOR SHARE: they hold
  // still while the copy is read and written under them.
  if (parentId) await lockItemRow(tx, tenantId, parentId, "SHARE");
  await lockItemRow(tx, tenantId, probe.workItemId, "SHARE");
  await tx.$queryRaw`SELECT 1 FROM work_item_repeat WHERE tenant_id = ${tenantId} AND id = ${seriesId} FOR UPDATE`;

  // Re-read under the locks: still this holder, still owed.
  const series = await tx.workItemRepeat.findFirst({
    where: { tenantId, id: seriesId },
    select: { workItemId: true, rhythm: true, anchorDay: true, nextOn: true },
  });
  if (!series || series.workItemId !== probe.workItemId || !isRepeatRhythm(series.rhythm)) return null;
  const owed = owedCopy(isoDateOf(series.nextOn), today, series.rhythm, series.anchorDay);
  if (!owed) return null;
  const due = copyDueDate(owed.madeFor, series.rhythm, series.anchorDay);
  if (due === null) return null;
  // A copy for that day exists already (the review's L3 — a workspace's zone
  // moved west, and a person set the next day to one already made): the day
  // is not made twice, and the series moves on rather than failing on the
  // UNIQUE every kick until a period passes.
  const already = await tx.workItemRepeatItem.findFirst({
    where: { tenantId, repeatId: seriesId, madeFor: dateColumn(owed.madeFor) },
    select: { workItemId: true },
  });
  if (already) {
    await tx.workItemRepeat.update({ where: { id: seriesId }, data: { nextOn: dateColumn(owed.nextOn) }, select: { id: true } });
    const holderNumber = (await tx.workItem.findFirst({ where: { tenantId, id: series.workItemId }, select: { number: true } }))?.number ?? null;
    // The one move of a series no copy's audit row carries (the reviews' NIT).
    await recordMany(tx, [
      {
        action: "work_item.repeat_changed",
        targetType: "WorkItem",
        targetId: series.workItemId,
        metadata: {
          number: holderNumber,
          projectId,
          repeatId: seriesId,
          from: { rhythm: series.rhythm, nextOn: isoDateOf(series.nextOn), anchorDay: series.anchorDay },
          to: { rhythm: series.rhythm, nextOn: owed.nextOn, anchorDay: series.anchorDay },
          reason: "day_already_made",
          madeFor: owed.madeFor,
        },
      },
    ]);
    return null;
  }

  const holderRow = await tx.workItem.findFirst({
    where: { tenantId, id: series.workItemId, deletedAt: null },
    select: { ...SOURCE_HEAD, projectId: true, clientId: true, parentId: true, depth: true, number: true },
  });
  // Read AFTER the holder's FOR SHARE, so a delete that committed meanwhile
  // is seen (its NO KEY UPDATE conflicts with the share; the review's M1). A
  // holder deleted, or moved under another parent since the probe (the
  // lock above was then the wrong parent's): nothing now — the next kick
  // probes again.
  if (!holderRow || holderRow.parentId !== parentId) return null;
  const project = await tx.project.findFirst({
    where: { tenantId, id: projectId },
    select: { key: true, status: true, archivedAt: true, client: { select: { status: true } } },
  });
  // An archive committing in the same instant can still race this read, as
  // it can race `createItem` — no project-row lock is taken here, since the
  // portal fan-out holds that row while it writes task rows (a cycle).
  if (!project || !projectMakesCopies(project)) return null;
  const start = await tx.workflowState.findFirst({
    where: { tenantId, projectId, isDefault: true },
    select: { id: true, category: true },
  });
  if (!start) throw new Error("repeat copy: project has no default state");

  // The tree under it, by the template rule, the first REPEAT_MAX_SUBTASKS.
  const taken = await copyableSubtree(tx, tenantId, holderRow, Number.MAX_SAFE_INTEGER);
  const under = taken.slice(0, REPEAT_MAX_SUBTASKS);
  const leftOut = taken.length - under.length;
  const heads = new Map<string, Omit<SourceRow, "description">>();
  for (let i = 0; i < under.length; i += DESCRIPTION_CHUNK) {
    const ids = under.slice(i, i + DESCRIPTION_CHUNK).map((u) => u.id);
    const rows = await tx.workItem.findMany({ where: { tenantId, id: { in: ids } }, select: SOURCE_HEAD });
    for (const r of rows) heads.set(r.id, r);
  }
  // DESCRIPTIONS WITHIN A BUDGET (the security review's M-1): measured in SQL
  // before any is read, the holder's first, then the tree's in order; one
  // that would pass the budget is copied without its description, and the
  // audit row says how many.
  const order = [holderRow.id, ...under.map((u) => u.id)];
  const sizes = await descriptionBytes(tx, tenantId, order);
  let room = REPEAT_MAX_DESCRIPTION_BYTES;
  const described: string[] = [];
  let descriptionsLeftOut = 0;
  for (const id of order) {
    const bytes = sizes.get(id) ?? 0;
    if (bytes === 0) continue;
    if (bytes <= room) {
      described.push(id);
      room -= bytes;
    } else descriptionsLeftOut += 1;
  }
  const descriptionOf = new Map<string, unknown>();
  for (let i = 0; i < described.length; i += DESCRIPTION_CHUNK) {
    const rows = await tx.workItem.findMany({
      where: { tenantId, id: { in: described.slice(i, i + DESCRIPTION_CHUNK) } },
      select: { id: true, description: true },
    });
    for (const r of rows) descriptionOf.set(r.id, r.description);
  }
  const holder: SourceRow & typeof holderRow = { ...holderRow, description: descriptionOf.get(holderRow.id) ?? null };
  const byId = new Map<string, SourceRow>(
    [...heads.values()].map((h) => [h.id, { ...h, description: descriptionOf.get(h.id) ?? null }]),
  );

  // Who may still take what they held (§3.4) — one rule, one read.
  const held = [holder.assigneeMemberId, ...under.map((u) => byId.get(u.id)?.assigneeMemberId ?? null)].filter(
    (id): id is string => id !== null,
  );
  const can = new Set(
    (await mentionableMembers(tx, tenantId, { projectId, clientId: holder.clientId }, [...new Set(held)])).map((m) => m.id),
  );
  const assigneeOf = (memberId: string | null): string | null => (memberId !== null && can.has(memberId) ? memberId : null);

  const n = 1 + under.length;
  const numbers = await nextCounters(tx, `work_item:${projectId}`, n);
  const ranks = ranksBetween(bottom?.rank ?? null, null, n);
  const copyId = newId();
  const idOf = new Map<string, string>(under.map((u) => [u.id, newId()]));

  const rowOf = (
    source: SourceRow,
    id: string,
    number: number,
    rank: string,
    parent: string | null,
    dates: { startDate: Date; targetDate: Date } | null,
  ) => {
    const doc = freshDescription(source.description);
    const assignee = assigneeOf(source.assigneeMemberId);
    return {
      assignee,
      dropped: source.assigneeMemberId !== null && assignee === null,
      data: {
        id,
        tenantId,
        clientId: holder.clientId,
        projectId,
        number,
        type: source.type,
        kind: source.kind,
        title: source.title,
        ...(doc === null
          ? {}
          : { description: doc.doc as object, descriptionText: doc.text, checklistTotal: doc.checklistTotal, checklistDone: doc.checklistDone }),
        stateId: start.id,
        stateCategory: start.category,
        parentId: parent,
        rootId: id, // parent_guard derives the real root/depth
        rank,
        estimateMinutes: source.estimateMinutes,
        ...(dates ?? {}),
        assigneeMemberId: assignee,
        // THE WORST-BUG DEFAULT, written out rather than left to the column (C103 (f)).
        visibility: "INTERNAL" as const,
        source: "IN_APP" as const,
        createdByMemberId: null,
      },
    };
  };
  type Made = ReturnType<typeof rowOf> & { readonly level: number; readonly source: SourceRow };

  const made: Made[] = [
    {
      level: -1,
      source: holder,
      ...rowOf(holder, copyId, numbers[0]!, ranks[0]!, holder.parentId, {
        startDate: dateColumn(owed.madeFor),
        targetDate: dateColumn(due),
      }),
    },
    ...under.flatMap((u, i) => {
      const source = byId.get(u.id);
      if (!source) return [];
      const parent = u.parentId === null ? copyId : idOf.get(u.parentId)!;
      return [{ level: u.depth, source, ...rowOf(source, idOf.get(u.id)!, numbers[i + 1]!, ranks[i + 1]!, parent, null) }];
    }),
  ];

  // A level at a time, so the tree trigger always finds the parent the
  // statement before wrote (the template copier's rule).
  for (const level of [-1, 0, 1]) {
    const rows = made.filter((m) => m.level === level).map((m) => m.data);
    if (rows.length > 0) await tx.workItem.createMany({ data: rows });
  }
  const labelRows = made.flatMap((m) =>
    [...new Set(m.source.labels.map((l) => l.labelId))].map((labelId) => ({ tenantId, workItemId: m.data.id, labelId })),
  );
  if (labelRows.length > 0) await tx.workItemLabel.createMany({ data: labelRows, skipDuplicates: true });

  // The series moves onto the copy (§3.1) — its membership row first, so the
  // UNIQUE on (series, day) refuses a second copy for the day whoever wrote.
  await tx.workItemRepeatItem.create({
    data: { tenantId, repeatId: seriesId, workItemId: copyId, madeFor: dateColumn(owed.madeFor) },
    select: { workItemId: true },
  });
  await tx.workItemRepeat.update({
    where: { id: seriesId },
    data: { workItemId: copyId, nextOn: dateColumn(owed.nextOn) },
    select: { id: true },
  });

  // History — System, every row INTERNAL.
  const ref = (id: string) => ({ id, clientId: holder.clientId, projectId, visibility: "INTERNAL" as const });
  await writeSystemActivityMany(tx, tenantId, [
    ...made.map((m) => ({ item: ref(m.data.id), change: { field: "created", forceInternal: true } })),
    { item: ref(copyId), change: { field: "repeatedFrom", oldValue: String(holder.number), forceInternal: true } },
    ...made
      .filter((m) => m.assignee !== null)
      .map((m) => ({ item: ref(m.data.id), change: { field: "assignee", oldRef: null, newRef: m.assignee, forceInternal: true } })),
    { item: ref(holder.id), change: { field: "repeatCopied", newValue: String(numbers[0]!), forceInternal: true } },
  ]);

  const audits: AuditInput[] = made.map((m) => ({
    action: "work_item.created",
    targetType: "WorkItem",
    targetId: m.data.id,
    metadata: {
      number: m.data.number,
      projectId,
      type: m.source.type,
      visibility: "INTERNAL",
      repeatId: seriesId,
      ...(m.data.id === copyId
        ? // `nextOn`: where the series moved — the job's move has no audit row of its own (the review's N7).
          {
            repeatedFromId: holder.id,
            madeFor: owed.madeFor,
            nextOn: owed.nextOn,
            ...(leftOut > 0 ? { leftOut } : {}),
            ...(descriptionsLeftOut > 0 ? { descriptionsLeftOut } : {}),
          }
        : { copyOf: m.source.id }),
      ...(m.dropped ? { assigneeDropped: true } : {}),
    },
  }));
  await recordMany(tx, audits);

  // Told once a copy, each about the first task they hold in it (§3.4).
  const firstHeld = new Map<string, Made>();
  for (const m of made) if (m.assignee !== null && !firstHeld.has(m.assignee)) firstHeld.set(m.assignee, m);
  for (const [memberId, m] of firstHeld) {
    await emit(tx, tenantId, {
      kind: "work_item.assigned",
      entity: { type: "WorkItem", id: m.data.id },
      clientId: holder.clientId,
      projectId,
      receivers: new Map([[memberId, "ASSIGNEE"]]),
      params: { projectKey: project.key, itemNumber: String(m.data.number) },
      dedupeKey: `assigned:${m.data.id}`,
    });
  }

  return { copyId, number: numbers[0]!, madeFor: owed.madeFor, subtasks: made.length - 1 };
}
