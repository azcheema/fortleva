import { randomUUID } from "node:crypto";

import { record, recordMany, type AuditInput } from "@/audit/record";
import { assertInScope, isAuthorized } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { lockCounter, nextCounters, withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { DomainError, fail, isDeadlock, isUniqueViolation } from "@/lib/domain-error";
import type { StateSeedKey } from "@/lib/enum-map";
import { normalizeDescription } from "@/lib/rich-text/normalize";
import { readPreferences } from "@/preferences/service";

import { writeActivityMany } from "../activity";
import { guarded } from "../db-errors";
import { bottomRanks, lockProjectRanks } from "../rank-lock";
import { ensureProjectStates, principalOf, transitionState, type WorkCtx } from "../states";
import { importDescription } from "./description-doc";
import {
  IMPORT_MAX_ROWS,
  IMPORT_STALE_MS,
  importBatchSchema,
  restoreOpen,
  sourceSystemOf,
  stampsOnBirth,
  startImportSchema,
  undoOpen,
  type CheckedImportRow,
  type ImportSource,
} from "./rules";

/**
 * IMPORTS (Phase 6 slice 121; founder decision C97;
 * docs/research/2026-10-15-slice-121-imports-design.md §3–§5).
 *
 * The file is read in the member's browser (R1); what arrives here is
 * plain rows, in batches, and NOTHING in a row is trusted: `importRowSchema`
 * re-checks every field, every state and member id is re-read here, and the
 * description is built on this side and passes `normalizeDescription`.
 *
 * THE GATES (R8), in sequence and never as a batch leg
 * (`authz-batches.test.ts`): `work_item:create` and `work_item:edit` —
 * an import makes tasks AND sets their status, assignee and labels, which
 * by hand is create then edit — the project in the member's scope, and the
 * project not archived. `work_item:approve` only when a row targets an
 * approval-gated state; `label:manage` only when a label name is new. Undo
 * and Bring back are `work_item:delete`, the hand delete's code. No new
 * permission code exists for any of it.
 *
 * THE LOCKS (`rank-lock.ts`, THE ONE ORDER). Every writer here is a
 * multi-row writer of one project's tasks, so it takes the project's rank
 * queue BEFORE any row lock — including the job's own row, which is read
 * unlocked first (the queue key is its project), then locked and read
 * again after the wait, so a batch and an undo of the same job can never
 * hold each other's rows in opposite orders.
 *
 * NOBODY IS TOLD (R4): no assignment notification, no email. An import that
 * hands a colleague three hundred tasks would otherwise be three hundred
 * mails — the reason bulk-assign was never built (`bulk.ts`).
 */

const NOW = () => new Date();
const RETRIES = 3;
const EMPTY_DESCRIPTION: ReturnType<typeof normalizeDescription> = { doc: null, text: null, checklistTotal: 0, checklistDone: 0 };

/**
 * A row's description, built HERE from its plain values and passed through
 * the one gate (`normalizeDescription`). A row with nothing to say has NO
 * document — the column stays NULL, as a task made by hand starts. A
 * document the gate refuses — ten thousand one-word bullets pass 512 KB of
 * JSON while their text is well inside the cap — falls back to the same
 * words as ONE plain paragraph, and that failing, to none: one row never
 * refuses its whole batch (the code review's finding).
 */
function describe(r: CheckedImportRow, linkLabel: string): ReturnType<typeof normalizeDescription> {
  const doc = importDescription({ text: r.text, checklists: r.checklists, link: r.link, linkLabel });
  if (doc === null) return EMPTY_DESCRIPTION;
  try {
    return normalizeDescription(doc);
  } catch (e) {
    if (!(e instanceof DomainError)) throw e;
  }
  const words = [r.text, ...r.checklists.flatMap((c) => [c.name ?? "", ...c.items.map((i) => i.text)]), r.link ?? ""]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (words === "") return EMPTY_DESCRIPTION;
  try {
    return normalizeDescription({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: words }] }] });
  } catch (e) {
    if (!(e instanceof DomainError)) throw e;
    return EMPTY_DESCRIPTION;
  }
}

/** The unique index and a deadlock are retried, as the rank writers do (`ordering.ts`): Postgres has undone the loser. */
async function retrying<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!(isUniqueViolation(e) || isDeadlock(e)) || attempt + 1 >= RETRIES) throw e;
      await new Promise((r) => setTimeout(r, 10 + Math.random() * 40));
    }
  }
}

/** The importer's gate: create + edit, in sequence, then scope; the project live. */
async function gateImporter(tx: TenantDb, ctx: WorkCtx, projectId: string) {
  await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:create");
  await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:edit");
  await assertInScope(tx, ctx.actor, { projectId });
  const project = await tx.project.findFirst({
    where: { tenantId: ctx.tenantId, id: projectId },
    select: { id: true, clientId: true, status: true },
  });
  if (!project) deny("NOT_FOUND");
  return project!;
}

type StateRow = {
  id: string;
  projectId: string;
  name: string | null;
  seedKey: StateSeedKey | null;
  category: "TRIAGE" | "BACKLOG" | "TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED";
  isDefault: boolean;
  requiresApproval: boolean;
};

async function projectStates(tx: TenantDb, tenantId: string, projectId: string): Promise<StateRow[]> {
  await ensureProjectStates(tx, tenantId, projectId);
  return tx.workflowState.findMany({
    where: { tenantId, projectId },
    orderBy: { rank: "asc" },
    select: { id: true, projectId: true, name: true, seedKey: true, category: true, isDefault: true, requiresApproval: true },
  }) as Promise<StateRow[]>;
}

// ── The page's read ─────────────────────────────────────────────────

export type ImportForm = {
  readonly project: { readonly id: string; readonly archived: boolean };
  /** The project's states in board order, RAW names (resolved at the page). */
  readonly states: readonly Omit<StateRow, "projectId">[];
  /** ACTIVE members a task may be assigned to — names only; email matching is `matchImportPeople`. */
  readonly members: readonly { readonly id: string; readonly name: string }[];
  /** The label names this project offers (workspace + its own). */
  readonly labels: readonly string[];
  readonly caps: { readonly approve: boolean; readonly manageLabels: boolean; readonly undo: boolean };
  /** The workspace's zone — a Trello due INSTANT is read as a day there. */
  readonly timezone: string;
};

export async function readImportForm(ctx: WorkCtx, projectId: string): Promise<ImportForm> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    const project = await gateImporter(tx, ctx, projectId);
    const states = await projectStates(tx, ctx.tenantId, projectId);
    const members = await tx.member.findMany({
      where: { tenantId: ctx.tenantId, status: "ACTIVE" },
      select: { id: true, user: { select: { name: true } } },
    });
    const labels = await tx.label.findMany({
      where: { tenantId: ctx.tenantId, OR: [{ projectId: null }, { projectId }] },
      select: { name: true },
    });
    // In sequence — never legs of one batch (authz-batches.test.ts).
    const approve = await isAuthorized(tx, ctx.actor, "work_item:approve");
    const manageLabels = await isAuthorized(tx, ctx.actor, "label:manage");
    const undo = await isAuthorized(tx, ctx.actor, "work_item:delete");
    const prefs = await readPreferences(tx, ctx.tenantId);
    return {
      project: { id: project.id, archived: project.status === "ARCHIVED" },
      states: states.map((s) => ({ id: s.id, name: s.name, seedKey: s.seedKey, category: s.category, isDefault: s.isDefault, requiresApproval: s.requiresApproval })),
      members: members
        .map((m) => ({ id: m.id, name: m.user.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      labels: labels.map((l) => l.name),
      caps: { approve, manageLabels, undo },
      timezone: prefs.timezone,
    };
  });
}

/**
 * The file's assignee EMAILS → ACTIVE members, exactly and case-insensitively
 * (R4). On the server so the page never holds the team's addresses; it
 * answers only the matches.
 */
export async function matchImportPeople(
  ctx: WorkCtx,
  projectId: string,
  emails: readonly string[],
): Promise<Record<string, string>> {
  const wanted = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e !== "" && e.length <= 320))];
  if (wanted.length > IMPORT_MAX_ROWS) fail("INVALID_INPUT", "too many addresses");
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await gateImporter(tx, ctx, projectId);
    if (wanted.length === 0) return {};
    const rows = await tx.$queryRaw<{ id: string; email: string }[]>`
      SELECT m.id, lower(u.email) AS email
      FROM member m JOIN "user" u ON u.id = m.user_id
      WHERE m.tenant_id = ${ctx.tenantId} AND m.status = 'ACTIVE' AND lower(u.email) = ANY(${wanted}::text[])`;
    return Object.fromEntries(rows.map((r) => [r.email, r.id]));
  });
}

/**
 * How many of the file's ids already name a live task in this project, and
 * of those how many a re-import would UPDATE (still private, untouched
 * since an import wrote it) and how many it would KEEP (R7). Counts only.
 */
export async function previewImportMatches(
  ctx: WorkCtx,
  input: { projectId: string; source: ImportSource; sourceIds: readonly string[] },
): Promise<{ willUpdate: number; willKeep: number }> {
  const ids = [...new Set(input.sourceIds.filter((s) => s !== "" && s.length <= 200))];
  if (ids.length > IMPORT_MAX_ROWS) fail("INVALID_INPUT", "too many ids");
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await gateImporter(tx, ctx, input.projectId);
    if (ids.length === 0) return { willUpdate: 0, willKeep: 0 };
    const rows = await matchLive(tx, {
      tenantId: ctx.tenantId,
      projectId: input.projectId,
      sourceSystem: sourceSystemOf(input.source),
      ids,
      jobId: null,
      lock: false,
    });
    const willUpdate = rows.filter((r) => r.updatable).length;
    return { willUpdate, willKeep: rows.length - willUpdate };
  });
}

type Match = { id: string; source_id: string; updatable: boolean; mine: boolean };

/**
 * The LIVE tasks of a project carrying these source ids — "live" exactly as
 * `work_item_source_live_key` means it (`deleted_at IS NULL`, archived
 * included; `source_id IS NOT NULL` spelled out so the planner can use the
 * partial index) — with THE RE-IMPORT TEST (R7): still private, no contact
 * assignee, and SOME import write of it left exactly its current
 * `updated_at`. Compared in SQL, never through a JavaScript Date (which
 * drops Postgres's microseconds); an EXISTS, never "the last row by
 * `created_at`", which is a transaction's start and not the order writes
 * took the lock (the pre-apply review). ONE expression, in both branches
 * below — the write's locked read and the preview's unlocked one must never
 * disagree about what a re-import would do.
 */
async function matchLive(
  tx: TenantDb,
  q: { tenantId: string; projectId: string; sourceSystem: "csv" | "trello"; ids: readonly string[]; jobId: string | null; lock: boolean },
): Promise<Match[]> {
  const ids = [...q.ids];
  if (q.lock) {
    return tx.$queryRaw<Match[]>`
      SELECT w.id, w.source_id,
             (w.visibility = 'INTERNAL' AND w.assignee_contact_id IS NULL AND EXISTS (
               SELECT 1 FROM import_job_item i
               WHERE i.tenant_id = w.tenant_id AND i.work_item_id = w.id AND i.written_at = w.updated_at)) AS updatable,
             EXISTS (SELECT 1 FROM import_job_item i
                     WHERE i.tenant_id = w.tenant_id AND i.import_job_id = ${q.jobId} AND i.work_item_id = w.id) AS mine
      FROM work_item w
      WHERE w.tenant_id = ${q.tenantId} AND w.project_id = ${q.projectId}
        AND w.source_system = ${q.sourceSystem} AND w.source_id IS NOT NULL AND w.source_id = ANY(${ids}::text[])
        AND w.deleted_at IS NULL
      ORDER BY w.id
      FOR NO KEY UPDATE OF w`;
  }
  return tx.$queryRaw<Match[]>`
    SELECT w.id, w.source_id,
           (w.visibility = 'INTERNAL' AND w.assignee_contact_id IS NULL AND EXISTS (
             SELECT 1 FROM import_job_item i
             WHERE i.tenant_id = w.tenant_id AND i.work_item_id = w.id AND i.written_at = w.updated_at)) AS updatable,
           false AS mine
    FROM work_item w
    WHERE w.tenant_id = ${q.tenantId} AND w.project_id = ${q.projectId}
      AND w.source_system = ${q.sourceSystem} AND w.source_id IS NOT NULL AND w.source_id = ANY(${ids}::text[])
      AND w.deleted_at IS NULL`;
}

// ── Start, batch, finish ────────────────────────────────────────────

export async function startImport(ctx: WorkCtx, raw: unknown): Promise<{ jobId: string }> {
  const input = startImportSchema.safeParse(raw);
  if (!input.success) fail("INVALID_INPUT", "import start");
  const { projectId, source, fileName, rowCount } = input.data!;
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    const project = await gateImporter(tx, ctx, projectId);
    if (project.status === "ARCHIVED") fail("ARCHIVED");
    const now = NOW();
    const job = await tx.importJob.create({
      data: {
        tenantId: ctx.tenantId,
        projectId,
        source,
        fileName,
        rowCount,
        startedByMemberId: ctx.actor.memberId,
        startedAt: now,
        lastWriteAt: now,
      },
      select: { id: true },
    });
    // The file's NAME stays on the job row, never in the trail (R12).
    await record(tx, {
      action: "import_job.started",
      targetType: "ImportJob",
      targetId: job.id,
      metadata: { projectId, source, rows: rowCount },
    });
    return { jobId: job.id };
  });
}

export type BatchResult = { created: number; updated: number; kept: number; unchanged: number };

const loadItemRow = (tx: TenantDb, tenantId: string, id: string) =>
  tx.workItem.findFirst({ where: { tenantId, id }, omit: { description: true, descriptionText: true } });

/**
 * ONE BATCH, one transaction (design §3.2): match, update what may be
 * updated, create the rest — set-based for the creates (one counter
 * statement, one `createMany` of tasks, of labels, of history rows, of audit
 * rows, of item rows), per row only for a re-import's real changes.
 */
export async function importBatch(
  ctx: WorkCtx,
  jobId: string,
  rawRows: unknown,
  opts: { linkLabel: string },
): Promise<BatchResult> {
  const parsed = importBatchSchema.safeParse(rawRows);
  if (!parsed.success) fail("INVALID_INPUT", "import rows");
  const rows = parsed.data!;
  const linkLabel = opts.linkLabel.slice(0, 100);
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.sourceId === null) continue;
    if (seen.has(r.sourceId)) fail("INVALID_INPUT", "a source id repeats within a batch");
    seen.add(r.sourceId);
  }
  // Every description is built and normalised BEFORE the transaction: it is
  // pure, it is where a crafted row is refused, and a refusal should cost no
  // database work (`updateItemDescription`'s rule).
  // A row with nothing to say has NO document — the column stays NULL, as a
  // task made by hand starts (the gate only takes documents).
  const docs = rows.map((r) => describe(r, linkLabel));

  return retrying(() =>
    withTenant(
      ctx.tenantId,
      principalOf(ctx),
      async (tx) =>
        guarded(async () => {
          await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:create");
          await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:edit");
          // The job, UNLOCKED first: its project is the queue key.
          const probe = await tx.importJob.findFirst({
            where: { tenantId: ctx.tenantId, id: jobId },
            select: { projectId: true },
          });
          if (!probe) deny("NOT_FOUND");
          await assertInScope(tx, ctx.actor, { projectId: probe!.projectId });
          // THE COUNTER BEFORE THE QUEUE — the order `createItem` and a
          // portal request take the two (rank-lock.ts, THE ONE ORDER). Taken
          // after the queue, a batch holding the queue while a member's
          // "New task" held the counter and waited for the queue was a
          // deadlock that aborted the member's create (the code review's
          // MEDIUM). `lockCounter` draws no number; `nextCounters` later in
          // this transaction is re-entrant on the row.
          await lockCounter(tx, `work_item:${probe!.projectId}`);
          await lockProjectRanks(tx, probe!.projectId);
          // …then LOCKED and read again AFTER the queue's wait: an undo that
          // committed while this batch waited has closed the job, and the
          // decision must come from the row as it is now (THE ONE ORDER).
          const [job] = await tx.$queryRaw<
            { project_id: string; source: ImportSource; status: string; started_by_member_id: string; row_count: number; processed: number }[]
          >`
            SELECT project_id, source, status, started_by_member_id, row_count,
                   created_count + updated_count + kept_count + unchanged_count AS processed
            FROM import_job
            WHERE tenant_id = ${ctx.tenantId} AND id = ${jobId}
            FOR UPDATE`;
          // A colleague's import is not this member's to write into; a closed
          // one (finished, undone) takes no more rows.
          if (!job || job.started_by_member_id !== ctx.actor.memberId || job.status !== "RUNNING") fail("IMPORT_CLOSED");
          // Never more rows than the import declared at its start (the CHECK
          // `import_job_counts_within_rows` is the belt).
          if (job!.processed + rows.length > job!.row_count) fail("INVALID_INPUT", "more rows than the import declared");
          const projectId = job!.project_id;
          const project = await tx.project.findFirst({
            where: { tenantId: ctx.tenantId, id: projectId },
            select: { clientId: true, status: true },
          });
          if (!project) deny("NOT_FOUND");
          if (project!.status === "ARCHIVED") fail("ARCHIVED");

          // The states: each row's must be THIS project's, never TRIAGE; a
          // gated one asks the approve code once for the batch.
          const states = new Map((await projectStates(tx, ctx.tenantId, projectId)).map((s) => [s.id, s]));
          const defaultState = [...states.values()].find((s) => s.isDefault);
          if (!defaultState) deny("NOT_FOUND", "project has no default state");
          for (const r of rows) {
            const s = states.get(r.stateId);
            if (!s) fail("INVALID_INPUT", "a row's state is not this project's");
            if (s!.category === "TRIAGE") fail("INVALID_INPUT", "triage entry is not an import");
          }
          if (rows.some((r) => states.get(r.stateId)!.requiresApproval)) {
            if (!(await isAuthorized(tx, ctx.actor, "work_item:approve"))) {
              fail("APPROVAL_REQUIRED", "an imported row targets an approval-gated state");
            }
          }

          // The assignees: ACTIVE members of this tenant, re-read.
          const wantedMembers = [...new Set(rows.map((r) => r.assigneeMemberId).filter((m): m is string => m !== null))];
          if (wantedMembers.length > 0) {
            const active = await tx.member.findMany({
              where: { tenantId: ctx.tenantId, id: { in: wantedMembers }, status: "ACTIVE" },
              select: { id: true },
            });
            if (active.length !== wantedMembers.length) deny("NOT_FOUND", "an assignee is not an active member");
          }

          const labelIds = await resolveLabels(tx, ctx, projectId, rows);
          const sourceSystem = sourceSystemOf(job!.source);
          const now = NOW();

          // ── Match (R7): live tasks of this project with these ids, locked.
          const ids = rows.map((r) => r.sourceId).filter((s): s is string => s !== null);
          const matched =
            ids.length === 0 ? [] : await matchLive(tx, { tenantId: ctx.tenantId, projectId, sourceSystem, ids, jobId, lock: true });
          const bySource = new Map(matched.map((m) => [m.source_id, m]));

          const result: BatchResult = { created: 0, updated: 0, kept: 0, unchanged: 0 };
          const creates: { row: CheckedImportRow; doc: (typeof docs)[number] }[] = [];
          const updatedItems: { workItemId: string }[] = [];
          for (const [i, row] of rows.entries()) {
            const hit = row.sourceId === null ? undefined : bySource.get(row.sourceId);
            if (!hit) {
              creates.push({ row, doc: docs[i]! });
              continue;
            }
            // Written by THIS job already (the browser de-duplicates ids; a
            // retried batch is the belt): nothing to do.
            if (hit.mine) {
              result.unchanged++;
              continue;
            }
            if (!hit.updatable) {
              result.kept++;
              continue;
            }
            const changed = await updateMatched(tx, ctx, hit.id, row, docs[i]!, states.get(row.stateId)!, labelIds);
            if (changed) {
              result.updated++;
              updatedItems.push({ workItemId: hit.id });
            } else {
              result.unchanged++;
            }
          }

          if (creates.length > 0) {
            const created = await createRows(tx, ctx, {
              projectId,
              clientId: project!.clientId,
              jobId,
              sourceSystem,
              defaultState: defaultState!,
              states,
              labelIds,
              creates,
              now,
            });
            result.created = created;
          }
          // UPDATED rows' `written_at` is the row's own `updated_at` after
          // every write above — read back in SQL, never from a Date.
          if (updatedItems.length > 0) {
            await tx.$executeRaw`
              INSERT INTO import_job_item (id, tenant_id, import_job_id, work_item_id, action, written_at)
              SELECT gen_random_uuid()::text, w.tenant_id, ${jobId}, w.id, 'UPDATED', w.updated_at
              FROM work_item w
              WHERE w.tenant_id = ${ctx.tenantId} AND w.id = ANY(${updatedItems.map((u) => u.workItemId)}::text[])`;
          }
          // `greatest(…)`: the stamp is this instance's clock, and another
          // instance started the job — skew must never fail CHECK
          // `import_job_times_ordered` (last_write_at ≥ started_at; the code
          // review's nit).
          await tx.$executeRaw`
            UPDATE import_job
               SET created_count = created_count + ${result.created}::int,
                   updated_count = updated_count + ${result.updated}::int,
                   kept_count = kept_count + ${result.kept}::int,
                   unchanged_count = unchanged_count + ${result.unchanged}::int,
                   last_write_at = greatest(last_write_at, ${now})
             WHERE tenant_id = ${ctx.tenantId} AND id = ${jobId}`;
          return result;
        }),
      { timeoutMs: 60_000 },
    ),
  );
}

/**
 * Label NAMES → ids for this project (R6): an offered label of the same
 * name, case-insensitively (the project's own first); a new name becomes a
 * WORKSPACE label — as the picker's "Create “…”" makes one — when the
 * member holds `label:manage`, else it is left off.
 */
async function resolveLabels(
  tx: TenantDb,
  ctx: WorkCtx,
  projectId: string,
  rows: readonly CheckedImportRow[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const r of rows) for (const l of r.labels) if (!names.has(l.toLowerCase())) names.set(l.toLowerCase(), l);
  const byKey = new Map<string, string>();
  if (names.size === 0) return byKey;
  const offered = await tx.label.findMany({
    where: { tenantId: ctx.tenantId, OR: [{ projectId: null }, { projectId }] },
    select: { id: true, name: true, projectId: true },
  });
  // The project's own label wins over a workspace label of the same name.
  for (const l of offered.sort((a, b) => Number(a.projectId !== null) - Number(b.projectId !== null))) {
    byKey.set(l.name.toLowerCase(), l.id);
  }
  // SORTED: two imports making overlapping new names in opposite orders
  // would otherwise deadlock on the workspace's label-name index.
  const fresh = [...names.entries()]
    .filter(([key]) => !byKey.has(key))
    .map(([, name]) => name)
    .sort();
  if (fresh.length > 0 && (await isAuthorized(tx, ctx.actor, "label:manage"))) {
    // `skipDuplicates` is ON CONFLICT DO NOTHING, which covers the partial
    // `label_tenant_wide_name_key` on lower(name): a colleague's label made
    // meanwhile is not an error, it is simply found by the re-read below.
    const made = await tx.label.createManyAndReturn({
      data: fresh.map((name) => ({ tenantId: ctx.tenantId, projectId: null, name })),
      skipDuplicates: true,
      select: { id: true, name: true },
    });
    await recordMany(
      tx,
      made.map((l) => ({ action: "label.created", targetType: "Label", targetId: l.id, metadata: { name: l.name } }) as const),
    );
    const now = await tx.label.findMany({
      where: { tenantId: ctx.tenantId, projectId: null, name: { in: fresh, mode: "insensitive" } },
      select: { id: true, name: true },
    });
    for (const l of now) if (!byKey.has(l.name.toLowerCase())) byKey.set(l.name.toLowerCase(), l.id);
  }
  return byKey;
}

const labelIdsOf = (row: CheckedImportRow, labelIds: ReadonlyMap<string, string>): string[] => [
  ...new Set(row.labels.map((l) => labelIds.get(l.toLowerCase())).filter((id): id is string => id !== undefined)),
];

/** The batch's creates, set-based (design §3.2). Returns how many were made. */
async function createRows(
  tx: TenantDb,
  ctx: WorkCtx,
  input: {
    projectId: string;
    clientId: string;
    jobId: string;
    sourceSystem: "csv" | "trello";
    /** The project's default state — where `createItem` births a task before it moves (the birth history row's `from`). */
    defaultState: StateRow;
    states: ReadonlyMap<string, StateRow>;
    labelIds: ReadonlyMap<string, string>;
    creates: readonly { row: CheckedImportRow; doc: ReturnType<typeof normalizeDescription> }[];
    now: Date;
  },
): Promise<number> {
  const { creates, now } = input;
  const n = creates.length;
  const numbers = await nextCounters(tx, `work_item:${input.projectId}`, n);
  const ranks = await bottomRanks(tx, ctx.tenantId, input.projectId, n);
  const made = creates.map(({ row, doc }, i) => {
    const state = input.states.get(row.stateId)!;
    return {
      id: randomUUID(),
      number: numbers[i]!,
      rank: ranks[i]!,
      row,
      doc,
      state,
    };
  });
  await tx.workItem.createMany({
    data: made.map((m) => ({
      id: m.id,
      tenantId: ctx.tenantId,
      clientId: input.clientId,
      projectId: input.projectId,
      number: m.number,
      type: "TASK" as const,
      kind: "TASK" as const,
      title: m.row.title,
      ...(m.doc.doc === null
        ? {}
        : {
            description: m.doc.doc as object,
            descriptionText: m.doc.text,
            checklistTotal: m.doc.checklistTotal,
            checklistDone: m.doc.checklistDone,
          }),
      stateId: m.state.id,
      stateCategory: m.state.category,
      ...stampsOnBirth(m.state.category, now),
      assigneeMemberId: m.row.assigneeMemberId,
      targetDate: m.row.targetDate === null ? null : new Date(`${m.row.targetDate}T00:00:00.000Z`),
      rootId: m.id, // parent_guard derives the real root/depth
      rank: m.rank,
      // THE WORST-BUG DEFAULT, written out rather than left to the column:
      // an imported task is private until a person shares it (R2).
      visibility: "INTERNAL" as const,
      source: "IMPORT" as const,
      sourceSystem: m.row.sourceId === null ? null : input.sourceSystem,
      sourceId: m.row.sourceId,
      importJobId: input.jobId,
      createdByMemberId: ctx.actor.memberId,
      updatedAt: now,
    })),
  });
  const labelRows = made.flatMap((m) => labelIdsOf(m.row, input.labelIds).map((labelId) => ({ tenantId: ctx.tenantId, workItemId: m.id, labelId })));
  if (labelRows.length > 0) await tx.workItemLabel.createMany({ data: labelRows, skipDuplicates: true });

  const ref = (m: (typeof made)[number]) => ({ id: m.id, clientId: input.clientId, projectId: input.projectId, visibility: "INTERNAL" as const });
  // History: `created` for each, and a birth into a non-default column gets
  // the state row `createItem` + `transitionState(birth)` writes — INTERNAL,
  // since a birth is no change a client saw.
  await writeActivityMany(tx, ctx, [
    ...made.map((m) => ({ item: ref(m), change: { field: "created", forceInternal: true } })),
    ...made
      .filter((m) => !m.state.isDefault)
      .map((m) => ({
        item: ref(m),
        change: {
          field: "stateCategory",
          oldValue: input.defaultState.category,
          newValue: m.state.category,
          oldRef: input.defaultState.id,
          newRef: m.state.id,
          forceInternal: true,
        },
      })),
  ]);
  const audits: AuditInput[] = [];
  for (const m of made) {
    audits.push({
      action: "work_item.created",
      targetType: "WorkItem",
      targetId: m.id,
      metadata: { number: m.number, projectId: input.projectId, type: "TASK", visibility: "INTERNAL", importJobId: input.jobId },
    });
    if (!m.state.isDefault) {
      audits.push({
        action: "work_item.state_changed",
        targetType: "WorkItem",
        targetId: m.id,
        metadata: {
          from: input.defaultState.category,
          to: m.state.category,
          projectId: input.projectId,
          ...(m.state.requiresApproval ? { approval: true } : {}),
        },
      });
    }
  }
  await recordMany(tx, audits);
  // `written_at` FROM THE ROW, in SQL — never the Date passed above read
  // back through JavaScript (the pre-apply review's MEDIUM): exact to the
  // microsecond whatever Prisma did with `updatedAt`.
  await tx.$executeRaw`
    INSERT INTO import_job_item (id, tenant_id, import_job_id, work_item_id, action, written_at)
    SELECT gen_random_uuid()::text, w.tenant_id, ${input.jobId}, w.id, 'CREATED', w.updated_at
    FROM work_item w
    WHERE w.tenant_id = ${ctx.tenantId} AND w.id = ANY(${made.map((m) => m.id)}::text[])`;
  return n;
}

/**
 * A RE-IMPORT's write of one matched task (R7) — the row is locked and was
 * found updatable under that lock. Each field is compared against the
 * stored row and written only when it differs; the state goes through the
 * state machine, the description through the compare-and-set
 * `updateItemDescription` uses, labels are only ADDED. Routine edits: history
 * rows, no audit — except the state change, which audits as every state
 * change does. `true` when anything was written.
 */
async function updateMatched(
  tx: TenantDb,
  ctx: WorkCtx,
  itemId: string,
  row: CheckedImportRow,
  doc: ReturnType<typeof normalizeDescription>,
  state: StateRow,
  labelIds: ReadonlyMap<string, string>,
): Promise<boolean> {
  const item = (await loadItemRow(tx, ctx.tenantId, itemId))!;
  const ref = { id: item.id, clientId: item.clientId, projectId: item.projectId, visibility: item.visibility };
  const changes: { item: typeof ref; change: Parameters<typeof writeActivityMany>[2][number]["change"] }[] = [];
  const data: Record<string, unknown> = {};
  if (row.title !== item.title) {
    data["title"] = row.title;
    changes.push({ item: ref, change: { field: "title", oldValue: item.title, newValue: row.title } });
  }
  const oldDay = item.targetDate?.toISOString().slice(0, 10) ?? null;
  if (row.targetDate !== oldDay) {
    data["targetDate"] = row.targetDate === null ? null : new Date(`${row.targetDate}T00:00:00.000Z`);
    changes.push({ item: ref, change: { field: "targetDate", oldValue: oldDay, newValue: row.targetDate } });
  }
  if (row.assigneeMemberId !== item.assigneeMemberId) {
    data["assigneeMemberId"] = row.assigneeMemberId;
    changes.push({ item: ref, change: { field: "assignee", oldRef: item.assigneeMemberId, newRef: row.assigneeMemberId, forceInternal: true } });
  }
  let wrote = false;
  if (Object.keys(data).length > 0) {
    await tx.workItem.update({ where: { id: item.id }, data, select: { id: true } });
    wrote = true;
  }
  // The description: compared and written in ONE statement against the
  // document Postgres holds (jsonb equality, key order Postgres's).
  const stored = doc.doc === null ? null : JSON.stringify(doc.doc);
  const written = await tx.$queryRaw<{ id: string }[]>`
    UPDATE work_item
       SET description = ${stored}::jsonb,
           description_text = ${doc.text},
           checklist_total = ${doc.checklistTotal},
           checklist_done = ${doc.checklistDone},
           updated_at = now()
     WHERE tenant_id = ${ctx.tenantId} AND id = ${item.id}
       AND description IS DISTINCT FROM ${stored}::jsonb
    RETURNING id`;
  if (written.length > 0) {
    wrote = true;
    changes.push({ item: ref, change: { field: "description" } });
  }
  const add = labelIdsOf(row, labelIds);
  if (add.length > 0) {
    const fresh = await tx.workItemLabel.createManyAndReturn({
      data: add.map((labelId) => ({ tenantId: ctx.tenantId, workItemId: item.id, labelId })),
      skipDuplicates: true,
      select: { labelId: true },
    });
    for (const l of fresh) changes.push({ item: ref, change: { field: "labels", oldRef: null, newRef: l.labelId } });
    if (fresh.length > 0) wrote = true;
  }
  await writeActivityMany(tx, ctx, changes);
  if (state.id !== item.stateId) {
    // Re-read: the scalar UPDATE above may have changed the row the state
    // machine diffs (never its state columns, but it reads the whole row).
    const current = (await loadItemRow(tx, ctx.tenantId, item.id))!;
    await transitionState(tx, ctx, current, state);
    wrote = true;
  }
  return wrote;
}

/** Close the import: DONE, audited once with its counts; a second call is a no-op. */
export async function finishImport(ctx: WorkCtx, jobId: string): Promise<void> {
  await withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:create");
    const job = await tx.importJob.findFirst({
      where: { tenantId: ctx.tenantId, id: jobId },
      select: { projectId: true, status: true, startedByMemberId: true },
    });
    if (!job) deny("NOT_FOUND");
    await assertInScope(tx, ctx.actor, { projectId: job!.projectId });
    if (job!.startedByMemberId !== ctx.actor.memberId) fail("IMPORT_CLOSED");
    // Compare-and-set on RUNNING: an import already finished (or undone)
    // is not finished twice, and audits nothing more. Called by the browser
    // after its last batch WHETHER OR NOT a batch was refused, so the trail
    // says when the run ended; a run that stopped short says so through its
    // counts (`rows` against `processed`), and the list shows it as stopped
    // part-way (the code review). `greatest(…)`: this instance's clock must
    // never fail `import_job_times_ordered`.
    const done = await tx.$queryRaw<
      { created_count: number; updated_count: number; kept_count: number; unchanged_count: number; row_count: number }[]
    >`
      UPDATE import_job
         SET status = 'DONE', finished_at = greatest(started_at, last_write_at, ${NOW()})
       WHERE tenant_id = ${ctx.tenantId} AND id = ${jobId} AND status = 'RUNNING'
      RETURNING created_count, updated_count, kept_count, unchanged_count, row_count`;
    if (done.length === 0) return;
    const c = done[0]!;
    const processed = c.created_count + c.updated_count + c.kept_count + c.unchanged_count;
    await record(tx, {
      action: "import_job.finished",
      targetType: "ImportJob",
      targetId: jobId,
      metadata: {
        projectId: job!.projectId,
        rows: c.row_count,
        created: c.created_count,
        updated: c.updated_count,
        kept: c.kept_count,
        unchanged: c.unchanged_count,
        stopped: processed < c.row_count,
      },
    });
  });
}

// ── The list, undo and Bring back ───────────────────────────────────

export type ImportListEntry = {
  readonly id: string;
  readonly source: ImportSource;
  readonly fileName: string;
  readonly startedAt: Date;
  readonly startedBy: string | null;
  /** RUNNING untouched for `IMPORT_STALE_MS` reads STOPPED — the browser stopped part-way (R11). */
  readonly status: "RUNNING" | "STOPPED" | "DONE" | "UNDONE";
  readonly rowCount: number;
  readonly created: number;
  readonly updated: number;
  readonly kept: number;
  readonly unchanged: number;
  readonly undone: number | null;
  readonly restored: boolean;
  /** THIS viewer may press it now (the code, the window, the state). */
  readonly canUndo: boolean;
  readonly canRestore: boolean;
};

export async function listImports(ctx: WorkCtx, projectId: string): Promise<ImportListEntry[]> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    const project = await gateImporter(tx, ctx, projectId);
    const archived = project.status === "ARCHIVED";
    const mayDelete = await isAuthorized(tx, ctx.actor, "work_item:delete");
    const jobs = await tx.importJob.findMany({
      where: { tenantId: ctx.tenantId, projectId },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: 50,
    });
    const memberIds = [...new Set(jobs.map((j) => j.startedByMemberId))];
    const names = new Map(
      (
        await tx.member.findMany({
          where: { tenantId: ctx.tenantId, id: { in: memberIds } },
          select: { id: true, user: { select: { name: true } } },
        })
      ).map((m) => [m.id, m.user.name]),
    );
    const now = NOW();
    return jobs.map((j) => {
      // "Stopped part-way" is a run that did not take every row it declared —
      // a browser closed mid-run (never finished, gone quiet) or a batch the
      // server refused (finished short) — keyed on `finishedAt` and the
      // counts, never the status alone: a stale RUNNING job undone and
      // brought back returns to DONE with no finish (the pre-apply review),
      // and a refused run is finished DONE (the code review).
      const processed = j.createdCount + j.updatedCount + j.keptCount + j.unchangedCount;
      const fresh = now.getTime() - j.lastWriteAt.getTime() <= IMPORT_STALE_MS;
      const status: ImportListEntry["status"] =
        j.status === "UNDONE"
          ? "UNDONE"
          : j.finishedAt !== null && processed >= j.rowCount
            ? "DONE"
            : j.finishedAt === null && j.status === "RUNNING" && fresh
              ? "RUNNING"
              : "STOPPED";
      return {
        id: j.id,
        source: j.source as ImportSource,
        fileName: j.fileName,
        startedAt: j.startedAt,
        startedBy: names.get(j.startedByMemberId) ?? null,
        status,
        rowCount: j.rowCount,
        created: j.createdCount,
        updated: j.updatedCount,
        kept: j.keptCount,
        unchanged: j.unchangedCount,
        undone: j.undoneCount,
        restored: j.restoredAt !== null,
        canUndo: mayDelete && (status === "DONE" || status === "STOPPED") && j.undoneAt === null && undoOpen(j.lastWriteAt, now),
        // Not into an archived project — the server refuses it (ARCHIVED).
        canRestore: mayDelete && !archived && j.status === "UNDONE" && j.undoneAt !== null && restoreOpen(j.undoneAt, now),
      };
    });
  });
}

/**
 * The job, gated for undo / Bring back: `work_item:delete`, the project in
 * scope — then the queue, then the job row locked and read again.
 */
async function lockJobForDelete(tx: TenantDb, ctx: WorkCtx, jobId: string) {
  await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:delete");
  const probe = await tx.importJob.findFirst({ where: { tenantId: ctx.tenantId, id: jobId }, select: { projectId: true } });
  if (!probe) deny("NOT_FOUND");
  await assertInScope(tx, ctx.actor, { projectId: probe!.projectId });
  await lockProjectRanks(tx, probe!.projectId);
  const [job] = await tx.$queryRaw<
    { project_id: string; status: string; last_write_at: Date; undone_at: Date | null; restored_at: Date | null }[]
  >`
    SELECT project_id, status, last_write_at, undone_at, restored_at
    FROM import_job WHERE tenant_id = ${ctx.tenantId} AND id = ${jobId}
    FOR UPDATE`;
  if (!job) deny("NOT_FOUND");
  return job!;
}

/**
 * UNDO (R9): the tasks this import MADE go to the bin under ONE stamp —
 * except any someone has worked on since (a live comment, an attached file,
 * logged hours, a live subtask, a contact assignee, shared with the client),
 * which are kept and counted. Once per import, within 7 days of its last
 * write. Nothing cascades: a removed task has no comment and no file.
 */
export async function undoImport(ctx: WorkCtx, jobId: string): Promise<{ removed: number; kept: number }> {
  return withTenant(
    ctx.tenantId,
    principalOf(ctx),
    async (tx) => {
      const job = await lockJobForDelete(tx, ctx, jobId);
      const now = NOW();
      if (job.undone_at !== null || job.status === "UNDONE" || !undoOpen(job.last_write_at, now)) fail("IMPORT_UNDO_CLOSED");
      // ONE statement: the candidates locked, binned under one stamp, and —
      // for each one still untouched since an import wrote it — that import
      // write's `written_at` moved to the same stamp. The undo is the
      // import's own act, not a person's change, so a task brought back
      // later is still one a re-import may update (R7; the pre-apply review's
      // note on `updated_at`). `updated_at` is bumped because the board's
      // freshness poll reads it (`projectWorkVersion`). A data-modifying CTE
      // runs to completion whether or not the outer query reads it.
      let removed = await tx.$queryRaw<{ id: string; number: number }[]>`
        WITH cand AS (
          SELECT w.id, w.updated_at AS old
          FROM work_item w
          WHERE w.tenant_id = ${ctx.tenantId} AND w.project_id = ${job.project_id} AND w.deleted_at IS NULL
            AND EXISTS (SELECT 1 FROM import_job_item i
                        WHERE i.tenant_id = w.tenant_id AND i.import_job_id = ${jobId}
                          AND i.work_item_id = w.id AND i.action = 'CREATED')
            AND w.visibility = 'INTERNAL' AND w.assignee_contact_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM work_item c
                            WHERE c.tenant_id = w.tenant_id AND c.parent_id = w.id AND c.deleted_at IS NULL)
            AND NOT EXISTS (SELECT 1 FROM comment m
                            WHERE m.tenant_id = w.tenant_id AND m.subject_type = 'WORK_ITEM'
                              AND m.subject_id = w.id AND m.deleted_at IS NULL)
            AND NOT EXISTS (SELECT 1 FROM document d
                            WHERE d.tenant_id = w.tenant_id AND d.attached_to_type = 'WORK_ITEM'
                              AND d.attached_to_id = w.id AND d.deleted_at IS NULL)
            AND NOT EXISTS (SELECT 1 FROM time_entry e WHERE e.tenant_id = w.tenant_id AND e.work_item_id = w.id AND e.deleted_at IS NULL)
          FOR UPDATE OF w
        ), binned AS (
          UPDATE work_item w SET deleted_at = ${now}, updated_at = ${now}
          FROM cand
          WHERE w.tenant_id = ${ctx.tenantId} AND w.id = cand.id
          RETURNING w.id, w.number, cand.old
        ), refreshed AS (
          UPDATE import_job_item i SET written_at = ${now}
          FROM binned
          WHERE i.tenant_id = ${ctx.tenantId} AND i.work_item_id = binned.id AND i.written_at = binned.old
          RETURNING i.id
        )
        SELECT id, number FROM binned`;
      // …AND CHECKED AGAIN, in a NEW statement (a new snapshot), now that this
      // transaction holds every binned row. A comment, a file, an hour or a
      // subtask that was being added while the statement above waited on a
      // task's row lock committed AFTER that statement's snapshot, so its
      // NOT EXISTS could not see it — `deleteItem` counts children after it
      // holds the row for the same reason (the security review's low). Such
      // a task goes back as it was: someone is working on it — with
      // `updated_at` the undo's own stamp, which its `written_at` was just
      // moved to, so a later re-import still finds it untouched (the fix
      // round's re-check). A comment, file or subtask still in flight now
      // waits on this transaction and then finds the task gone. ONE RESIDUAL,
      // shared with `deleteItem`: a time entry reads its task without a lock
      // and takes only the foreign key's KEY SHARE, so an hour being logged at
      // this very moment can still land on a binned task (Bring back returns
      // it with its hour).
      const reclaimed =
        removed.length === 0
          ? []
          : await tx.$queryRaw<{ id: string }[]>`
              UPDATE work_item w SET deleted_at = NULL, updated_at = ${now}
              WHERE w.tenant_id = ${ctx.tenantId} AND w.id = ANY(${removed.map((r) => r.id)}::text[])
                AND (EXISTS (SELECT 1 FROM work_item c
                             WHERE c.tenant_id = w.tenant_id AND c.parent_id = w.id AND c.deleted_at IS NULL)
                  OR EXISTS (SELECT 1 FROM comment m
                             WHERE m.tenant_id = w.tenant_id AND m.subject_type = 'WORK_ITEM'
                               AND m.subject_id = w.id AND m.deleted_at IS NULL)
                  OR EXISTS (SELECT 1 FROM document d
                             WHERE d.tenant_id = w.tenant_id AND d.attached_to_type = 'WORK_ITEM'
                               AND d.attached_to_id = w.id AND d.deleted_at IS NULL)
                  OR EXISTS (SELECT 1 FROM time_entry e
                             WHERE e.tenant_id = w.tenant_id AND e.work_item_id = w.id AND e.deleted_at IS NULL))
              RETURNING w.id`;
      if (reclaimed.length > 0) {
        const back = new Set(reclaimed.map((r) => r.id));
        removed = removed.filter((r) => !back.has(r.id));
      }
      const liveRows = await tx.$queryRaw<{ live: number }[]>`
        SELECT count(*)::int AS live FROM work_item w
        WHERE w.tenant_id = ${ctx.tenantId} AND w.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM import_job_item i
                      WHERE i.tenant_id = w.tenant_id AND i.import_job_id = ${jobId}
                        AND i.work_item_id = w.id AND i.action = 'CREATED')`;
      await tx.importJob.update({
        where: { id: jobId },
        data: { status: "UNDONE", undoneAt: now, undoneByMemberId: ctx.actor.memberId, undoneCount: removed.length },
        select: { id: true },
      });
      await recordMany(tx, [
        ...removed.map(
          (w) =>
            ({
              action: "work_item.deleted",
              targetType: "WorkItem",
              targetId: w.id,
              metadata: { number: w.number, projectId: job.project_id, reason: "import_undone", importJobId: jobId },
            }) as const,
        ),
        {
          action: "import_job.undone",
          targetType: "ImportJob",
          targetId: jobId,
          metadata: { projectId: job.project_id, removed: removed.length, kept: liveRows[0]?.live ?? 0 },
        },
      ]);
      return { removed: removed.length, kept: liveRows[0]?.live ?? 0 };
    },
    { timeoutMs: 60_000 },
  );
}

/**
 * BRING BACK (R10): the tasks THIS import's undo removed — exactly its
 * stamp — return, except one whose (source, id) has a live twin by now
 * (a re-import after the undo), which stays in the bin and is counted.
 * Within 30 days of the undo; the project not archived.
 */
export async function restoreImport(ctx: WorkCtx, jobId: string): Promise<{ restored: number; skipped: number }> {
  return withTenant(
    ctx.tenantId,
    principalOf(ctx),
    async (tx) => {
      const job = await lockJobForDelete(tx, ctx, jobId);
      const now = NOW();
      if (job.status !== "UNDONE" || job.undone_at === null || !restoreOpen(job.undone_at, now)) fail("IMPORT_RESTORE_CLOSED");
      const project = await tx.project.findFirst({ where: { tenantId: ctx.tenantId, id: job.project_id }, select: { status: true } });
      if (project?.status === "ARCHIVED") fail("ARCHIVED");
      // The undo's stamp, exactly — read in SQL, never round-tripped through
      // a Date. The same refresh as the undo's: a task untouched before the
      // undo (its import write moved to the stamp) stays updatable.
      const back = await tx.$queryRaw<{ id: string; number: number }[]>`
        WITH stamp AS (
          SELECT j.undone_at FROM import_job j WHERE j.tenant_id = ${ctx.tenantId} AND j.id = ${jobId}
        ), back AS (
          UPDATE work_item w SET deleted_at = NULL, updated_at = ${now}
          FROM stamp
          WHERE w.tenant_id = ${ctx.tenantId} AND w.project_id = ${job.project_id}
            AND w.deleted_at = stamp.undone_at
            AND EXISTS (SELECT 1 FROM import_job_item i
                        WHERE i.tenant_id = w.tenant_id AND i.import_job_id = ${jobId}
                          AND i.work_item_id = w.id AND i.action = 'CREATED')
            -- Every task the undo removed was private with no contact
            -- assignee; Bring back can therefore never publish anything (the
            -- security review's nit: a task deleted by hand in the same
            -- millisecond as the stamp would otherwise match).
            AND w.visibility = 'INTERNAL' AND w.assignee_contact_id IS NULL
            -- A task someone moved under a parent that has since been deleted
            -- stays in the bin and is counted: work_item_restore_guard would
            -- refuse the whole statement, and every later Bring back with it
            -- (the fix round's re-check).
            AND (w.parent_id IS NULL OR EXISTS (
                  SELECT 1 FROM work_item p
                  WHERE p.tenant_id = w.tenant_id AND p.id = w.parent_id AND p.deleted_at IS NULL))
            AND (w.source_id IS NULL OR NOT EXISTS (
                  SELECT 1 FROM work_item o
                  WHERE o.tenant_id = w.tenant_id AND o.project_id = w.project_id
                    AND o.source_system = w.source_system AND o.source_id = w.source_id
                    AND o.source_id IS NOT NULL AND o.deleted_at IS NULL))
          RETURNING w.id, w.number
        ), refreshed AS (
          UPDATE import_job_item i SET written_at = ${now}
          FROM back, stamp
          WHERE i.tenant_id = ${ctx.tenantId} AND i.work_item_id = back.id AND i.written_at = stamp.undone_at
          RETURNING i.id
        )
        SELECT id, number FROM back`;
      const undone = await tx.importJob.findFirst({ where: { id: jobId }, select: { undoneCount: true } });
      const skipped = Math.max(0, (undone?.undoneCount ?? 0) - back.length);
      // `greatest(…)`: this instance's clock must never fail
      // `import_job_restored_shape` (restored_at ≥ undone_at).
      await tx.$executeRaw`
        UPDATE import_job
           SET status = 'DONE', restored_at = greatest(undone_at, ${now}), restored_by_member_id = ${ctx.actor.memberId}
         WHERE tenant_id = ${ctx.tenantId} AND id = ${jobId}`;
      await recordMany(tx, [
        ...back.map(
          (w) =>
            ({
              action: "work_item.restored",
              targetType: "WorkItem",
              targetId: w.id,
              metadata: { number: w.number, projectId: job.project_id, reason: "import_restored", importJobId: jobId },
            }) as const,
        ),
        {
          action: "import_job.restored",
          targetType: "ImportJob",
          targetId: jobId,
          metadata: { projectId: job.project_id, restored: back.length, skipped },
        },
      ]);
      return { restored: back.length, skipped };
    },
    { timeoutMs: 60_000 },
  );
}
