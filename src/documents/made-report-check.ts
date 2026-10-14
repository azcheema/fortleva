import type { TenantDb } from "@/db";
import { AuthzError } from "@/authz/errors";
import { DomainError, fail } from "@/lib/domain-error";
import { lockProjectRanks } from "@/modules/work/rank-lock";
import { PORTAL_CAPABILITIES, profileHolds, synthesiseContactPrincipal, type PortalPrincipal, type SynthesisableContact } from "@/portal";

import { contentFingerprint, deriveMadeReportContent, type MadeReportContent } from "./made-report-content";

/**
 * WHOSE VIEW A MADE REPORT IS READ AS, AND THE PUBLISH CHECK (Phase 7 slice
 * 119; founder decision C95; design
 * docs/research/2026-10-15-slice-119-monthly-report-design.md §2.1, §3.2).
 * Its own module so that `./reports.ts` (the publish) and `./made-reports.ts`
 * (the making) share it without importing each other.
 */

// ── Whose view ───────────────────────────────────────────────────────

export type AudienceContact = SynthesisableContact & { readonly portalProfile: string };

/** How many capabilities a profile holds — the preview's `width`, used the other way round. */
const width = (profile: string): number => PORTAL_CAPABILITIES.filter((c) => profileHolds(profile, c)).length;

/**
 * The contact a report is read AS: among the client's people who could sign
 * in now, the one whose profile holds the FEWEST capabilities — so the report
 * never shows more than the least-seeing reader's portal; ties by `invitedAt`
 * then id. `preferId` (the publish check) keeps the SAME person as the making
 * while they still qualify, so a report made as a collaborator is checked as
 * one. Null when nobody qualifies.
 */
export async function audienceContact(
  tx: TenantDb,
  tenantId: string,
  clientId: string,
  preferId?: string,
): Promise<AudienceContact | null> {
  const contacts = await tx.contact.findMany({
    where: { tenantId, clientId, portalStatus: "ACTIVE", invitedAt: { not: null }, emailVerified: true },
    select: { id: true, tenantId: true, clientId: true, portalProfile: true },
    orderBy: [{ invitedAt: "asc" }, { id: "asc" }],
  });
  // THE BELT the preview and the builder carry: under `tenant_isolation`
  // this read cannot return another tenant's contact, so it fires only when
  // a GUC and a row disagree — which is exactly when one wants it to.
  if (contacts.some((c) => c.tenantId !== tenantId)) fail("INVALID_INPUT", "contact tenant does not match");
  if (contacts.length === 0) return null;
  const preferred = preferId ? contacts.find((c) => c.id === preferId) : undefined;
  if (preferred) return preferred;
  // `sort` is stable: the query's order survives ties.
  return [...contacts].sort((a, b) => width(a.portalProfile) - width(b.portalProfile))[0]!;
}

/**
 * The content as the audience contact, with a projection's refusal (the
 * person paused meanwhile, the portal or the reports module closed) answered
 * as MADE_REPORT_NO_AUDIENCE — a fact about the member's own tenant, which
 * is why it is a DomainError and not the AuthzError (AUTHZ §8's member-side
 * half, `CONTACT_NOT_VIEWABLE`'s reasoning).
 */
export async function deriveAsAudience(
  principal: PortalPrincipal,
  input: { month: string; timezone: string; projectIds: readonly string[] },
): Promise<MadeReportContent> {
  try {
    return await deriveMadeReportContent(principal, input);
  } catch (e) {
    if (e instanceof AuthzError) return fail("MADE_REPORT_NO_AUDIENCE", e.reason);
    throw e;
  }
}

// ── The publish check ────────────────────────────────────────────────

export type MadeReportRecord = {
  readonly documentId: string;
  readonly projectIds: readonly string[];
  readonly taskIds: readonly string[];
  readonly updateIds: readonly string[];
  readonly asContactId: string;
  readonly contentSha256: string;
};

/**
 * THE PUBLISH CHECK (design §3.2, R3) — called by `publishReport` INSIDE the
 * flip's transaction, on a made report only, after its gates:
 *
 *  1. The rows the PDF names — its projects, tasks and updates — are
 *     SHARE-LOCKED under the member's transaction, in id order, one statement
 *     a table: a make-private, an unpublish, a retraction, an archive, a
 *     section or portal switch (all UPDATEs of these rows) now wait for this
 *     transaction, or have already committed before the derivation below
 *     reads. (`FOR SHARE` consults the UPDATE policies — the member holds
 *     them.) The time report's publish learnt this from a review (slice 72).
 *  2. The content is derived AGAIN, as the client — the SAME contact as the
 *     making while they still qualify, else the narrowest now — through the
 *     portal's own projections in their own contact transactions (plain
 *     SELECTs, which no FOR SHARE blocks).
 *  3. Its fingerprint must equal the row's; a difference is MADE_REPORT_STALE
 *     and the caller's transaction rolls back — nothing audited, nothing
 *     changed. Nobody who could read it: MADE_REPORT_NO_AUDIENCE.
 *
 * What a new DONE-and-shared task between the derivation and the flip means
 * is said in the design: the PDF omits a line the portal shows — the safe
 * direction; the dangerous one, a named row going private, is locked.
 */
export async function checkMadeReport(
  tx: TenantDb,
  tenantId: string,
  clientId: string,
  made: MadeReportRecord,
  timezone: string,
  month: string,
): Promise<{ contentSha256: string; asContactId: string }> {
  // EVERY NAMED ROW MUST LOCK (the code review's medium): a locking SELECT
  // under RLS silently leaves out a row a policy hides — it does not refuse
  // — and a hard-deleted id returns nothing. A row this transaction cannot
  // lock is a row that has changed, so a shortfall is MADE_REPORT_STALE,
  // and a future member-side UPDATE policy on one of these tables would
  // then fail CLOSED here instead of quietly un-locking the check.
  const lock = async (table: "project" | "work_item" | "project_update", ids: readonly string[]) => {
    if (ids.length === 0) return;
    const sorted = [...new Set(ids)].sort();
    let rows: { id: string }[];
    if (table === "project") {
      rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM project WHERE tenant_id = ${tenantId} AND id = ANY(${sorted}::text[]) ORDER BY id FOR SHARE`;
    } else if (table === "work_item") {
      rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM work_item WHERE tenant_id = ${tenantId} AND id = ANY(${sorted}::text[]) ORDER BY id FOR SHARE`;
    } else {
      rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM project_update WHERE tenant_id = ${tenantId} AND id = ANY(${sorted}::text[]) ORDER BY id FOR SHARE`;
    }
    if (rows.length !== sorted.length) fail("MADE_REPORT_STALE", `a named ${table} row could not be locked`);
  };
  // BEHIND EACH PROJECT'S QUEUE FIRST (`rank-lock.ts`: every writer that
  // locks many `work_item` rows of a project takes it before its first row
  // lock — the time report's publish check does, for the same reason). The
  // share-locks below are taken in id order, which no bulk edit (scan
  // order) or make-private cascade (level by level, itself queued) keeps,
  // so unqueued they could cycle with one — and a bulk edit that lost that
  // deadlock has no retry. The projects in SORTED order, so two publishes
  // naming the same projects cannot cycle among themselves either (the
  // security review's medium).
  for (const projectId of [...new Set(made.projectIds)].sort()) await lockProjectRanks(tx, projectId);
  await lock("project", made.projectIds);
  await lock("work_item", made.taskIds);
  await lock("project_update", made.updateIds);

  const contact = await audienceContact(tx, tenantId, clientId, made.asContactId);
  if (!contact) return fail("MADE_REPORT_NO_AUDIENCE");
  const principal = await synthesiseContactPrincipal(tenantId, contact);
  let content: MadeReportContent;
  try {
    content = await deriveAsAudience(principal, { month, timezone, projectIds: made.projectIds });
  } catch (e) {
    // A project the client could see at the making and cannot now (its
    // portal off, archived) is the content having changed — the same answer
    // as any other difference, and the same remedy.
    if (e instanceof DomainError && e.code === "MADE_REPORT_PROJECT_HIDDEN") return fail("MADE_REPORT_STALE", "a project is no longer the client's to see");
    throw e;
  }
  const sha = contentFingerprint(content);
  if (sha !== made.contentSha256) fail("MADE_REPORT_STALE", "the client's view changed since the report was made");
  return { contentSha256: sha, asContactId: contact.id };
}
