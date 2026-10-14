import { createHash } from "node:crypto";

import { record } from "@/audit/record";
import { withTenant } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { fail } from "@/lib/domain-error";
import { localDateString } from "@/lib/duration";
import { newId } from "@/lib/ids";
import { invoiceLocaleFor, isInvoiceLocale, type InvoiceLocale } from "@/modules/invoicing/print";
import { synthesiseContactPrincipal } from "@/portal";
import { readPreferences } from "@/preferences/service";
import { getStorage } from "@/storage";

import { audienceContact, deriveAsAudience } from "./made-report-check";
import { contentFingerprint, MADE_REPORT_MAX_PROJECTS, namedIds } from "./made-report-content";
import { defaultReportMonth, parseReportMonth, reportMonthDate } from "./report-month";
import { assertMayUploadReport, type ReportCtx } from "./reports";
import { enforceStorageQuota } from "./service";

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
const errorTag = (e: unknown): string => {
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

// ── The form ─────────────────────────────────────────────────────────

export type MakeReportForm = {
  /** The projects the client sees in their portal (portal on, not archived), by name. */
  readonly projects: readonly { readonly id: string; readonly name: string }[];
  /** Whether anyone at the client could sign in to read it (R1). */
  readonly hasAudience: boolean;
  /** The client's invoice language — the select's start (C95 (f)). */
  readonly defaultLocale: InvoiceLocale;
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
    return { projects, hasAudience: contact !== null, defaultLocale: invoiceLocaleFor(client) };
  });
}

// ── Make ─────────────────────────────────────────────────────────────

export async function makeReport(ctx: ReportCtx, input: MakeReportInput, now = new Date()): Promise<{ documentId: string }> {
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
    return { timezone, today, month, clientName: client.name, agencyName: tenant?.name ?? "", projectIds: projects.map((p) => p.id), contact };
  });

  // 2. As the contact — outside any member transaction.
  const contactPrincipal = await synthesiseContactPrincipal(ctx.tenantId, prep.contact);
  const content = await deriveAsAudience(contactPrincipal, { month: prep.month, timezone: prep.timezone, projectIds: prep.projectIds });
  const sha = contentFingerprint(content);
  const ids = namedIds(content);

  // 3. The drawing — the renderer loaded HERE, never at import (ESM-only).
  let renderer: typeof import("./pdf/made-report-pdf");
  try {
    renderer = await import("./pdf/made-report-pdf");
  } catch (e) {
    console.error(`made report: the renderer did not load (client ${input.clientId}): ${errorTag(e)}`);
    return fail("REPORT_PDF_UNAVAILABLE");
  }
  const { MADE_REPORT_TEMPLATE_VERSION, madeReportFileName, madeReportName, renderMadeReportPdf } = renderer;
  let bytes: Uint8Array;
  try {
    bytes = await renderMadeReportPdf({
      locale,
      clientName: prep.clientName,
      agencyName: prep.agencyName,
      madeOn: prep.today,
      summary,
      comingNext,
      content,
    });
  } catch (e) {
    console.error(`made report: render failed (client ${input.clientId}): ${errorTag(e)}`);
    return fail("REPORT_PDF_UNAVAILABLE");
  }

  // 4. The upload — "try again", never a raw error: a deployment without its
  //    bucket (the browser harness's production build) refuses here.
  const fileObjectId = newId();
  const documentId = newId();
  const r2Key = `${ctx.tenantId}/${fileObjectId}`;
  const fileName = madeReportFileName(prep.month, locale);
  const name = madeReportName(prep.month, locale);
  const fileSha256 = createHash("sha256").update(bytes).digest("hex");
  let storage: ReturnType<typeof getStorage>;
  try {
    storage = getStorage();
    await storage.putObject(r2Key, bytes, "application/pdf");
  } catch (e) {
    console.error(`made report: upload failed (client ${input.clientId}): ${errorTag(e)}`);
    return fail("REPORT_PDF_UNAVAILABLE");
  }

  // 5. The record — ONE transaction; the blob goes if it fails.
  try {
    await withTenant(ctx.tenantId, principal, async (tx) => {
      // The gates again, in the transaction that writes (the quota too: a
      // made file counts as an upload would).
      await assertMayUploadReport(tx, ctx, input.clientId);
      await enforceStorageQuota(tx, ctx.tenantId, bytes.byteLength);
      await tx.fileObject.create({
        data: {
          id: fileObjectId,
          tenantId: ctx.tenantId,
          r2Key,
          kind: "GENERAL",
          sha256: fileSha256,
          sizeBytes: BigInt(bytes.byteLength),
          contentType: "application/pdf",
          originalFilename: fileName,
          status: "COMMITTED",
          committedAt: now,
          createdByMemberId: ctx.actor.memberId,
        },
        select: { id: true },
      });
      await tx.document.create({
        data: {
          id: documentId,
          tenantId: ctx.tenantId,
          clientId: input.clientId,
          projectId: null,
          name,
          kind: "REPORT",
          visibility: "INTERNAL",
          reportMonth: reportMonthDate(prep.month),
          createdByMemberId: ctx.actor.memberId,
          versions: { create: { versionNumber: 1, fileObjectId, uploadedByMemberId: ctx.actor.memberId } },
        },
        select: { id: true },
      });
      // The record of the making — its own statement, after the document
      // (the kind guard reads the REPORT row this transaction just wrote).
      await tx.madeReport.create({
        data: {
          documentId,
          tenantId: ctx.tenantId,
          locale,
          summary,
          comingNext,
          projectIds: [...prep.projectIds],
          taskIds: ids.taskIds,
          updateIds: ids.updateIds,
          asContactId: prep.contact.id,
          contentSha256: sha,
          templateVersion: MADE_REPORT_TEMPLATE_VERSION,
          madeAt: now,
          madeByMemberId: ctx.actor.memberId,
        },
        select: { documentId: true },
      });
      await tx.tenant.update({
        where: { id: ctx.tenantId },
        data: { storageUsedBytes: { increment: BigInt(bytes.byteLength) } },
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
          fileObjectId,
          clientId: input.clientId,
          projectId: null,
          reportMonth: prep.month,
          made: true,
          locale,
          projectIds: [...prep.projectIds],
          asContactId: prep.contact.id,
          contentSha256: sha,
          templateVersion: MADE_REPORT_TEMPLATE_VERSION,
          sizeBytes: bytes.byteLength,
        },
      });
    });
  } catch (e) {
    await storage.delete(r2Key).catch(() => undefined);
    throw e;
  }
  return { documentId };
}

