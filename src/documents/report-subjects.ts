import { resolveScope, type MemberActor } from "@/authz/authorize";
import type { TenantDb } from "@/db";
import { accessibleCodes } from "@/entitlements/resolver";

/**
 * WHAT "A MONTHLY REPORT IS DRAFTED AND WAITING" MAY NAME IN THE INBOX
 * (Phase 7 slice 120; founder decision C96 (c)) — the inbox's subject
 * resolution for `report.drafted`, handed over by `src/notify/inbox.ts`
 * because who may open a client's Reports tab is this module's rule.
 *
 * The notification's entity is the DOCUMENT (the draft); the row names its
 * CLIENT and links to the client's Reports tab. Under the READER's own
 * principal, at read time: named and linked only while the reader holds the
 * tab's two codes on all four gates — `document:view` + `report:view`
 * (`listClientReports`'s) — and reaches the client DIRECTLY by their scope,
 * which is what the tab the link opens asks too. Otherwise the row resolves
 * to nothing and the inbox draws the kind's label with no name and no link
 * — the same answer for a deleted draft, an out-of-scope one and a
 * not-permitted one. Never the inbox's fall-through, which would name the
 * client and link the FILES tab, which lists no report.
 *
 * Reads in SEQUENCE on the caller's transaction (AGENTS.md's trap); the
 * permission read is ONE `accessibleCodes`, never a leg.
 */

export const REPORT_SUBJECT_KINDS: readonly string[] = ["report.drafted"];

export const isReportSubjectKind = (kind: string): boolean => REPORT_SUBJECT_KINDS.includes(kind);

export type ReportSubjectRef = {
  /** The notification's id — the key of the answer. */
  readonly id: string;
  readonly kind: string;
  readonly entityType: string;
  readonly entityId: string;
};

export type ReportSubject = { readonly title: string; readonly href: string };

export async function reportSubjects(
  tx: TenantDb,
  tenantId: string,
  actor: MemberActor,
  refs: readonly ReportSubjectRef[],
): Promise<Map<string, ReportSubject>> {
  const out = new Map<string, ReportSubject>();
  const mine = refs.filter((r) => isReportSubjectKind(r.kind) && r.entityType === "Document");
  if (mine.length === 0) return out;
  const may = await accessibleCodes(tx, tenantId, actor, ["document:view", "report:view"]);
  if (!may.has("document:view") || !may.has("report:view")) return out;
  const scope = await resolveScope(tx, actor);
  const docs = await tx.document.findMany({
    where: { tenantId, id: { in: [...new Set(mine.map((r) => r.entityId))] }, kind: "REPORT", deletedAt: null },
    select: { id: true, clientId: true, client: { select: { name: true } } },
  });
  const byId = new Map(docs.map((d) => [d.id, d]));
  for (const r of mine) {
    const d = byId.get(r.entityId);
    if (!d || !d.clientId || !d.client) continue;
    // DIRECT reach only (the tab's rule): tenant-wide, or assigned to the client itself.
    if (!scope.all && !scope.directClientIds.includes(d.clientId)) continue;
    out.set(r.id, { title: d.client.name, href: `/clients/${d.clientId}/reports` });
  }
  return out;
}
