import { record } from "@/audit/record";
import { deny } from "@/authz/errors";
import { withTenant } from "@/db";
import { fail, isDeadlock, isLockTimeout } from "@/lib/domain-error";
import { attachmentDisposition } from "@/lib/http-download";
import { retryOnContention } from "@/lib/retry";
import { authorizePortal, withPortalRead, type PortalPrincipal } from "@/portal";
import { allow } from "@/ratelimit";
import { getStorage } from "@/storage";

import { assertDownloadBudget } from "./download-budget";

/**
 * THE FILE LAYER'S BROKER — the one place the portal plane reaches
 * `file_version` and `file_object`, and it reaches them as `system`.
 *
 * `portal.ts` next door is reads under the CONTACT principal, every one
 * of them decided by `portal_gate` before this code has an opinion.
 * This file exists because the file layer is class A (`portal_deny`,
 * DATA_MODEL §1.4: "the portal never queries the file layer"): a
 * contact-principal read of `file_version` returns zero rows whatever
 * the document says, so the two things a client needs from a file —
 * the bytes, and the fact that a version of it exists — cannot come
 * from a projection. They come from here, brokered, in the shape AUTHZ
 * §8 fixes for everything a contact causes that RLS will not let them
 * do themselves:
 *
 *   1. `withPortalRead` + `authorizePortal(capability, ref)` — the
 *      contact's OWN transaction decides whether this may happen. For a
 *      download the ref is the DOCUMENT, and `document`'s `portal_gate`
 *      is the three-term form, so a ref that resolves has proved the
 *      contact may read that exact file's row (`PortalScopeRef`).
 *   2. `withTenant(tenantId, {type:'system'})` — the file-layer read,
 *      with the gate's every term RESTATED on the joined document row
 *      (client, CLIENT_VISIBLE, the portal switch, the soft delete, the
 *      project's archive), so that the system transaction is bounded
 *      twice: once by the ids the contact's transaction handed it, and
 *      once by the same predicate the policy would have applied. A
 *      caller passing an id the contact may not see gets nothing.
 *   3. For the DOWNLOAD, an audit row **in the same transaction**,
 *      naming the CONTACT as actor (`brokeredForContactId`) — downloads
 *      are must-capture (SECURITY §7), and this is the row.
 *
 * IT IS A SEPARATE FILE SO THAT "THIS CODE RUNS AS SYSTEM" IS A
 * PROPERTY OF THE FILENAME (founder decision, 2026-09-20), and the
 * name is the convention's even though half of what is here READS: the
 * property the name carries is the principal, not the verb.
 * `src/portal/brokered-writes.test.ts` pins the shape of every exported
 * function — authorize under the contact before the system transaction
 * opens, an inline `{type:'system'}`, and the audit row — with
 * `readPortalFileVersions` on its named list of brokered READS, which
 * write no audit row because nothing happened.
 *
 * **A BROKERED READ IS A NARROWING OF A RULE, STATED RATHER THAN
 * SLIPPED PAST.** SECURITY.md §5.1 and TENANCY.md §7.2 say portal
 * reads never run under a system principal, because a projection built
 * under `system` has lost the RLS net. This one has not lost it: the
 * rows it reads are the file-layer children of document rows a
 * contact-principal read returned under `portal_gate`, and it can
 * return nothing about a document that read did not. What it adds is a
 * version number, a date, a size and a content type — never a member
 * id (the uploader's column is on both tripwire lists, which is why
 * this comment cannot spell it), never a key. PLAN §0 named this read
 * as the files slice's before the slice began.
 *
 * WHAT IS DELIBERATELY NOT HERE. No presign for an UPLOAD: contact
 * uploads are a later slice (SECURITY §5 "Upload path"), and a broker
 * that can mint a PUT is a different thing from one that can mint a
 * GET. No approval write: `Document`'s approval columns are the
 * sign-off slice's, which owns what a decision means for both a
 * version and a deliverable.
 */

/**
 * The download budget — the window, the limit and the count — lives in
 * `./download-budget.ts` since slice 109 shared it with the invoice PDF's
 * broker (an exported function here is a broker to the pins).
 */
export { DOWNLOAD_WINDOW_LIMIT, DOWNLOAD_WINDOW_MINUTES } from "./download-budget";

/**
 * HOW LONG THE DOWNLOAD MAY WAIT ON ITS OWN BUDGET LOCK. Short, for the
 * reason `portal-writes.ts` in the work module gives: a client pressing
 * a button should be told to try again rather than parked.
 */
const PORTAL_LOCK_WAIT_MS = 3000;

/** Presigned GETs live this long (SECURITY §5: 2–5 min). The member plane uses the same. */
const GET_EXPIRES_SEC = 60;

/**
 * The gate's terms, restated on the document row for the system
 * transaction — `portal_gate`'s three (client, CLIENT_VISIBLE, the
 * portal switch, which the stamp trigger sets TRUE for a client-level
 * document — and which is ALSO read from the project, below) plus the
 * two the policy does not carry and every portal
 * projection adds: the soft delete and the PROJECT's archive
 * (`listPortalTasks` documents the archive gap at length). And one term
 * that is this file's own: an EXPORT is a tenant's data leaving the
 * building, audited as such, and is never a client's file whatever its
 * visibility says.
 */
const documentGate = (principal: PortalPrincipal) => ({
  tenantId: principal.tenantId,
  clientId: principal.clientId,
  visibility: "CLIENT_VISIBLE" as const,
  portalEnabled: true,
  deletedAt: null,
  kind: { not: "EXPORT" as const },
  // The project's archive AND its switch, read from the project itself
  // rather than trusted to the row's copy (slice 74, C40): as the system
  // principal a relation filter is not gated by RLS, so both are written.
  OR: [{ projectId: null }, { project: { archivedAt: null, portalEnabled: true } }],
});

/**
 * DOWNLOAD A SHARED FILE (`portal.document.download`) — the newest
 * committed version of a document the contact may read, as a short-lived
 * off-origin link with `Content-Disposition: attachment` (SECURITY §5),
 * audited to the CONTACT.
 *
 * THE INPUT IS CHECKED BEFORE ANYTHING IS AUTHORIZED, the one place a
 * broker deviates from "authorize first" (the request broker records the
 * same): an empty id is a fact about the caller, and — the belt every
 * broker carries — Prisma drops an `undefined` filter silently, so a
 * blank reaching the system transaction's `where` would resolve SOME
 * document of the tenant rather than none.
 *
 * TWO TRANSACTIONS, NOT ONE INSTANT, and the honest weakness is handled
 * rather than hidden: between the contact's proof and the system read,
 * the agency could make the file private or switch the project off.
 * The system read therefore re-applies every one of the gate's terms
 * itself (`documentGate`) and answers NOT_FOUND if any has changed —
 * the same answer the contact's own transaction would have given.
 *
 * The audit row is written INSIDE the system transaction and BEFORE the
 * presign, so a link is never minted without its row. A link minted and
 * never used still counts as a download, which is the right way round
 * for a must-capture event: the URL left the building.
 */
export async function resolvePortalDownload(
  principal: PortalPrincipal,
  documentId: string,
): Promise<{ readonly url: string; readonly filename: string }> {
  if (!documentId) fail("INVALID_INPUT", "document");

  // The cheap filter in front of the fail-closed one (a no-op until
  // Upstash is provisioned — `src/ratelimit`'s own note).
  if (!(await allow("portal.document_download", principal.contactId))) {
    fail("DOWNLOAD_RATE_LIMITED", "front filter");
  }

  await withPortalRead(principal, (tx) =>
    authorizePortal(tx, principal, "portal.document.download", { kind: "document", documentId }),
  );

  // THE LOCK WAIT IS BOUNDED AND ITS EXHAUSTION IS A TYPED REFUSAL, the
  // request broker's shape: a spent `lockTimeoutMs` (55P03) or a lost
  // deadlock is retried a bounded number of times by `retryOnContention`
  // and then becomes `DOWNLOAD_BUSY` — a DomainError the portal action
  // collapses into its one generic banner — rather than a raw Postgres
  // error escaping to the error boundary (code review).
  const download = () => withTenant(
    principal.tenantId,
    { type: "system" },
    async (tx) => {
      await assertDownloadBudget(tx, principal.tenantId, principal.contactId);
      const doc = await tx.document.findFirst({
        where: { id: documentId, ...documentGate(principal) },
        select: {
          id: true,
          name: true,
          // The newest COMMITTED version — the same "newest" the list and
          // the rail show (`readPortalFileVersions` filters on status
          // too), so a member's half-finished `addVersion` cannot turn a
          // listed "v2" into a file that refuses every download (the
          // security review's one note).
          versions: {
            where: { fileObject: { status: "COMMITTED" } },
            orderBy: { versionNumber: "desc" },
            take: 1,
            select: {
              versionNumber: true,
              fileObject: { select: { r2Key: true, contentType: true } },
            },
          },
        },
      });
      const latest = doc?.versions[0];
      // NOT_FOUND for every way this can fail — a row that changed since
      // the proof, a document with no committed bytes at all — because
      // on this plane the difference between them is a fact about the
      // agency (`src/portal/action.ts` collapses it anyway).
      if (!doc || !latest) return deny("NOT_FOUND", "document");
      await record(tx, {
        action: "file.downloaded",
        targetType: "Document",
        targetId: doc.id,
        // The contact, not the system transaction — see `record()`'s own
        // note on this field. Without it the one download family whose
        // actor is not an employee would have no actor at all.
        brokeredForContactId: principal.contactId,
        // Ids and a number, never the filename: an audit row is read by
        // operators and outlives the row it describes (SECURITY §7).
        metadata: { versionNumber: latest.versionNumber, clientId: principal.clientId },
      });
      return { key: latest.fileObject.r2Key, filename: doc.name, contentType: latest.fileObject.contentType };
    },
    { lockTimeoutMs: PORTAL_LOCK_WAIT_MS },
  );
  let target: Awaited<ReturnType<typeof download>>;
  try {
    target = await retryOnContention(download);
  } catch (e) {
    if (isLockTimeout(e) || isDeadlock(e)) return fail("DOWNLOAD_BUSY", "lock waits spent");
    throw e;
  }

  // Outside the transaction: network I/O never holds a connection open.
  const url = await getStorage().presignGet(target.key, {
    expiresSec: GET_EXPIRES_SEC,
    responseContentDisposition: attachmentDisposition(target.filename),
    responseContentType: target.contentType,
  });
  return { url, filename: target.filename };
}

/**
 * One version of a shared file, as the portal may know it: which
 * document, which number, when, how big, what type. No key, no uploader.
 */
export type PortalFileVersion = {
  readonly id: string;
  readonly documentId: string;
  readonly versionNumber: number;
  readonly at: Date;
  readonly sizeBytes: number;
  readonly contentType: string;
};

/**
 * THE BROKERED READ — the versions of documents a contact-principal read
 * has already returned (`portal.document.view`).
 *
 * `newestPerDocument` answers the files list ("v3 · 1.2 MB · 12 Sep");
 * without it every version comes back newest first, to `take`, which is
 * what the Client Timeline's document branch draws — one entry per
 * delivered version (DATA_MODEL §6.16). Both are bounded by the ids the
 * caller proved AND by `documentGate` on the joined row, so a stale or
 * foreign id yields nothing rather than something.
 *
 * Only COMMITTED bytes count: a version whose object is still PENDING
 * or was DELETED is not a file the client can have, so it is not a file
 * the client is told about.
 */
export async function readPortalFileVersions(
  principal: PortalPrincipal,
  documentIds: readonly string[],
  opts: { readonly newestPerDocument?: boolean; readonly take?: number } = {},
): Promise<readonly PortalFileVersion[]> {
  // The belt: an empty list is an empty answer, never an unbounded read.
  const ids = documentIds.filter((id) => typeof id === "string" && id.length > 0);
  if (ids.length === 0) return [];

  await withPortalRead(principal, (tx) => authorizePortal(tx, principal, "portal.document.view"));

  return withTenant(principal.tenantId, { type: "system" }, async (tx) => {
    if (opts.newestPerDocument) {
      // ONE ROW PER DOCUMENT, taken by the database: a nested `take: 1`
      // is a per-parent windowed read, whereas Prisma's `distinct`
      // without the native preview fetches EVERY version and keeps one
      // in memory (code review) — and the download resolves its version
      // through this same shape, so the two agree on "newest".
      const docs = await tx.document.findMany({
        where: { id: { in: ids }, ...documentGate(principal) },
        select: {
          id: true,
          versions: {
            where: { fileObject: { status: "COMMITTED" } },
            orderBy: { versionNumber: "desc" },
            take: 1,
            select: {
              id: true,
              versionNumber: true,
              createdAt: true,
              fileObject: { select: { sizeBytes: true, contentType: true } },
            },
          },
        },
      });
      const out: PortalFileVersion[] = [];
      for (const d of docs) {
        const v = d.versions[0];
        if (!v) continue;
        out.push({
          id: v.id,
          documentId: d.id,
          versionNumber: v.versionNumber,
          at: v.createdAt,
          sizeBytes: Number(v.fileObject.sizeBytes),
          contentType: v.fileObject.contentType,
        });
      }
      return out;
    }
    // Every version, newest first, to `take` — the rail's order is by
    // instant across all its documents.
    const rows = await tx.fileVersion.findMany({
      where: {
        tenantId: principal.tenantId,
        documentId: { in: ids },
        document: documentGate(principal),
        fileObject: { status: "COMMITTED" },
      },
      select: {
        id: true,
        documentId: true,
        versionNumber: true,
        createdAt: true,
        fileObject: { select: { sizeBytes: true, contentType: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      ...(opts.take ? { take: opts.take } : {}),
    });
    return rows.map((v) => ({
      id: v.id,
      documentId: v.documentId,
      versionNumber: v.versionNumber,
      at: v.createdAt,
      sizeBytes: Number(v.fileObject.sizeBytes),
      contentType: v.fileObject.contentType,
    }));
  });
}
