import { record } from "@/audit/record";
import { assertInScope, type MemberActor } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { localDateString } from "@/lib/duration";
import { fail, isDeadlock, isLockTimeout } from "@/lib/domain-error";
import { newId } from "@/lib/ids";
import { retryOnContention } from "@/lib/retry";
import { readPreferences } from "@/preferences/service";

import { checkMadeReport } from "./made-report-check";
import { enqueueReportMails } from "./report-mail";
import { latestReportMonth, parseReportMonth, reportMonthDate, reportMonthOf } from "./report-month";
import { commitFileObject, softDeleteDocumentsInTx, type DocumentCtx } from "./service";

/**
 * CLIENT REPORT FILES — the team's side (Phase 6 slice 115; founder decision
 * C91; docs/research/2026-10-13-slice-115-report-files-design.md §3).
 *
 * A report is a `document` of kind REPORT: the CLIENT's (no project, no
 * anchor), covering one month (`report_month`), INTERNAL until a person
 * publishes it. The portal reaches it through `portal_gate` on `document`, as
 * every shared file; the database holds its shape (migration 20261022090000).
 * THIS FILE IS ITS ONE WRITER — the Files paths in `./service.ts` answer
 * NOT_FOUND for a REPORT row — so a report is listed, uploaded, published,
 * hidden, edited and deleted here, and only here.
 *
 * EVERY VERB IS A DOCUMENT VERB AND A REPORT VERB (design §3.1): a report is
 * both, so each asks both codes, on all four gates, in turn (AGENTS.md: never
 * a `Promise.all` leg) — and the client DIRECTLY in scope, the Files tab's
 * rule:
 *
 *   see, download        document:view               + report:view
 *   upload               document:upload             + report:upload
 *   publish, hide        document:change_visibility  + report:upload
 *   edit name and month  document:edit               + report:upload
 *   delete               document:delete             + report:delete
 *
 * A report has NO new versions: a mistake is hidden or deleted and uploaded
 * again (design §0), and its people are told about the corrected one.
 */

export type ReportCtx = DocumentCtx;

const memberPrincipal = (ctx: ReportCtx) => ({ type: "member", id: ctx.actor.memberId }) as const;

/** Both codes of one verb, awaited in turn (never a batch leg). */
async function requireBoth(tx: TenantDb, ctx: ReportCtx, documentCode: string, reportCode: string): Promise<void> {
  await requireAccess(tx, ctx.tenantId, ctx.actor, documentCode);
  await requireAccess(tx, ctx.tenantId, ctx.actor, reportCode);
}

/**
 * The UPLOAD verb's gates, for a caller that brings its own bytes — the
 * monthly report Fortleva makes (`./made-reports.ts`, Phase 7 slice 119):
 * both codes, the client directly in scope, and ACTIVE.
 */
export async function assertMayUploadReport(tx: TenantDb, ctx: ReportCtx, clientId: string): Promise<void> {
  await requireBoth(tx, ctx, "document:upload", "report:upload");
  const { archived } = await directClient(tx, ctx.actor, clientId);
  if (archived) fail("ARCHIVED", "client");
}

/** The client, directly in scope, and whether it is archived. NOT_FOUND outside scope. */
async function directClient(
  tx: TenantDb,
  actor: MemberActor,
  clientId: string,
): Promise<{ archived: boolean }> {
  await assertInScope(tx, actor, { clientId });
  const client = await tx.client.findFirst({ where: { id: clientId }, select: { status: true, archivedAt: true } });
  if (!client) deny("NOT_FOUND");
  return { archived: client!.status !== "ACTIVE" || client!.archivedAt !== null };
}

/** A live report by id — never another kind — with the client in direct scope. */
async function reportInScope(tx: TenantDb, ctx: ReportCtx, documentId: string) {
  if (!documentId) deny("NOT_FOUND");
  const doc = await tx.document.findFirst({
    where: { id: documentId, deletedAt: null, kind: "REPORT" },
    select: { id: true, name: true, clientId: true, visibility: true, reportMonth: true },
  });
  // The CHECKs make a REPORT's client and month non-null; the guard keeps the
  // types honest rather than asserted.
  if (!doc || !doc.clientId || !doc.reportMonth) return deny("NOT_FOUND");
  const { archived } = await directClient(tx, ctx.actor, doc.clientId);
  return { ...doc, clientId: doc.clientId, month: reportMonthOf(doc.reportMonth), archived };
}

/** After a compare that changed nothing: the report is still there, or NOT_FOUND (deleted meanwhile). */
async function stillThere(tx: TenantDb, documentId: string): Promise<void> {
  const row = await tx.document.findFirst({ where: { id: documentId, kind: "REPORT", deletedAt: null }, select: { id: true } });
  if (!row) deny("NOT_FOUND");
}

/** A report month from a form, not after the workspace's current month. */
async function monthFromForm(tx: TenantDb, tenantId: string, raw: unknown, now: Date): Promise<string> {
  const month = parseReportMonth(raw);
  if (!month) return fail("INVALID_INPUT", "report month");
  const { timezone } = await readPreferences(tx, tenantId);
  if (month > latestReportMonth(localDateString(now, timezone))) fail("INVALID_INPUT", "report month in the future");
  return month;
}

const nameFrom = (raw: string | null | undefined, fallback: string): string => {
  const name = (raw ?? "").trim() || fallback.trim() || "report";
  if (name.length > 255) fail("INVALID_INPUT", "report name");
  return name;
};

// ── Read ─────────────────────────────────────────────────────────────

export type ClientReport = {
  readonly id: string;
  readonly name: string;
  /** `YYYY-MM-01`. */
  readonly month: string;
  readonly visibility: "INTERNAL" | "CLIENT_VISIBLE";
  /** When it was last published to the client; null while never published. */
  readonly publishedAt: Date | null;
  readonly sizeBytes: number;
  readonly contentType: string;
  readonly createdAt: Date;
  /** Made by Fortleva (slice 119) — a `made_report` row beside it — rather than uploaded. */
  readonly made: boolean;
};

/** The client's live reports, newest month first, then by name. */
export async function listClientReports(ctx: ReportCtx, clientId: string): Promise<ClientReport[]> {
  return withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await requireBoth(tx, ctx, "document:view", "report:view");
    await directClient(tx, ctx.actor, clientId);
    const rows = await tx.document.findMany({
      where: { clientId, kind: "REPORT", deletedAt: null },
      select: {
        id: true,
        name: true,
        reportMonth: true,
        visibility: true,
        reportPublishedAt: true,
        createdAt: true,
        versions: {
          orderBy: { versionNumber: "desc" },
          take: 1,
          select: { fileObject: { select: { sizeBytes: true, contentType: true } } },
        },
        madeReport: { select: { documentId: true } },
      },
      orderBy: [{ reportMonth: "desc" }, { name: "asc" }, { id: "asc" }],
      // A report a month for sixteen years; a cap, not a pager.
      take: 200,
    });
    return rows.flatMap((r) =>
      r.reportMonth
        ? [
            {
              id: r.id,
              name: r.name,
              month: reportMonthOf(r.reportMonth),
              visibility: r.visibility,
              publishedAt: r.reportPublishedAt,
              sizeBytes: Number(r.versions[0]?.fileObject.sizeBytes ?? 0n),
              contentType: r.versions[0]?.fileObject.contentType ?? "application/octet-stream",
              createdAt: r.createdAt,
              made: r.madeReport !== null,
            },
          ]
        : [],
    );
  });
}

// ── Upload ───────────────────────────────────────────────────────────

export type CommitReportInput = {
  fileObjectId: string;
  clientId: string;
  /** `YYYY-MM`, from the form. */
  month: string;
  /** Defaults to the file's own name. */
  name?: string | null;
};

/**
 * The upload's commit: the file's existing presign (`createUpload`, the
 * client as its target, INTERNAL) and HEAD-verify (`commitFileObject`), then
 * a REPORT row — always INTERNAL, on an ACTIVE client — and version 1, in the
 * commit's own transaction. Audited `document.created` with the kind and month.
 */
export async function commitReportUpload(ctx: ReportCtx, input: CommitReportInput, now = new Date()): Promise<{ documentId: string }> {
  if (!input.clientId) fail("INVALID_INPUT", "client");
  const documentId = newId();
  await commitFileObject(ctx, input.fileObjectId, async (tx, obj) => {
    // `document:upload` was asked by the commit itself; the report half here.
    await requireAccess(tx, ctx.tenantId, ctx.actor, "report:upload");
    const { archived } = await directClient(tx, ctx.actor, input.clientId);
    if (archived) fail("ARCHIVED", "client");
    const month = await monthFromForm(tx, ctx.tenantId, input.month, now);
    const name = nameFrom(input.name, obj.originalFilename ?? "");
    await tx.document.create({
      data: {
        id: documentId,
        tenantId: ctx.tenantId,
        clientId: input.clientId,
        projectId: null,
        name,
        kind: "REPORT",
        visibility: "INTERNAL",
        reportMonth: reportMonthDate(month),
        createdByMemberId: ctx.actor.memberId,
        versions: { create: { versionNumber: 1, fileObjectId: obj.id, uploadedByMemberId: ctx.actor.memberId } },
      },
      select: { id: true },
    });
    await record(tx, {
      action: "document.created",
      targetType: "Document",
      targetId: documentId,
      metadata: {
        name,
        kind: "REPORT",
        visibility: "INTERNAL",
        fileObjectId: obj.id,
        clientId: input.clientId,
        projectId: null,
        reportMonth: month,
      },
    });
  });
  return { documentId };
}

// ── Publish and hide ─────────────────────────────────────────────────

export type PublishOutcome = {
  /** False when it was already published — nothing changed, nobody mailed. */
  readonly published: boolean;
  /** People told about it now (never told before). */
  readonly queued: number;
  /** Everyone at the client with portal access. */
  readonly reachable: number;
  /** Of those, the ones who can be emailed (address not suppressed). */
  readonly mailable: number;
};

/**
 * PUBLISH — the report becomes the client's to see (C91 (b): everyone with
 * portal access) and its people are told (C91 (c)). ONE transaction: the
 * flip, its stamp, the audit row and the mails. The UPDATE IS THE CHECK
 * (`visibility = INTERNAL` in its `where`): two publishes at once flip it
 * once, audit once and mail once. Refused on an archived client.
 */
export async function publishReport(ctx: ReportCtx, documentId: string, now = new Date()): Promise<PublishOutcome> {
  // RETRIED ON CONTENTION, and told when every attempt is spent: a MADE
  // report's check share-locks the rows it names (slice 119, design §3.2),
  // which a make-private cascade or a portal switch may be locking in
  // another order. The transaction is database-only, so a re-run is the
  // whole remedy. An uploaded report takes no lock and never meets either.
  try {
    return await retryOnContention(() => publishReportOnce(ctx, documentId, now));
  } catch (e) {
    if (isDeadlock(e) || isLockTimeout(e) || isPoolTimeout(e)) fail("MADE_REPORT_BUSY");
    throw e;
  }
}

/**
 * The check's contact-principal reads borrow a SECOND connection while the
 * flip's holds its own with the locks (design §3.2) — many publishes at once
 * in one process can spend the pool, which Prisma reports as P2024. "Try
 * again" is the truth and the whole remedy, so it is BUSY, never a 500.
 */
const isPoolTimeout = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { code?: unknown }).code === "P2024";

/** How long a made report's publish may wait for a row another writer holds, per statement. */
const PUBLISH_LOCK_TIMEOUT_MS = 5_000;
/** The flip's transaction budget: the check derives the content again, one contact transaction per read. */
const PUBLISH_TX_TIMEOUT_MS = 60_000;

async function publishReportOnce(ctx: ReportCtx, documentId: string, now: Date): Promise<PublishOutcome> {
  return withTenant(
    ctx.tenantId,
    memberPrincipal(ctx),
    async (tx) => {
      await requireBoth(tx, ctx, "document:change_visibility", "report:upload");
      const doc = await reportInScope(tx, ctx, documentId);
      if (doc.archived) fail("ARCHIVED", "client");
      // A MADE report (slice 119, R3) is checked before it is flipped: the
      // rows it names are share-locked, the content derived again AS THE
      // CLIENT and compared by fingerprint — any difference refuses
      // MADE_REPORT_STALE and this transaction rolls back, nothing audited.
      // Every publish checks, the first and each one after a hide.
      const made = await tx.madeReport.findFirst({
        where: { documentId: doc.id },
        select: { documentId: true, projectIds: true, taskIds: true, updateIds: true, asContactId: true, contentSha256: true },
      });
      let checked: { contentSha256: string; asContactId: string } | null = null;
      if (made) {
        const { timezone } = await readPreferences(tx, ctx.tenantId);
        checked = await checkMadeReport(tx, ctx.tenantId, doc.clientId, made, timezone, doc.month);
      }
      const taken = await tx.document.updateManyAndReturn({
        where: { id: doc.id, kind: "REPORT", deletedAt: null, visibility: "INTERNAL" },
        data: { visibility: "CLIENT_VISIBLE", reportPublishedAt: now },
        select: { id: true },
      });
      if (taken.length === 0) {
        // Already published — or deleted since the read, which is NOT_FOUND
        // rather than "already published" (the code review's nit).
        await stillThere(tx, doc.id);
        return { published: false, queued: 0, reachable: 0, mailable: 0 };
      }
      const mail = await enqueueReportMails(tx, ctx.tenantId, doc.clientId, doc.id);
      await record(tx, {
        action: "document.visibility_changed",
        targetType: "Document",
        targetId: doc.id,
        metadata: {
          from: "INTERNAL",
          to: "CLIENT_VISIBLE",
          kind: "REPORT",
          reportMonth: doc.month,
          mailed: mail.queued,
          ...(checked ? { made: true, contentSha256: checked.contentSha256, checkedAsContactId: checked.asContactId } : {}),
        },
      });
      return { published: true, queued: mail.queued, reachable: mail.reachable, mailable: mail.mailable };
    },
    { timeoutMs: PUBLISH_TX_TIMEOUT_MS, lockTimeoutMs: PUBLISH_LOCK_TIMEOUT_MS },
  );
}

/**
 * HIDE — back to the team only, at once (it takes access away, never the
 * dangerous direction). Mails still queued for it are dropped at send: the
 * outbox asks the portal, as each person, whether they can still see it.
 * Allowed on an archived client (taking something away always is).
 */
export async function hideReport(ctx: ReportCtx, documentId: string): Promise<{ hidden: boolean }> {
  return withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await requireBoth(tx, ctx, "document:change_visibility", "report:upload");
    const doc = await reportInScope(tx, ctx, documentId);
    const taken = await tx.document.updateManyAndReturn({
      where: { id: doc.id, kind: "REPORT", deletedAt: null, visibility: "CLIENT_VISIBLE" },
      data: { visibility: "INTERNAL" },
      select: { id: true },
    });
    if (taken.length === 0) {
      await stillThere(tx, doc.id);
      return { hidden: false };
    }
    await record(tx, {
      action: "document.visibility_changed",
      targetType: "Document",
      targetId: doc.id,
      metadata: { from: "CLIENT_VISIBLE", to: "INTERNAL", kind: "REPORT", reportMonth: doc.month },
    });
    return { hidden: true };
  });
}

// ── Edit and delete ──────────────────────────────────────────────────

/**
 * The report's name and month. Audited `document.report_edited` — a client
 * may be reading it, so no edit of it is routine. Refused on an archived client.
 */
export async function editReport(
  ctx: ReportCtx,
  documentId: string,
  input: { name: string; month: string },
  now = new Date(),
): Promise<void> {
  await withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await requireBoth(tx, ctx, "document:edit", "report:upload");
    const doc = await reportInScope(tx, ctx, documentId);
    if (doc.archived) fail("ARCHIVED", "client");
    const name = nameFrom(input.name, "");
    if (!input.name.trim()) fail("NAME_REQUIRED", "report name");
    const month = await monthFromForm(tx, ctx.tenantId, input.month, now);
    if (name === doc.name && month === doc.month) return;
    // A MADE report's month is the month its PDF was drawn for (slice 119,
    // the security review's nit): the name may change, the month may not.
    if (month !== doc.month) {
      const made = await tx.madeReport.findFirst({ where: { documentId: doc.id }, select: { documentId: true } });
      if (made) fail("INVALID_INPUT", "a made report's month is its PDF's");
    }
    // A compare, as publish and hide are: deleted since the read is NOT_FOUND,
    // never a raw P2025 (the code review's L4).
    const { count } = await tx.document.updateMany({
      where: { id: doc.id, kind: "REPORT", deletedAt: null },
      data: { name, reportMonth: reportMonthDate(month) },
    });
    if (count === 0) deny("NOT_FOUND");
    await record(tx, {
      action: "document.report_edited",
      targetType: "Document",
      targetId: doc.id,
      metadata: { from: { name: doc.name, month: doc.month }, to: { name, month } },
    });
  });
}

/** Delete — the Files cascade (`softDeleteDocumentsInTx`), audited `document.deleted`. */
export async function deleteReport(ctx: ReportCtx, documentId: string): Promise<void> {
  await withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await requireBoth(tx, ctx, "document:delete", "report:delete");
    const doc = await reportInScope(tx, ctx, documentId);
    const taken = await softDeleteDocumentsInTx(tx, ctx.tenantId, [doc.id], new Date());
    // Deleted by another transaction since the read: theirs (the Files rule).
    if (taken.length === 0) deny("NOT_FOUND");
  });
}
