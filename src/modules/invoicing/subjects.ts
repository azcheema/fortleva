import { scopeWhere, type MemberActor } from "@/authz/authorize";
import type { TenantDb } from "@/db";
import { accessibleCodes } from "@/entitlements/resolver";

/**
 * WHAT "A RENEWAL INVOICE IS READY TO CHECK" MAY NAME IN THE INBOX (Phase 4
 * slice 113b; founder decision C88 (d)) — the inbox's subject resolution for
 * `invoice.renewal_drafted`, handed over by `src/notify/inbox.ts` because who
 * may read an invoice is this module's rule.
 *
 * The notification's entity is the INVOICE; the row names its client and
 * links to its page. Under the READER's own principal, at read time: named
 * and linked only while the reader holds `invoice:view` on all four gates
 * (the invoicing module switched off, the code taken away — the row then says
 * only what happened) and reaches the invoice's client DIRECTLY by their
 * scope, which is what the page the link opens asks too (`getInvoice`).
 * Otherwise the row resolves to nothing and the inbox draws the kind's label
 * with no name and no link — the same answer for a deleted draft, an
 * out-of-scope one and a not-permitted one.
 *
 * Reads in sequence on the caller's transaction (AGENTS.md's trap); the
 * permission read is ONE `accessibleCodes`, never a leg.
 */

export const INVOICE_SUBJECT_KINDS: readonly string[] = ["invoice.renewal_drafted"];

export const isInvoiceSubjectKind = (kind: string): boolean => INVOICE_SUBJECT_KINDS.includes(kind);

export type InvoiceSubjectRef = {
  /** The notification's id — the key of the answer. */
  readonly id: string;
  readonly kind: string;
  readonly entityType: string;
  readonly entityId: string;
};

export type InvoiceSubject = { readonly title: string; readonly href: string };

export async function invoiceSubjects(
  tx: TenantDb,
  tenantId: string,
  actor: MemberActor,
  refs: readonly InvoiceSubjectRef[],
): Promise<Map<string, InvoiceSubject>> {
  const out = new Map<string, InvoiceSubject>();
  const mine = refs.filter((r) => isInvoiceSubjectKind(r.kind) && r.entityType === "Invoice");
  if (mine.length === 0) return out;
  const may = await accessibleCodes(tx, tenantId, actor, ["invoice:view"]);
  if (!may.has("invoice:view")) return out;
  const scope = await scopeWhere(tx, actor, { clientField: "clientId" });
  const invoices = await tx.invoice.findMany({
    // AND, never a spread: the scope's own term is a `clientId` key (listInvoices' high).
    where: { AND: [{ tenantId }, scope, { id: { in: [...new Set(mine.map((r) => r.entityId))] } }] },
    select: { id: true, client: { select: { name: true } } },
  });
  const byId = new Map(invoices.map((i) => [i.id, i]));
  for (const r of mine) {
    const i = byId.get(r.entityId);
    if (i) out.set(r.id, { title: i.client.name, href: `/invoices/${i.id}` });
  }
  return out;
}
