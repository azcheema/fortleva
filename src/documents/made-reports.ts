import { createHash } from "node:crypto";

import { record } from "@/audit/record";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { fail } from "@/lib/domain-error";
import { localDateString } from "@/lib/duration";
import { newId } from "@/lib/ids";
import { invoiceLocaleFor, isInvoiceLocale, type InvoiceLocale } from "@/modules/invoicing/print";
import { synthesiseContactPrincipal } from "@/portal";
import { readPreferences } from "@/preferences/service";
import { getStorage } from "@/storage";

import { audienceContact, deriveAsAudience, type AudienceContact } from "./made-report-check";
import { contentFingerprint, MADE_REPORT_MAX_PROJECTS, namedIds, type MadeReportContent } from "./made-report-content";
import { defaultReportMonth, parseReportMonth, reportMonthDate, reportMonthOf } from "./report-month";
import { assertMayUploadReport, type ReportCtx } from "./reports";
import { enforceStorageQuota, softDeleteDocumentsInTx } from "./service";

/**
 * THE MONTHLY REPORT FORTLEVA MAKES (Phase 7 slice 119; founder decision
 * C95; design docs/research/2026-10-15-slice-119-monthly-report-design.md
 * §2–§3) — the team's side of MAKING one. A made report is a client report
 * (`./reports.ts`: a REPORT document, slice 115) whose PDF this file draws
 * from what the client can already see, plus a `made_report` row saying so.
 * Publishing one is `publishReport`'s, which calls `checkMadeReport` below
 * before the flip.
 *
 * WHOSE VIEW (design §2.1, R1): the content is read as ONE OF THE CLIENT'S
 * OWN PEOPLE — the contact with the NARROWEST profile among those who could
 * sign in now (ACTIVE, invited, verified: the Portal tab's audience rule,
 * `src/projects/portal-preview.ts`). The principal comes from the member
 * plane's one builder (`synthesiseContactPrincipal`); this file builds none
 * and reads no portal table — `./made-report-content.ts` calls the portal's
 * own projections. A client with nobody who can use the portal gets no made
 * report (MADE_REPORT_NO_AUDIENCE): there is nobody to read it as.
 *
 * WHO MAY: the upload's two codes, `document:upload` + `report:upload`
 * (PLAN §0: no new code), and `project:view` (the form shows the client's
 * project names), all four gates each, in turn; the client DIRECTLY in scope
 * and ACTIVE.
 *
 * WHAT IS WRITTEN, in ONE transaction after the drawing and the upload: a
 * GENERAL COMMITTED `file_object` holding the PDF, the REPORT document
 * (INTERNAL, its month, its localised name, version 1), the `made_report`
 * row (the language, the team's two texts, the ids it names, whose view,
 * the FINGERPRINT, the template version), the workspace's storage count, and
 * `document.created` with `made: true` — never the two texts (they are the
 * client's words to read, not a log's).
 *
 * TWO MAKERS SINCE SLICE 120 (founder decision C96): the button, here
 * (`makeReport`), and the DRAFTER that makes last month's report by itself
 * on the 1st (`./report-drafts.ts`) — the same drawing and the same rows
 * through `fileMadeReport` below, with every maker column NULL and the
 * write audited as SYSTEM. The button, for a month that holds such a draft
 * — private, never published — REPLACES it in the same step (C96 (d)): the
 * draft is soft-deleted in the transaction that files the new report, under
 * the MAKE codes (design R5 — it is a never-published, system-drafted PDF
 * for the same client and month that the member is re-making), and the
 * `document.deleted` row says `replaced_draft`.
 */

export const MADE_REPORT_TEXT_MAX = 2000;

export type MakeReportInput = {
  readonly clientId: string;
  /** `YYYY-MM`, from the form — a month that has ENDED (C95 (g)). */
  readonly month: string;
  /** `sv` | `en` — the client's invoice language unless changed (C95 (f)). */
  readonly locale: string;
  /** The projects ticked (C95 (e)). */
  readonly projectIds: readonly string[];
  readonly summary?: string | null;
  readonly comingNext?: string | null;
};

/** What a log line may say about an error: its name and code, never its message. */
export const errorTag = (e: unknown): string => {
  if (!(e instanceof Error)) return typeof e;
  const code = (e as { code?: unknown }).code;
  return typeof code === "string" || typeof code === "number" ? `${e.name} (${code})` : e.name;
};

/** The team's text, as stored: trimmed, `\r\n` folded, at most MADE_REPORT_TEXT_MAX characters, null when empty. */
export function cleanReportText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return fail("INVALID_INPUT", "report text");
  const text = raw.replace(/\r\n?/g, "\n").replace(/\t/g, " ").trim();
  if (text.length === 0) return null;
  if (text.length > MADE_REPORT_TEXT_MAX) fail("INVALID_INPUT", "report text too long");
  // Nothing a text column cannot hold (the normaliser's rule for rich text).
  if (/\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)) fail("INVALID_INPUT", "report text");
  return text;
}

/** A report's month from the form — strictly BEFORE the workspace's current month (C95 (g)). */
export function endedMonthFromForm(raw: unknown, today: string): string {
  const month = parseReportMonth(raw);
  if (!month) return fail("INVALID_INPUT", "report month");
  if (month > defaultReportMonth(today)) fail("INVALID_INPUT", "report month has not ended");
  return month;
}

/**
 * The job-drafted reports of a client that the button would REPLACE (C96
 * (d)): live REPORT documents for the month with a `made_report` row made by
 * nobody, still INTERNAL and NEVER published — `report_published_at` stays
 * set through a hide, so a draft a client has once read is never replaced
 * (design R5). Null `month` = every month, for the form's list.
 */
const replaceableDraftsWhere = (clientId: string, month: string | null) => ({
  clientId,
  kind: "REPORT" as const,
  deletedAt: null,
  visibility: "INTERNAL" as const,
  reportPublishedAt: null,
  ...(month ? { reportMonth: reportMonthDate(month) } : {}),
  madeReport: { is: { madeByMemberId: null } },
});

// ── The form ─────────────────────────────────────────────────────────

export type MakeReportForm = {
  /** The projects the client sees in their portal (portal on, not archived), by name. */
  readonly projects: readonly { readonly id: string; readonly name: string }[];
  /** Whether anyone at the client could sign in to read it (R1). */
  readonly hasAudience: boolean;
  /** The client's invoice language — the select's start (C95 (f)). */
  readonly defaultLocale: InvoiceLocale;
  /** Months (`YYYY-MM-01`) holding a job-drafted report the button would replace (slice 120, C96 (d)). */
  readonly draftMonths: readonly string[];
  /** Months (`YYYY-MM-01`) the drafter found nothing to show for — no draft was made (C96 (a)); the newest twelve. */
  readonly emptyMonths: readonly string[];
};

/**
 * What the Make a report card needs, as the member's read: `project:view`
 * beside the upload's codes (the names are shown), the client directly in
 * scope. The service re-reads all of it when the report is made.
 */
export async function readMakeReportForm(ctx: ReportCtx, clientId: string): Promise<MakeReportForm> {
  if (!clientId) fail("INVALID_INPUT", "client");
  return withTenant(ctx.tenantId, { type: "member", id: ctx.actor.memberId }, async (tx) => {
    await assertMayUploadReport(tx, ctx, clientId);
    await requireAccess(tx, ctx.tenantId, ctx.actor, "project:view");
    const client = await tx.client.findFirst({ where: { id: clientId }, select: { invoiceLocale: true, countryCode: true } });
    if (!client) return fail("INVALID_INPUT", "client");
    const projects = await tx.project.findMany({
      where: { clientId, portalEnabled: true, archivedAt: null },
      select: { id: true, name: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
    const contact = await audienceContact(tx, ctx.tenantId, clientId);
    // In sequence (AGENTS.md's trap): the drafts the button would replace,
    // then the months the drafter found empty.
    const drafts = await tx.document.findMany({ where: replaceableDraftsWhere(clientId, null), select: { reportMonth: true } });
    const empties = await tx.monthlyReportDraft.findMany({
      where: { clientId, outcome: "EMPTY" },
      select: { month: true },
      orderBy: { month: "desc" },
      take: 12,
    });
    return {
      projects,
      hasAudience: contact !== null,
      defaultLocale: invoiceLocaleFor(client),
      draftMonths: [...new Set(drafts.flatMap((d) => (d.reportMonth ? [reportMonthOf(d.reportMonth)] : [])))],
      emptyMonths: empties.map((e) => reportMonthOf(e.month)),
    };
  });
}

// ── The filing, shared by the button and the drafter ─────────────────

export type FileMadeReportInput = {
  readonly tenantId: string;
  /** The button's member, or the drafter's SYSTEM. */
  readonly principal: { readonly type: "member"; readonly id: string } | { readonly type: "system" };
  /** The member who pressed Make, or null = the drafter (every maker column NULL). */
  readonly madeBy: string | null;
  readonly clientId: string;
  readonly clientName: string;
  readonly agencyName: string;
  /** `YYYY-MM-01`. */
  readonly month: string;
  readonly locale: InvoiceLocale;
  /** The workspace's local date, drawn on the PDF as the day it was made. */
  readonly today: string;
  readonly summary: string | null;
  readonly comingNext: string | null;
  /** In the order the PDF draws. */
  readonly projectIds: readonly string[];
  readonly contact: AudienceContact;
  readonly content: MadeReportContent;
  readonly now: Date;
  /** The caller's gates, re-asked inside the transaction that writes. */
  readonly beforeWrite: (tx: TenantDb) => Promise<void>;
  /**
   * The caller's own writes in the same transaction, BEFORE the audit row —
   * what it returns is merged into `document.created`'s metadata (the button:
   * the drafts it replaced; the drafter: nothing, its ledger row and notice).
   */
  readonly afterWrite?: (tx: TenantDb, documentId: string) => Promise<Record<string, unknown> | void>;
};

/**
 * Slice 119's steps 3–5: the drawing (the renderer loaded HERE, never at
 * import — ESM-only), the upload, then ONE transaction — the caller's gates,
 * the quota, the four rows, the storage count, the caller's own writes, the
 * audit. The blob goes if the transaction fails.
 */
export async function fileMadeReport(input: FileMadeReportInput): Promise<{ documentId: string }> {
  const { tenantId, clientId, content, now } = input;
  const sha = contentFingerprint(content);
  const ids = namedIds(content);

  // 3. The drawing.
  let renderer: typeof import("./pdf/made-report-pdf");
  try {
    renderer = await import("./pdf/made-report-pdf");
  } catch (e) {
    console.error(`made report: the renderer did not load (client ${clientId}): ${errorTag(e)}`);
    return fail("REPORT_PDF_UNAVAILABLE");
  }
  const { MADE_REPORT_TEMPLATE_VERSION, madeReportFileName, madeReportName, renderMadeReportPdf } = renderer;
  let bytes: Uint8Array;
  try {
    bytes = await renderMadeReportPdf({
      locale: input.locale,
      clientName: input.clientName,
      agencyName: input.agencyName,
      madeOn: input.today,
      summary: input.summary,
      comingNext: input.comingNext,
      content,
    });
  } catch (e) {
    console.error(`made report: render failed (client ${clientId}): ${errorTag(e)}`);
    return fail("REPORT_PDF_UNAVAILABLE");
  }

  // 4. The upload — "try again", never a raw error: a deployment without its
  //    bucket (the browser harness's production build) refuses here.
  const fileObjectId = newId();
  const documentId = newId();
  const r2Key = `${tenantId}/${fileObjectId}`;
  const fileName = madeReportFileName(input.month, input.locale);
  const name = madeReportName(input.month, input.locale);
  const fileSha256 = createHash("sha256").update(bytes).digest("hex");
  let storage: ReturnType<typeof getStorage>;
  try {
    storage = getStorage();
    await storage.putObject(r2Key, bytes, "application/pdf");
  } catch (e) {
    console.error(`made report: upload failed (client ${clientId}): ${errorTag(e)}`);
    return fail("REPORT_PDF_UNAVAILABLE");
  }

  // 5. The record — ONE transaction; the blob goes if it fails.
  try {
    await withTenant(tenantId, input.principal, async (tx) => {
      // The gates again, in the transaction that writes (the quota too: a
      // made file counts as an upload would).
      await input.beforeWrite(tx);
      await enforceStorageQuota(tx, tenantId, bytes.byteLength);
      await tx.fileObject.create({
        data: {
          id: fileObjectId,
          tenantId,
          r2Key,
          kind: "GENERAL",
          sha256: fileSha256,
          sizeBytes: BigInt(bytes.byteLength),
          contentType: "application/pdf",
          originalFilename: fileName,
          status: "COMMITTED",
          committedAt: now,
          createdByMemberId: input.madeBy,
        },
        select: { id: true },
      });
      await tx.document.create({
        data: {
          id: documentId,
          tenantId,
          clientId,
          projectId: null,
          name,
          kind: "REPORT",
          visibility: "INTERNAL",
          reportMonth: reportMonthDate(input.month),
          createdByMemberId: input.madeBy,
          versions: { create: { versionNumber: 1, fileObjectId, uploadedByMemberId: input.madeBy } },
        },
        select: { id: true },
      });
      // The record of the making — its own statement, after the document
      // (the kind guard reads the REPORT row this transaction just wrote).
      await tx.madeReport.create({
        data: {
          documentId,
          tenantId,
          locale: input.locale,
          summary: input.summary,
          comingNext: input.comingNext,
          projectIds: [...input.projectIds],
          taskIds: ids.taskIds,
          updateIds: ids.updateIds,
          asContactId: input.contact.id,
          contentSha256: sha,
          templateVersion: MADE_REPORT_TEMPLATE_VERSION,
          madeAt: now,
          madeByMemberId: input.madeBy,
        },
        select: { documentId: true },
      });
      await tx.tenant.update({
        where: { id: tenantId },
        data: { storageUsedBytes: { increment: BigInt(bytes.byteLength) } },
        select: { id: true },
      });
      const extra = (await input.afterWrite?.(tx, documentId)) ?? {};
      await record(tx, {
        action: "document.created",
        targetType: "Document",
        targetId: documentId,
        metadata: {
          name,
          kind: "REPORT",
          visibility: "INTERNAL",
          fileObjectId,
          clientId,
          projectId: null,
          reportMonth: input.month,
          made: true,
          drafted: input.madeBy === null,
          locale: input.locale,
          projectIds: [...input.projectIds],
          asContactId: input.contact.id,
          contentSha256: sha,
          templateVersion: MADE_REPORT_TEMPLATE_VERSION,
          sizeBytes: bytes.byteLength,
          ...extra,
        },
      });
    });
  } catch (e) {
    await storage.delete(r2Key).catch(() => undefined);
    throw e;
  }
  return { documentId };
}

// ── Make (the button) ────────────────────────────────────────────────

export async function makeReport(
  ctx: ReportCtx,
  input: MakeReportInput,
  now = new Date(),
): Promise<{ documentId: string; replaced: number }> {
  if (!input.clientId) fail("INVALID_INPUT", "client");
  if (!isInvoiceLocale(input.locale)) return fail("INVALID_INPUT", "report language");
  const locale: InvoiceLocale = input.locale;
  const summary = cleanReportText(input.summary);
  const comingNext = cleanReportText(input.comingNext);
  const ticked = [...new Set(input.projectIds)];
  if (ticked.length === 0) fail("INVALID_INPUT", "no project");
  if (ticked.length > MADE_REPORT_MAX_PROJECTS) fail("MADE_REPORT_TOO_LARGE", "projects");
  const principal = { type: "member", id: ctx.actor.memberId } as const;

  // 1. The member's transaction: who may, for whom, which month, whose view.
  const prep = await withTenant(ctx.tenantId, principal, async (tx) => {
    await assertMayUploadReport(tx, ctx, input.clientId);
    await requireAccess(tx, ctx.tenantId, ctx.actor, "project:view");
    const { timezone } = await readPreferences(tx, ctx.tenantId);
    const today = localDateString(now, timezone);
    const month = endedMonthFromForm(input.month, today);
    const client = await tx.client.findFirst({ where: { id: input.clientId }, select: { name: true } });
    if (!client) return fail("INVALID_INPUT", "client");
    const tenant = await tx.tenant.findFirst({ where: { id: ctx.tenantId }, select: { name: true } });
    // The projects the member's read says the client can see — the form's
    // own list, in ITS order (by name, then id — the order the PDF draws);
    // a ticked id outside it is a form that lied.
    const projects = await tx.project.findMany({
      where: { clientId: input.clientId, id: { in: ticked }, portalEnabled: true, archivedAt: null },
      select: { id: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
    if (projects.length !== ticked.length) fail("INVALID_INPUT", "a project is not the client's to share");
    const contact = await audienceContact(tx, ctx.tenantId, input.clientId);
    if (!contact) return fail("MADE_REPORT_NO_AUDIENCE");
    // The job's drafts for this month the new report replaces (C96 (d)).
    const drafts = await tx.document.findMany({ where: replaceableDraftsWhere(input.clientId, month), select: { id: true }, orderBy: { id: "asc" } });
    return {
      timezone,
      today,
      month,
      clientName: client.name,
      agencyName: tenant?.name ?? "",
      projectIds: projects.map((p) => p.id),
      contact,
      draftIds: drafts.map((d) => d.id),
    };
  });

  // 2. As the contact — outside any member transaction.
  const contactPrincipal = await synthesiseContactPrincipal(ctx.tenantId, prep.contact);
  const content = await deriveAsAudience(contactPrincipal, { month: prep.month, timezone: prep.timezone, projectIds: prep.projectIds });

  // 3–5. The drawing, the upload, the record — with the replace inside it.
  let replaced: string[] = [];
  const { documentId } = await fileMadeReport({
    tenantId: ctx.tenantId,
    principal,
    madeBy: ctx.actor.memberId,
    clientId: input.clientId,
    clientName: prep.clientName,
    agencyName: prep.agencyName,
    month: prep.month,
    locale,
    today: prep.today,
    summary,
    comingNext,
    projectIds: prep.projectIds,
    contact: prep.contact,
    content,
    now,
    beforeWrite: (tx) => assertMayUploadReport(tx, ctx, input.clientId),
    afterWrite: async (tx, newId) => {
      if (prep.draftIds.length === 0) return;
      // The UPDATE is the SELECT (the function's own compare-and-set), and it
      // carries the draft's own terms — still INTERNAL, never published — so
      // a draft a colleague PUBLISHED during this make's window (the derive,
      // the drawing, the upload: seconds) is not taken either, not only one
      // deleted since the read (both reviews' medium): the publish and this
      // UPDATE serialise on the row, and the loser sees no row. Then two
      // reports for the month, the team's to tidy. Under the MAKE codes
      // (design R5); the `document.deleted` row says why.
      replaced = await softDeleteDocumentsInTx(
        tx,
        ctx.tenantId,
        prep.draftIds,
        now,
        { reason: "replaced_draft", replacedBy: newId },
        { visibility: "INTERNAL", reportPublishedAt: null },
      );
      return replaced.length > 0 ? { replacedDraftIds: replaced } : undefined;
    },
  });
  return { documentId, replaced: replaced.length };
}
