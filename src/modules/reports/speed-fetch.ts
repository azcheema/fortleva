import { withTenant, type TenantDb } from "@/db";
import { moduleOpenUnderSystem } from "@/entitlements/resolver";
import { isCruxError, type CruxFormFactor, type CruxHistory, type CruxTransport } from "@/integrations/crux";
import { dateColumn } from "@/lib/duration";

import { originOf } from "./speed-shapes";

/**
 * THE WEEKLY FETCH (Phase 6 slice 118; founder decision C94 (c); design
 * docs/research/2026-10-14-slice-118-website-speed-design.md §4) — one
 * workspace's measured sites asked of Google and the answers kept as our
 * own copy. Run per workspace by `src/jobs/website-speed.ts` (the jobs
 * route), under the workspace's OWN system principal, RLS live. The ONE
 * writer of `website_speed_week`, and of `website_speed_check` but for one
 * DELETE: `updateProject` removes a project's check row when its Production
 * URL moves to another site, so the new site is asked on the next run
 * rather than a week on.
 *
 * A RUN, in order:
 *  1. The workspace: the `reports` module open (else nothing).
 *  2. The projects DUE — not archived, a Production URL set, and never
 *     checked, or checked over `REFRESH_AFTER_MS` ago, or — within
 *     `RETRY_AFTER_MS` — last FAILED on the network or REFUSED on the
 *     server's key (both pass on their own) — oldest check first, at most
 *     `PROJECTS_PER_RUN` (two Google calls each, well under Google's 150 a
 *     minute).
 *  3. For each: the URL's origin (a page URL is reduced to its site; not
 *     http(s) → REFUSED `bad_url`, no call); then phones, then computers,
 *     through the transport — OUTSIDE any transaction; then ONE short write
 *     transaction: `SELECT … FOR SHARE` on the project row (serialised with
 *     a switch press in either order — design §2.3 — and the row's
 *     `client_id` and URL taken from THAT read), every period answered so
 *     far inserted (a kind already answered is kept even when the other
 *     failed; the unique key dedupes: Google's past periods never change),
 *     the check row upserted — except on Google's per-minute quota (`rate`),
 *     which says nothing about the project: no check row, so it stays due.
 *  4. A project's failure is its own (counted; logged by id and the error's
 *     kind, never Google's text). The quota (`rate`) and a refused key
 *     (`key`) are per Google project, not per site: either ends the run for
 *     every workspace.
 *
 * `visibility` is the database's: the stamp derives it from the project's
 * switch and the row's origin, so this file never writes it.
 * `portal_enabled` is the gate's.
 */

const SYSTEM = { type: "system" } as const;

/** A project is asked again about a week after its last check (Google publishes on Mondays). */
export const REFRESH_AFTER_MS = 6 * 86_400_000;
/** …and after six hours when the last check failed for a reason that passes by itself (the network, the key). */
export const RETRY_AFTER_MS = 6 * 3_600_000;
/** Projects asked per workspace per run — two calls each. */
export const PROJECTS_PER_RUN = 40;
/** No project is begun with less than this left of the run. */
const PROJECT_MIN_LEFT_MS = 20_000;
/** The write transaction's wait on the project row (design §2.3). */
const WRITE_LOCK_WAIT_MS = 3_000;

const FORM_FACTORS: readonly CruxFormFactor[] = ["PHONE", "DESKTOP"];

export type SpeedFetchResult = {
  readonly skipped: "module" | null;
  /** Projects written (asked and recorded). */
  readonly projects: number;
  /** Rows inserted (new periods). */
  readonly weeks: number;
  readonly noData: number;
  readonly refused: number;
  readonly failed: number;
  readonly outOfTime: boolean;
  /** Google's per-minute quota met — the caller stops every workspace. */
  readonly outOfQuota: boolean;
  /** The server's key refused — the caller stops every workspace. */
  readonly keyRefused: boolean;
};

type Due = { readonly id: string; readonly production_url: string };

type Failure = { readonly outcome: "REFUSED"; readonly detail: "bad_url" | "key" | "bad_request" } | { readonly outcome: "FAILED"; readonly detail: "network" | "shape" | "rate" };

/** What Google said: the kinds answered so far (a null history is "no data"), and the failure that ended the asking, if any. */
type Answer = {
  readonly histories: readonly (readonly [CruxFormFactor, CruxHistory | null])[];
  readonly failure: Failure | null;
};

/** A CHECK the database refused the batch on — Google's shape and ours disagree; waits the week, not six hours. */
const isCheckViolation = (e: unknown): boolean => {
  const meta = typeof e === "object" && e !== null && "meta" in e ? (e as { meta?: { code?: unknown } }).meta : undefined;
  if (meta && typeof meta === "object" && meta.code === "23514") return true;
  return e instanceof Error && /violates check constraint/.test(e.message);
};

const logFailure = (projectId: string, e: unknown): void => {
  const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
  console.error(`website-speed: project ${projectId} failed: ${e instanceof Error ? e.name : typeof e}${code}`);
};

async function ask(transport: CruxTransport, origin: string, deadline: number, projectId: string): Promise<Answer> {
  const histories: (readonly [CruxFormFactor, CruxHistory | null])[] = [];
  for (const formFactor of FORM_FACTORS) {
    try {
      histories.push([formFactor, await transport.history(origin, formFactor, deadline)]);
    } catch (e) {
      if (!isCruxError(e)) {
        // Not Google's answer but a transport bug: the project's own failure,
        // never the rest of the workspace's (the security review's 3).
        logFailure(projectId, e);
        return { histories, failure: { outcome: "FAILED", detail: "network" } };
      }
      if (e.kind === "rate") return { histories, failure: { outcome: "FAILED", detail: "rate" } };
      // A refusal with no status is the key missing (the code review's 8).
      if (e.kind === "refused") return { histories, failure: { outcome: "REFUSED", detail: e.status === 400 ? "bad_request" : "key" } };
      if (e.kind === "shape") return { histories, failure: { outcome: "FAILED", detail: "shape" } };
      return { histories, failure: { outcome: "FAILED", detail: "network" } };
    }
  }
  return { histories, failure: null };
}

/** The week rows an answer yields — a period with no metric at all is not stored. */
function rowsOf(answer: Answer, base: { tenantId: string; clientId: string; projectId: string; origin: string }) {
  const rows = [];
  for (const [formFactor, h] of answer.histories) {
    if (h === null) continue;
    for (const p of h.periods) {
      if (p.lcp === null && p.inp === null && p.cls === null) continue;
      rows.push({
        ...base,
        formFactor,
        periodStart: dateColumn(p.start),
        periodEnd: dateColumn(p.end),
        lcpP75Ms: p.lcp?.p75 ?? null,
        inpP75Ms: p.inp?.p75 ?? null,
        clsP75: p.cls?.p75 ?? null,
        lcpGood: p.lcp?.good ?? null,
        lcpNeedsWork: p.lcp?.needsWork ?? null,
        lcpPoor: p.lcp?.poor ?? null,
        inpGood: p.inp?.good ?? null,
        inpNeedsWork: p.inp?.needsWork ?? null,
        inpPoor: p.inp?.poor ?? null,
        clsGood: p.cls?.good ?? null,
        clsNeedsWork: p.cls?.needsWork ?? null,
        clsPoor: p.cls?.poor ?? null,
      });
    }
  }
  return rows;
}

async function writeCheck(
  tx: TenantDb,
  tenantId: string,
  projectId: string,
  origin: string | null,
  now: Date,
  outcome: "OK" | "NO_DATA" | "REFUSED" | "FAILED",
  detail: string | null,
): Promise<void> {
  await tx.websiteSpeedCheck.upsert({
    where: { tenantId_projectId: { tenantId, projectId } },
    create: { tenantId, projectId, origin, checkedAt: now, outcome, detail },
    update: { origin, checkedAt: now, outcome, detail },
    select: { id: true },
  });
}

export async function fetchWebsiteSpeed(
  tenantId: string,
  opts: { readonly transport: CruxTransport; readonly now?: Date; readonly deadline?: number },
): Promise<SpeedFetchResult> {
  const now = opts.now ?? new Date();
  const deadline = opts.deadline ?? Date.now() + 45_000;
  const out = {
    skipped: null as "module" | null,
    projects: 0,
    weeks: 0,
    noData: 0,
    refused: 0,
    failed: 0,
    outOfTime: false,
    outOfQuota: false,
    keyRefused: false,
  };

  const due = await withTenant(tenantId, SYSTEM, async (tx) => {
    if (!(await moduleOpenUnderSystem(tx, tenantId, "reports"))) return null;
    const refreshBefore = new Date(now.getTime() - REFRESH_AFTER_MS);
    const retryBefore = new Date(now.getTime() - RETRY_AFTER_MS);
    return tx.$queryRaw<Due[]>`
      SELECT p.id, p.production_url
        FROM project p
        LEFT JOIN website_speed_check c ON c.tenant_id = p.tenant_id AND c.project_id = p.id
       WHERE p.tenant_id = ${tenantId} AND p.archived_at IS NULL AND p.production_url IS NOT NULL
         AND (c.id IS NULL
              OR c.checked_at < ${refreshBefore}
              OR ((c.outcome = 'FAILED' AND c.detail = 'network' OR c.outcome = 'REFUSED' AND c.detail = 'key')
                  AND c.checked_at < ${retryBefore}))
       ORDER BY c.checked_at ASC NULLS FIRST, p.id ASC
       LIMIT ${PROJECTS_PER_RUN}`;
  });
  if (due === null) return { ...out, skipped: "module" };

  for (const project of due) {
    if (Date.now() + PROJECT_MIN_LEFT_MS > deadline) {
      out.outOfTime = true;
      break;
    }
    const origin = originOf(project.production_url);
    // Google is asked OUTSIDE any transaction.
    const answer: Answer =
      origin === null
        ? { histories: [], failure: { outcome: "REFUSED", detail: "bad_url" } }
        : await ask(opts.transport, origin, deadline, project.id);
    const failure = answer.failure;
    try {
      const written = await withTenant(
        tenantId,
        SYSTEM,
        async (tx) => {
          // The project row, LOCKED: a switch press and this write are
          // serialised in either order (design §2.3); its client and URL are
          // taken from this read, never from the discovery above.
          const [p] = await tx.$queryRaw<{ client_id: string; production_url: string | null; archived_at: Date | null }[]>`
            SELECT client_id, production_url, archived_at FROM project
             WHERE tenant_id = ${tenantId} AND id = ${project.id} FOR SHARE`;
          if (!p || p.archived_at !== null || originOf(p.production_url) !== origin) return false;
          const rows = origin ? rowsOf(answer, { tenantId, clientId: p.client_id, projectId: project.id, origin }) : [];
          if (rows.length > 0) {
            const r = await tx.websiteSpeedWeek.createMany({ data: rows, skipDuplicates: true });
            out.weeks += r.count;
          }
          // The quota says nothing about this site: no check row, it stays due
          // (and counts as asked only if something was kept).
          if (failure?.detail === "rate") return rows.length > 0;
          if (failure === null) {
            await writeCheck(tx, tenantId, project.id, origin, now, rows.length > 0 ? "OK" : "NO_DATA", null);
            if (rows.length === 0) out.noData += 1;
          } else {
            await writeCheck(tx, tenantId, project.id, origin, now, failure.outcome, failure.detail);
            if (failure.outcome === "REFUSED") out.refused += 1;
            else out.failed += 1;
          }
          return true;
        },
        { lockTimeoutMs: WRITE_LOCK_WAIT_MS },
      );
      if (written) out.projects += 1;
    } catch (e) {
      out.failed += 1;
      logFailure(project.id, e);
      if (isCheckViolation(e)) {
        // Google's shape and ours disagree for this site: recorded as a
        // FAILED `shape`, which waits the week (the pre-apply review's 7) —
        // under the same lock and the same "still this site" rule as the
        // write it replaces, so it can never re-create a check row for a
        // URL that moved meanwhile (the fix review's low).
        try {
          await withTenant(
            tenantId,
            SYSTEM,
            async (tx) => {
              const [p] = await tx.$queryRaw<{ production_url: string | null; archived_at: Date | null }[]>`
                SELECT production_url, archived_at FROM project
                 WHERE tenant_id = ${tenantId} AND id = ${project.id} FOR SHARE`;
              if (!p || p.archived_at !== null || originOf(p.production_url) !== origin) return;
              await writeCheck(tx, tenantId, project.id, origin, now, "FAILED", "shape");
            },
            { lockTimeoutMs: WRITE_LOCK_WAIT_MS },
          );
        } catch {
          // The next run tries again.
        }
      }
    }
    if (failure?.detail === "rate") {
      out.outOfQuota = true;
      break;
    }
    if (failure?.detail === "key") {
      out.keyRefused = true;
      break;
    }
  }
  return out;
}
