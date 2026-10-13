import { AuthzError } from "@/authz/errors";
import type { TenantDb } from "@/db";
import { authorizePortal, withPortalRead, type PortalPrincipal } from "@/portal";
import type { PortalApprovalState, PortalPendingApproval } from "@/portal/signoff";

import { readPortalFileVersions } from "./portal-writes";

/**
 * THE DOCUMENTS MODULE'S PORTAL PROJECTION — READS ONLY, under the
 * contact principal, allow-listed (the four rules `src/modules/work/
 * portal.ts` states at its head apply here unchanged; both tripwire
 * tiers scan this file).
 *
 * WHAT A CLIENT IS TOLD ABOUT A FILE: its name, what kind of thing it
 * is (a deliverable, a report, or just a file — `Document.kind`, which
 * DATA_MODEL §6.8 says exists to drive exactly this grouping), which
 * project it belongs to if any, the newest version's number, date, size
 * and type, and — on a DELIVERABLE, since the sign-off slice — where
 * the ask to sign it off stands, with the version it was about. Nothing
 * else: no tags, no uploader, no anchor, no key.
 *
 * THE VERSION FACTS DO NOT COME FROM THIS TRANSACTION, and that is the
 * one thing this projection does that no other does. `file_version` is
 * class A (`portal_deny`), so the read here returns the DOCUMENT rows
 * `portal_gate` admits, and `readPortalFileVersions`
 * (`./portal-writes.ts`) then reads their versions as `system`, bounded
 * by those ids and by the gate's terms restated on the joined row. A
 * document whose newest bytes are not COMMITTED — an upload still in
 * flight, or one whose object was removed — is DROPPED from the list
 * rather than shown without a version: a file the client cannot have
 * is not a file the client is told about.
 */

export type PortalDocumentKind = "GENERAL" | "DELIVERABLE";

/**
 * The order the page groups by: what the agency delivered first, then
 * everything else it shared (UI.md §4 item 6, "Files & deliverables").
 * REPORTS ARE NOT FILES HERE (Phase 6 slice 115, C91 (b)): they have their
 * own page, `listPortalReports` below, so nothing shows twice.
 */
export const PORTAL_DOCUMENT_KINDS: readonly PortalDocumentKind[] = ["DELIVERABLE", "GENERAL"];

export type PortalDocument = {
  readonly id: string;
  readonly name: string;
  readonly kind: PortalDocumentKind;
  /** The project it belongs to, or null for a file shared with the company itself. */
  readonly project: { readonly id: string; readonly key: string; readonly name: string } | null;
  /** The newest committed version — always present on a listed row. */
  readonly version: {
    readonly number: number;
    readonly at: Date;
    readonly sizeBytes: number;
    readonly contentType: string;
  };
  /**
   * The sign-off ask on a DELIVERABLE, null on every other kind. Carries
   * the version number the ask was about beside the state, because the
   * newest version (above) may be later than what the client approved —
   * DATA_MODEL §6.8's reason for the column.
   */
  readonly approval: (PortalApprovalState & { readonly versionNumber: number | null }) | null;
};

export type PortalDocumentList = {
  /** Deliverables, then the rest; newest version first within each. */
  readonly documents: readonly PortalDocument[];
  /** True when `PORTAL_DOCUMENT_LIMIT` cut the list short. */
  readonly truncated: boolean;
};

/**
 * The most files one read returns. A cap rather than a pager, for the
 * reason `PORTAL_TASK_LIMIT` gives: a client with more shared files
 * than this is a signal about the tenant's sharing, not a paging
 * problem.
 */
export const PORTAL_DOCUMENT_LIMIT = 200;

const KIND_ORDER: Record<PortalDocumentKind, number> = { DELIVERABLE: 0, GENERAL: 1 };

const isPortalKind = (kind: string): kind is PortalDocumentKind => kind in KIND_ORDER;

/**
 * THE CLIENT-VISIBLE FILES — every shared document of the contact's own
 * client, or of one portal-enabled project of it.
 *
 * WHAT THE `where` DOES AND DOES NOT DO: the tenant, the client, the
 * visibility and `portal_enabled` (TRUE for a client-level document by
 * the stamp trigger's rule) are `portal_gate`'s under this principal,
 * repeated as defence in depth. What the policy does not carry and this
 * must: the soft delete, the PROJECT's archive (the gap every portal
 * projection documents), and EXPORT — a tenant's own data export is
 * never a client's file, whatever visibility somebody set on it — and,
 * since slice 115, REPORT, which is `listPortalReports`'.
 */
export async function listPortalDocuments(
  principal: PortalPrincipal,
  opts?: { readonly projectId?: string },
): Promise<PortalDocumentList> {
  const projectId = opts?.projectId;
  const { rows, mayApprove } = await withPortalRead(principal, async (tx) => {
    await authorizePortal(
      tx,
      principal,
      "portal.document.view",
      // A narrowed read names its resource; an unnarrowed list is gated
      // row by row (`PortalScopeRef`).
      projectId ? { kind: "project", projectId } : undefined,
    );
    // MAY THIS READER SIGN A DELIVERABLE OFF — asked once, without
    // throwing, for every deliverable's `canDecide`: a collaborator reads
    // the ask's state and gets no control (the timeline's shape).
    let mayApprove = true;
    try {
      await authorizePortal(tx, principal, "portal.deliverable.approve", projectId ? { kind: "project", projectId } : undefined);
    } catch (e) {
      if (!(e instanceof AuthzError)) throw e;
      mayApprove = false;
    }
    const rows = await tx.document.findMany({
      where: {
        tenantId: principal.tenantId,
        clientId: principal.clientId,
        visibility: "CLIENT_VISIBLE",
        portalEnabled: true,
        deletedAt: null,
        kind: { notIn: ["EXPORT", "REPORT"] },
        ...(projectId
          ? { projectId, project: { archivedAt: null } }
          : { OR: [{ projectId: null }, { project: { archivedAt: null } }] }),
      },
      select: {
        id: true,
        name: true,
        kind: true,
        approvalStatus: true,
        approvalDecidedAt: true,
        approvalNote: true,
        approvalVersionNumber: true,
        project: { select: { id: true, key: true, name: true } },
      },
      // THE CAP IS CUT BY `updatedAt`, which `addVersion` bumps, so a
      // document whose newest version arrived yesterday stays inside the
      // cap however old the document is — the final order is by the
      // newest VERSION, which only the brokered read knows, and cutting by
      // creation would have taken a stale document over a fresh version
      // (code review). A rename bumps it too, which errs toward showing.
      // `truncated` says more shared documents exist than the cap; a
      // document inside the cap with no committed bytes yet is dropped
      // below and not re-filled from beyond it — an upload in flight is
      // a state that lasts minutes, and the cap is a signal about the
      // tenant's sharing, not a pager.
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      take: PORTAL_DOCUMENT_LIMIT + 1,
    });
    return { rows, mayApprove };
  });

  const truncated = rows.length > PORTAL_DOCUMENT_LIMIT;
  const page = truncated ? rows.slice(0, PORTAL_DOCUMENT_LIMIT) : rows;

  // SEQUENTIAL, after the contact's transaction has closed — its own
  // two transactions, bounded by the ids just proved.
  const versions = await readPortalFileVersions(
    principal,
    page.map((d) => d.id),
    { newestPerDocument: true },
  );
  const newest = new Map(versions.map((v) => [v.documentId, v]));

  const documents: PortalDocument[] = [];
  for (const row of page) {
    const version = newest.get(row.id);
    // EXPORT and REPORT are excluded by the `where`; the guard keeps the
    // type honest rather than asserted, and drops the file with no
    // committed bytes.
    if (!version || !isPortalKind(row.kind)) continue;
    documents.push({
      id: row.id,
      name: row.name,
      kind: row.kind,
      project: row.project ? { id: row.project.id, key: row.project.key, name: row.project.name } : null,
      version: {
        number: version.versionNumber,
        at: version.at,
        sizeBytes: version.sizeBytes,
        contentType: version.contentType,
      },
      approval:
        row.kind === "DELIVERABLE"
          ? {
              status: row.approvalStatus,
              decidedAt: row.approvalDecidedAt,
              note: row.approvalNote,
              versionNumber: row.approvalVersionNumber,
              canDecide: mayApprove && row.approvalStatus === "PENDING",
            }
          : null,
    });
  }
  documents.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      b.version.at.getTime() - a.version.at.getTime() ||
      a.name.localeCompare(b.name) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return { documents, truncated };
}

/**
 * THE DELIVERABLES WAITING ON THIS READER — every open ask of the
 * client across its projects and its company-level files, for the
 * home's "Waiting on you" card (UI.md §4: action items first).
 *
 * EMPTY, NOT REFUSED, for a profile that cannot sign: the card lists
 * what the reader can DO, and a collaborator can do nothing here — the
 * ask is still visible to them on the files list, as the word "awaiting
 * review" with no control. Asked without throwing, so the home never
 * turns a profile into the plane's empty page over a card it would omit.
 *
 * The version facts are NOT read here — a row on the card says the
 * name, the version number the ask names, and the project; the control
 * itself lives on the files list and the project page, where the file
 * layer's broker has been consulted.
 */
export async function listPortalPendingDeliverables(
  principal: PortalPrincipal,
): Promise<readonly PortalPendingApproval[]> {
  return withPortalRead(principal, async (tx) => {
    await authorizePortal(tx, principal, "portal.document.view");
    try {
      await authorizePortal(tx, principal, "portal.deliverable.approve");
    } catch (e) {
      if (!(e instanceof AuthzError)) throw e;
      return [];
    }
    const rows = await tx.document.findMany({
      where: {
        tenantId: principal.tenantId,
        clientId: principal.clientId,
        visibility: "CLIENT_VISIBLE",
        portalEnabled: true,
        deletedAt: null,
        kind: "DELIVERABLE",
        approvalStatus: "PENDING",
        OR: [{ projectId: null }, { project: { archivedAt: null } }],
      },
      select: {
        id: true,
        name: true,
        approvalVersionNumber: true,
        project: { select: { id: true, key: true, name: true } },
      },
      // Oldest ask first: the one the agency has been waiting on longest.
      orderBy: [{ approvalRequestedAt: "asc" }, { id: "asc" }],
      take: PORTAL_DOCUMENT_LIMIT,
    });
    return rows.map((row) => ({
      kind: "deliverable" as const,
      id: row.id,
      name: row.name,
      // Non-null on every PENDING row (the CHECK); the fallback keeps the
      // type honest rather than asserted.
      versionNumber: row.approvalVersionNumber ?? 0,
      project: row.project ? { id: row.project.id, key: row.project.key, name: row.project.name } : null,
    }));
  });
}

// ── Reports (Phase 6 slice 115; founder decision C91) ────────────────

/**
 * One published report, as its client's people may know it: its name, the
 * month it covers, when it was published, and its file's size and type.
 * Nothing else: no uploader, no tags, no key.
 */
export type PortalReport = {
  readonly id: string;
  readonly name: string;
  /** `YYYY-MM-01` — the month the report covers. */
  readonly month: string;
  /** When the agency (last) published it. */
  readonly publishedAt: Date;
  /** The newest committed version — always present on a listed row. */
  readonly version: { readonly at: Date; readonly sizeBytes: number; readonly contentType: string };
};

/** Same reasoning as `PORTAL_DOCUMENT_LIMIT`: a report a month for sixteen years. */
export const PORTAL_REPORT_LIMIT = 200;

/**
 * The gate's terms for a REPORT under this principal — `portal_gate`'s own
 * (tenant, client, visibility, `portal_enabled`) restated as defence in depth,
 * plus the soft delete and the kind. A report is the client's own (no project
 * — `document_report_company_level`), so no project's archive or switch
 * enters into it.
 */
const reportWhere = (principal: PortalPrincipal) => ({
  tenantId: principal.tenantId,
  clientId: principal.clientId,
  visibility: "CLIENT_VISIBLE" as const,
  portalEnabled: true,
  deletedAt: null,
  kind: "REPORT" as const,
  projectId: null,
});

/**
 * Both capabilities a report's read asks (design §4.3): `portal.report.view`
 * — the reports module and the profile (C91 (b): every profile) — and
 * `portal.document.view`, because a report is a document too.
 */
async function authorizeReports(tx: TenantDb, principal: PortalPrincipal): Promise<void> {
  await authorizePortal(tx, principal, "portal.report.view");
  await authorizePortal(tx, principal, "portal.document.view");
}

/**
 * THE CLIENT'S REPORTS PAGE (C91 (b)) — every report the agency published to
 * the contact's client, newest month first, then newest published, then by
 * name. Read under the contact's principal; the versions through the same
 * brokered read the files list uses (`readPortalFileVersions`), and a report
 * whose bytes are not committed is DROPPED, as a file is.
 */
export async function listPortalReports(principal: PortalPrincipal): Promise<readonly PortalReport[]> {
  const rows = await withPortalRead(principal, async (tx) => {
    await authorizeReports(tx, principal);
    return tx.document.findMany({
      where: reportWhere(principal),
      select: { id: true, name: true, reportMonth: true, reportPublishedAt: true },
      orderBy: [{ reportMonth: "desc" }, { reportPublishedAt: "desc" }, { name: "asc" }, { id: "asc" }],
      take: PORTAL_REPORT_LIMIT,
    });
  });
  // SEQUENTIAL, after the contact's transaction has closed — the files list's shape.
  const versions = await readPortalFileVersions(
    principal,
    rows.map((r) => r.id),
    { newestPerDocument: true },
  );
  const newest = new Map(versions.map((v) => [v.documentId, v]));
  const reports: PortalReport[] = [];
  for (const row of rows) {
    const version = newest.get(row.id);
    // The CHECKs make a shared REPORT's month and stamp non-null; the guard
    // keeps the types honest, and drops a report with no committed bytes.
    if (!version || !row.reportMonth || !row.reportPublishedAt) continue;
    reports.push({
      id: row.id,
      name: row.name,
      month: row.reportMonth.toISOString().slice(0, 10),
      publishedAt: row.reportPublishedAt,
      version: { at: version.at, sizeBytes: version.sizeBytes, contentType: version.contentType },
    });
  }
  return reports;
}

/**
 * HOW MANY REPORTS THIS CONTACT CAN SEE — the nav's question ("is there a
 * Reports page for me?"), and nothing else. Zero, never a refusal: a profile
 * or module that cannot read reports simply has none to show.
 */
export async function countPortalReports(principal: PortalPrincipal): Promise<number> {
  return withPortalRead(principal, async (tx) => {
    try {
      await authorizeReports(tx, principal);
    } catch (e) {
      if (!(e instanceof AuthzError)) throw e;
      return 0;
    }
    return tx.document.count({ where: reportWhere(principal) });
  });
}

/**
 * ONE REPORT'S MONTH, IF THIS CONTACT CAN SEE IT NOW — the outbox's question
 * at send (`src/jobs/outbox.ts`, design §4.2): `YYYY-MM-01`, or null for every
 * way it cannot be seen (hidden, deleted, another client's, the person paused,
 * the portal or the reports module off, a profile without the capability).
 * Never throws an AuthzError: a refusal is an answer here, not a failure.
 */
export async function portalReportMonth(principal: PortalPrincipal, documentId: string): Promise<string | null> {
  // The belt: Prisma drops an `undefined` filter silently.
  if (typeof documentId !== "string" || documentId.length === 0) return null;
  return withPortalRead(principal, async (tx) => {
    try {
      await authorizeReports(tx, principal);
    } catch (e) {
      if (!(e instanceof AuthzError)) throw e;
      return null;
    }
    const row = await tx.document.findFirst({
      where: { id: documentId, ...reportWhere(principal) },
      select: { reportMonth: true },
    });
    return row?.reportMonth ? row.reportMonth.toISOString().slice(0, 10) : null;
  });
}
