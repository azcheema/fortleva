import { createHash } from "node:crypto";

import { record } from "@/audit/record";
import { assertInScope } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { fail } from "@/lib/domain-error";
import { attachmentDisposition } from "@/lib/http-download";
import { newId } from "@/lib/ids";
import { readPreferences } from "@/preferences/service";
import { getStorage } from "@/storage";

import { partiesFromFrozen, printedMoment } from "./parties";
import { contractPdfFileName, isContractLocale, readFrozenParties, uploadedContractPdfName, type ContractPrint, type SignaturePrint } from "./print";
import type { ContractsCtx } from "./templates";

/**
 * A SENT CONTRACT'S PDFS, EACH MADE ONCE AND KEPT (Phase 4 slice 112b; C84,
 * C85 (b)) — the invoice's pattern (`src/modules/invoicing/pdf-store.ts`):
 *   - the PDF AS SENT (`pdf_file_id`), drawn from the frozen record — the
 *     parties the send's guard froze, the body — once the contract is sent;
 *   - the SIGNED COPY (`signed_pdf_file_id`), the same drawing plus the
 *     signature page — both signatures as the database wrote them and the
 *     fingerprint they attest to — once it is SIGNED.
 * Stored in the tenant's bucket as a committed CONTRACT_PDF, recorded set-once
 * (the guard refuses a second; `file_object_contract_pdf_guard` freezes the
 * file's row). Never re-rendered: every later download uses these bytes.
 *
 * What a signature attests to is the FINGERPRINT of the frozen record
 * (`content_sha256`, hashed by the database at sending), not these bytes —
 * react-pdf writes a creation date into every file, so no two drawings are
 * byte-equal. The PDFs carry the fingerprint; the record keeps the truth.
 *
 * FAIL CLOSED: a frozen record this cannot read (a `parties` without both
 * names, a signature missing) refuses with CONTRACT_PDF_UNAVAILABLE and stores
 * nothing — a degraded drawing recorded once would be the archive forever.
 *
 * WHO MAKES THEM: the sender, right after the send (the PDF as sent); the
 * announcer after the client signs (the signed copy — slice 112b2); anyone who
 * may view the contract, on Download, if that failed; and the jobs route's
 * sweep (`makeMissingContractPdfs`, as the workspace's SYSTEM principal) for
 * any over five minutes old without one. Two at once: both draw and upload,
 * ONE records, the other deletes its own upload and returns the winner.
 */

/** Which drawing this is. Raise it whenever `pdf/contract-pdf.tsx` changes what a PDF looks like. */
// 2 (slice 112b2, C85 (e)): the agency's signer is printed by name alone when
// the workspace had no confirmed reply address at sending.
export const CONTRACT_PDF_TEMPLATE_VERSION = 2;

export type ContractPdfKind = "sent" | "signed";

type Principal = { readonly type: "member"; readonly id: string } | { readonly type: "system" };

class LostRace extends Error {}

/** What a log line may say about an error: its name and code, never its message. */
const errorTag = (e: unknown): string => {
  if (!(e instanceof Error)) return typeof e;
  const code = (e as { code?: unknown }).code;
  return typeof code === "string" || typeof code === "number" ? `${e.name} (${code})` : e.name;
};

export type ContractPdf = {
  readonly fileObjectId: string;
  readonly r2Key: string;
  readonly fileName: string;
  /** Drawn and recorded by THIS call. */
  readonly created: boolean;
};

const fileField = (kind: ContractPdfKind) => (kind === "sent" ? "pdfFile" : "signedPdf");

/** The recorded PDF of that kind, read inside a transaction. */
async function recordedPdf(tx: TenantDb, contractId: string, kind: ContractPdfKind): Promise<ContractPdf | null> {
  const row = await tx.contract.findFirst({
    where: { id: contractId },
    select: {
      pdfFile: { select: { id: true, r2Key: true, originalFilename: true } },
      signedPdf: { select: { id: true, r2Key: true, originalFilename: true } },
    },
  });
  const file = row?.[fileField(kind)];
  if (!file) return null;
  return { fileObjectId: file.id, r2Key: file.r2Key, fileName: file.originalFilename ?? `${file.id}.pdf`, created: false };
}

/**
 * The frozen record as a drawing, read STRICTLY — under any principal that may
 * read the contract (the sender, a viewer, the system). Null when it is not
 * (yet) that kind's: not sent, or not signed.
 */
export async function readContractPrint(
  tx: TenantDb,
  tenantId: string,
  contractId: string,
  kind: ContractPdfKind,
): Promise<ContractPrint | null> {
  const row = await tx.contract.findFirst({
    where: { tenantId, id: contractId, origin: "WRITTEN", status: kind === "sent" ? { not: "DRAFT" } : "SIGNED" },
    select: {
      title: true,
      version: true,
      language: true,
      body: true,
      parties: true,
      contentSha256: true,
      signatures: {
        select: { party: true, signerName: true, signerEmail: true, typedName: true, decidedAt: true, status: true, contentSha256: true },
        orderBy: { party: "asc" }, // TENANT before CLIENT (the enum's declared order)
      },
    },
  });
  if (!row) return null;
  const locale = isContractLocale(row.language) ? row.language : null;
  const frozen = readFrozenParties(row.parties);
  if (locale === null || frozen === null || row.contentSha256 === null) {
    console.error(`contract pdf: the frozen record is unreadable (contract ${contractId})`);
    return fail("CONTRACT_PDF_UNAVAILABLE");
  }
  const base: ContractPrint = {
    locale,
    title: row.title,
    version: row.version,
    draft: false,
    parties: partiesFromFrozen(frozen, locale),
    body: row.body,
  };
  if (kind === "sent") return base;
  const timezone = (await readPreferences(tx, tenantId)).timezone;
  const signed: SignaturePrint[] = [];
  for (const party of ["TENANT", "CLIENT"] as const) {
    const sig = row.signatures.find((s) => s.party === party);
    if (!sig || sig.status !== "SIGNED" || sig.typedName === null || sig.decidedAt === null || sig.contentSha256 !== row.contentSha256) {
      console.error(`contract pdf: a signature is missing or does not match (contract ${contractId}, ${party})`);
      return fail("CONTRACT_PDF_UNAVAILABLE");
    }
    signed.push({ party, name: sig.signerName, email: sig.signerEmail, typedName: sig.typedName, when: printedMoment(sig.decidedAt, locale, timezone) });
  }
  return { ...base, signed: { signatures: signed, contentSha256: row.contentSha256 } };
}

/** Draw, store and record one PDF of a sent contract — the caller has checked who may. */
async function makePdf(
  tenantId: string,
  principal: Principal,
  contractId: string,
  kind: ContractPdfKind,
  now: Date,
): Promise<ContractPdf> {
  const read = await withTenant(tenantId, principal, async (tx) => {
    const existing = await recordedPdf(tx, contractId, kind);
    if (existing) return { kind: "existing", pdf: existing } as const;
    const print = await readContractPrint(tx, tenantId, contractId, kind);
    if (!print) return deny("NOT_FOUND");
    return { kind: "print", print } as const;
  });
  if (read.kind === "existing") return read.pdf;
  const print = read.print;

  // Loaded HERE, when a PDF is drawn — never at import: it is ESM-only.
  let renderContractPdf: typeof import("./pdf/contract-pdf").renderContractPdf;
  try {
    ({ renderContractPdf } = await import("./pdf/contract-pdf"));
  } catch (e) {
    console.error(`contract pdf: the renderer did not load (contract ${contractId}): ${errorTag(e)}`);
    return fail("CONTRACT_PDF_UNAVAILABLE");
  }
  let bytes: Uint8Array;
  try {
    bytes = await renderContractPdf(print);
  } catch (e) {
    console.error(`contract pdf: render failed (contract ${contractId}): ${errorTag(e)}`);
    return fail("CONTRACT_PDF_UNAVAILABLE");
  }
  const fileObjectId = newId();
  const r2Key = `${tenantId}/${fileObjectId}`;
  const base = contractPdfFileName(print.title, print.version);
  const fileName = kind === "signed" ? base.replace(/\.pdf$/, "-signed.pdf") : base;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let storage: ReturnType<typeof getStorage>;
  try {
    storage = getStorage();
    await storage.putObject(r2Key, bytes, "application/pdf");
  } catch (e) {
    console.error(`contract pdf: upload failed (contract ${contractId}): ${errorTag(e)}`);
    return fail("CONTRACT_PDF_UNAVAILABLE");
  }

  try {
    await withTenant(tenantId, principal, async (tx) => {
      await tx.fileObject.create({
        data: {
          id: fileObjectId,
          tenantId,
          r2Key,
          kind: "CONTRACT_PDF",
          sha256,
          sizeBytes: BigInt(bytes.byteLength),
          contentType: "application/pdf",
          originalFilename: fileName,
          status: "COMMITTED",
          committedAt: now,
          createdByMemberId: principal.type === "member" ? principal.id : null,
        },
        select: { id: true },
      });
      // Set once: whoever records first wins; the guard refuses any change after.
      const set =
        kind === "sent"
          ? await tx.contract.updateMany({ where: { id: contractId, pdfFileId: null, status: { not: "DRAFT" } }, data: { pdfFileId: fileObjectId } })
          : await tx.contract.updateMany({ where: { id: contractId, signedPdfFileId: null, status: "SIGNED" }, data: { signedPdfFileId: fileObjectId } });
      if (set.count === 0) throw new LostRace();
      await tx.tenant.update({
        where: { id: tenantId },
        data: { storageUsedBytes: { increment: BigInt(bytes.byteLength) } },
        select: { id: true },
      });
      await record(tx, {
        action: "contract.pdf_generated",
        targetType: "Contract",
        targetId: contractId,
        metadata: { kind, fileObjectId, sha256, sizeBytes: bytes.byteLength, templateVersion: CONTRACT_PDF_TEMPLATE_VERSION },
      });
    });
  } catch (e) {
    // What the contract points at NOW decides (the invoice store's reasoning):
    // the upload goes only when the contract is not ours.
    let recorded: ContractPdf | null = null;
    try {
      recorded = await withTenant(tenantId, principal, (tx) => recordedPdf(tx, contractId, kind));
    } catch {
      throw e;
    }
    if (recorded?.fileObjectId === fileObjectId) return { ...recorded, created: true };
    await storage.delete(r2Key).catch(() => undefined);
    if (recorded) return recorded;
    if (e instanceof LostRace) return fail("CONTRACT_PDF_UNAVAILABLE");
    throw e;
  }
  return { fileObjectId, r2Key, fileName, created: true };
}

/**
 * `contract:view` + the client in scope — that kind's PDF, made now if it was
 * not yet: the sender after sending, anyone who downloads.
 */
export async function ensureContractPdf(
  ctx: ContractsCtx,
  contractId: string,
  kind: ContractPdfKind,
  now: Date = new Date(),
): Promise<ContractPdf> {
  const principal = { type: "member", id: ctx.actor.memberId } as const;
  const uploaded = await withTenant(ctx.tenantId, principal, async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "contract:view");
    const scoped = await tx.contract.findFirst({ where: { id: contractId }, select: { clientId: true, status: true, origin: true } });
    if (!scoped) return deny("NOT_FOUND");
    await assertInScope(tx, ctx.actor, { clientId: scoped.clientId });
    // A contract SIGNED ELSEWHERE (slice 112c): its signed copy IS the file
    // that was put in — recorded at its insert, never drawn. It has no PDF as
    // sent.
    if (scoped.origin === "UPLOADED") {
      if (kind !== "signed") return fail("CONTRACT_NOT_READY");
      const file = await recordedPdf(tx, contractId, "signed");
      if (!file) return fail("CONTRACT_PDF_UNAVAILABLE");
      // Named from its CURRENT title, as the portal names it (the code
      // review's low: the recorded name is the title at the time it was put in).
      const { title } = await tx.contract.findFirstOrThrow({ where: { id: contractId }, select: { title: true } });
      return { ...file, fileName: uploadedContractPdfName(title) };
    }
    if (scoped.status === "DRAFT" || (kind === "signed" && scoped.status !== "SIGNED")) {
      return fail("CONTRACT_NOT_READY");
    }
    return null;
  });
  if (uploaded) return uploaded;
  return makePdf(ctx.tenantId, principal, contractId, kind, now);
}

/** As the SYSTEM principal — the announcer after a signature (112b2) and the sweep. */
export async function ensureContractPdfAsSystem(tenantId: string, contractId: string, kind: ContractPdfKind, now: Date = new Date()): Promise<ContractPdf> {
  return makePdf(tenantId, { type: "system" }, contractId, kind, now);
}

const PDF_URL_EXPIRES_SEC = 60;

/**
 * `contract:view` + the client in scope — a short-lived, attachment-only,
 * off-origin link to that PDF (SECURITY §5), made first if it was not yet.
 * Asked for by a server action (a POST), so a cross-site link cannot make one.
 */
export async function contractPdfUrl(
  ctx: ContractsCtx,
  contractId: string,
  kind: ContractPdfKind,
): Promise<{ readonly url: string; readonly fileName: string; readonly created: boolean }> {
  const pdf = await ensureContractPdf(ctx, contractId, kind);
  const url = await getStorage().presignGet(pdf.r2Key, {
    expiresSec: PDF_URL_EXPIRES_SEC,
    responseContentDisposition: attachmentDisposition(pdf.fileName),
    responseContentType: "application/pdf",
  });
  return { url, fileName: pdf.fileName, created: pdf.created };
}

/** How long a sent or signed contract waits for its own attempt before the sweep's. */
export const CONTRACT_PDF_SWEEP_AFTER_MS = 5 * 60_000;
/** At most this many PDFs per workspace per kick. */
export const CONTRACT_PDF_SWEEP_BATCH = 20;

/**
 * The jobs route's sweep for ONE workspace, as its SYSTEM principal: every
 * sent contract over five minutes old without its PDF as sent, and every
 * signed one without its signed copy, gets it. NEWEST FIRST (the invoice
 * sweep's reason: one that can never be drawn must not starve the rest).
 */
export async function makeMissingContractPdfs(tenantId: string, now: Date = new Date()): Promise<{ made: number; failed: number }> {
  const principal = { type: "system" } as const;
  const before = new Date(now.getTime() - CONTRACT_PDF_SWEEP_AFTER_MS);
  const due = await withTenant(tenantId, principal, async (tx) => {
    const sent = await tx.contract.findMany({
      where: { origin: "WRITTEN", status: { not: "DRAFT" }, pdfFileId: null, sentAt: { lt: before } },
      orderBy: [{ sentAt: "desc" }, { id: "desc" }],
      take: CONTRACT_PDF_SWEEP_BATCH,
      select: { id: true },
    });
    const signed = await tx.contract.findMany({
      where: { origin: "WRITTEN", status: "SIGNED", signedPdfFileId: null, updatedAt: { lt: before } },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: CONTRACT_PDF_SWEEP_BATCH,
      select: { id: true },
    });
    return [
      ...sent.map((r) => ({ id: r.id, kind: "sent" as const })),
      ...signed.map((r) => ({ id: r.id, kind: "signed" as const })),
    ];
  });
  const out = { made: 0, failed: 0 };
  for (const { id, kind } of due) {
    try {
      const pdf = await makePdf(tenantId, principal, id, kind, now);
      if (pdf.created) out.made += 1;
    } catch (e) {
      out.failed += 1;
      console.error(`contract pdf sweep: ${kind} of contract ${id} failed: ${errorTag(e)}`);
    }
  }
  return out;
}
