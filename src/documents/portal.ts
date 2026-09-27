import { AuthzError } from "@/authz/errors";
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

export type PortalDocumentKind = "GENERAL" | "DELIVERABLE" | "REPORT";

/**
 * The order the page groups by: what the agency delivered first, then
 * what it reported, then everything else it shared (UI.md §4 item 6,
 * "Files & deliverables").
 */
export const PORTAL_DOCUMENT_KINDS: readonly PortalDocumentKind[] = ["DELIVERABLE", "REPORT", "GENERAL"];

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
  /** Deliverables, then reports, then the rest; newest version first within each. */
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

const KIND_ORDER: Record<PortalDocumentKind, number> = { DELIVERABLE: 0, REPORT: 1, GENERAL: 2 };

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
 * never a client's file, whatever visibility somebody set on it.
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
        kind: { not: "EXPORT" },
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
    // EXPORT is excluded by the `where`; the guard keeps the type honest
    // rather than asserted, and drops the file with no committed bytes.
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
