import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import { record } from "@/audit/record";
import { assertInScope } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { appUrl, payLinkUrl } from "@/config";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { DomainError, fail } from "@/lib/domain-error";
import { todayIn } from "@/lib/due-date";
import { retryOnContention } from "@/lib/retry";
import { isRecipientRefusal, send } from "@/mailer";
import { resolveReplyAddress } from "@/notify/reply-address-resolve";
import { resolvePortalModuleGates } from "@/portal";
import { readPreferences } from "@/preferences/service";
import { getStorage } from "@/storage";

import { readCreditedTotal } from "./credit-state";
import { guarded } from "./db-errors";
import type { InvoicingCtx } from "./drafts";
import { readIssuedInvoice, SnapshotUnreadable } from "./issued";
import { renderInvoiceMail, type InvoiceMailState } from "./mail";
import { readFixed } from "./money";
import { ensureInvoicePdf, errorTag } from "./pdf-store";
import { isoDay } from "./print";
import { textOrNull } from "./seller-fields";

/**
 * SENDING AN ISSUED INVOICE, AND RECORDING ITS PAYMENT (Phase 4 slice 109;
 * founder decision C79 (a), (d), (e), (h)). DATA_MODEL §6.7; the design and its
 * review: docs/research/2026-10-09-slice-109-sending-design.md.
 *
 * SEND (`invoice:view` + `invoice:send`, the client in DIRECT scope): the
 * issued invoice or credit note EMAILED, with its archived PDF attached (C79
 * (a) — ARC-09's one exception; `src/mailer`'s `attachments`), to one to three
 * addresses the member chose — the client's billing email filled in, changeable
 * (C79 (e)). SYNCHRONOUS, from the click, never the outbox (design §3.1): the
 * member must know at once which addresses took it, and an invoice must not
 * read "sent" — or open the client's portal — for a mail that died on its
 * eighth retry. In order:
 *   1. one transaction: the gates, the frozen record read STRICTLY (an
 *      unreadable one is not sent), what is credited, the workspace's reply
 *      address;
 *   2. the PDF — made now if its issue did not (`ensureInvoicePdf`) — read from
 *      storage and its sha-256 checked against the file row: what is sent is
 *      what was archived;
 *   3. the mail rendered in the INVOICE'S language (`mail.ts`) — what the
 *      invoice is NOW (paid, credited, partly credited: no stale amount, no
 *      fixed-amount link — the design review's M1);
 *   4. the RESERVATION (`reserveSend` — the security review's medium): the
 *      gates again, the budget counted under the workspace's lock from the
 *      reservations already committed, and this send's own committed BEFORE
 *      any mail goes;
 *   5. each address in turn; a blocked address or a refused one is that
 *      address's outcome, a thrown transport error too — never another
 *      address's success thrown away (the review's L2);
 *   6. nothing went → the reservation VOIDED (by its attempt id) and nothing
 *      else recorded, the member told why; something went → a further transaction (the gates again, the
 *      invoice locked, bounded and retried on contention) records the send
 *      (`invoice_delivery`), the FIRST send's `sent_at` — the client's portal
 *      opens to it (C79 (b)) — ISSUED → SENT, and `invoice.sent`. A failure
 *      there, after mail went, is said as such (`recorded: false`): sending
 *      again would mail twice — and the reservation is its trace.
 *
 * MARK AS SENT (`invoice:send`): an invoice sent another way — once; the same
 * record, `MARKED`. MARK AS PAID / UNPAID (`invoice:record_payment`): an
 * INVOICE's payment by hand (C79 (d)) — the day and the agency's note — and its
 * reversal (C79 (h)). Each: the gates, the invoice locked, the write, the audit
 * row, one transaction (AGENTS.md); the database holds every rule again
 * (`invoice_guard`, `invoice_delivery_guard`, migration 20261010120000).
 */

/** Addresses one send may go to (C79 (e): the billing email and up to two more). */
export const INVOICE_MAIL_RECIPIENTS_MAX = 3;
/**
 * THE SENDING BUDGET (the design review's L6): addresses mailed, counted from
 * the workspace's committed send RESERVATIONS (`reserveSend`) — per member per
 * hour, per workspace per day. Invoices go out from the shared sending domain,
 * whose reputation every workspace shares (ARC-09); an agency's real volume is
 * a handful a week.
 */
export const INVOICE_SEND_BUDGET = { memberPerHour: 30, workspacePerDay: 300 } as const;
/** The same invoice emailed again to the same addresses within this is a double click (INVOICE_JUST_SENT). */
export const INVOICE_RESEND_AFTER_SECONDS = 60;
/** An archived PDF larger than this is not a PDF we drew. */
const PDF_MAX_BYTES = 10 * 1024 * 1024;
/** The record's lock wait (the second transaction runs after the mail went). */
const SEND_LOCK_WAIT_MS = 5_000;
/** A payment's note, at most this long (the CHECK's). */
export const PAYMENT_NOTE_MAX = 500;

const memberPrincipal = (ctx: InvoicingCtx) => ({ type: "member", id: ctx.actor.memberId }) as const;

const email = z.email();

/** One to three distinct addresses, lower-cased; blanks dropped. A typed refusal otherwise. */
export function parseRecipients(raw: unknown): string[] {
  if (!Array.isArray(raw)) return fail("INVALID_INPUT", "recipients");
  const out: string[] = [];
  for (const r of raw) {
    if (typeof r !== "string") return fail("INVALID_INPUT", "recipients");
    const address = r.trim().toLowerCase();
    if (address === "") continue;
    if (address.length > 254 || !email.safeParse(address).success) return fail("INVALID_INPUT", "email");
    if (!out.includes(address)) out.push(address);
  }
  if (out.length === 0 || out.length > INVOICE_MAIL_RECIPIENTS_MAX) return fail("INVALID_INPUT", "recipients");
  return out;
}

/** The gates every verb here takes, in order: the permissions, then the client in DIRECT scope. */
async function openInvoice(
  tx: TenantDb,
  ctx: InvoicingCtx,
  invoiceId: string,
  code: "invoice:send" | "invoice:record_payment",
): Promise<string> {
  await requireAccess(tx, ctx.tenantId, ctx.actor, "invoice:view");
  await requireAccess(tx, ctx.tenantId, ctx.actor, code);
  const scoped = await tx.invoice.findFirst({ where: { id: invoiceId }, select: { clientId: true } });
  if (!scoped) return deny("NOT_FOUND");
  await assertInScope(tx, ctx.actor, { clientId: scoped.clientId });
  return scoped.clientId;
}

/**
 * The invoice row, locked — the one row lock every write here takes, and
 * FIRST: a send's record or a payment's note, inserted after it, takes FOR KEY
 * SHARE on this row through its foreign key, which the lock already covers (the
 * migration's LOCKS note — the other order deadlocks two concurrent sends).
 */
async function lockInvoice(
  tx: TenantDb,
  invoiceId: string,
): Promise<{ readonly status: string; readonly kind: string; readonly sentAt: Date | null; readonly paidOn: Date | null; readonly issueDate: Date | null }> {
  const rows = await tx.$queryRaw<{ status: string; kind: string; sent_at: Date | null; paid_on: Date | null; issue_date: Date | null }[]>`
    SELECT status::text AS status, kind::text AS kind, sent_at, paid_on, issue_date
      FROM invoice WHERE id = ${invoiceId} FOR UPDATE`;
  const row = rows[0];
  if (!row) return deny("NOT_FOUND");
  return { status: row.status, kind: row.kind, sentAt: row.sent_at, paidOn: row.paid_on, issueDate: row.issue_date };
}

/** The audit action that RESERVES a send's place in the budget, before any mail goes. */
export const SEND_ATTEMPT_ACTION = "invoice.send_attempted";
/**
 * …and the one that VOIDS a reservation whose send reached nobody (the code
 * review's medium): a retry of the same addresses is then no "double click",
 * and the addresses that never went do not count against the budget.
 */
export const SEND_VOID_ACTION = "invoice.send_attempt_voided";

/**
 * A short digest of the address list — the double-click guard's key. Not the
 * addresses, but not secret either (the fix-pass review's nit): it is
 * unsalted, so someone who can read the audit log could confirm a guessed
 * single address — the same members can read the invoice's own record of
 * where it was sent, so it discloses nothing they cannot already see.
 */
const addressDigest = (addresses: readonly string[]): string =>
  createHash("sha256").update([...addresses].sort().join("\n")).digest("hex").slice(0, 16);

/**
 * THE SEND'S RESERVATION (the security review's medium, and its low on mail
 * leaving no trace): under a per-WORKSPACE advisory lock, the budget is
 * counted from the reservations already COMMITTED — `invoice.send_attempted`
 * audit rows, each with its address count — and this send's own is written
 * and committed BEFORE any mail goes. Parallel sends therefore queue on the
 * lock and each sees the others' reservations: the caps hold under
 * concurrency, and an attempt whose record later fails still left a trace.
 *
 *   - the same invoice to the SAME addresses within a minute is a double click
 *     (INVOICE_JUST_SENT) — keyed on a digest of the address list, so a member
 *     who fixes a blocked address may send again at once;
 *   - this member's addresses in the last hour, the workspace's in the last
 *     day (INVOICE_SEND_LIMIT).
 *
 * The counting statement is a NEW statement after the lock (READ COMMITTED),
 * so it sees what committed while this waited; `now()` is the transaction's
 * start, at most the wait earlier — the windows only widen by it.
 *
 * A VOID (`invoice.send_attempt_voided`, written when a send reached nobody)
 * names the ONE reservation it cancels by its `attempt` id (the fix-pass
 * review's low): matched by time, a slow failed send's void — landing after a
 * later send's reservation of the same list — would have voided that one too.
 * A reservation counts, in the guard and in both sums, unless its own void
 * exists. Returns the attempt's id, for the void.
 */
async function reserveSend(tx: TenantDb, ctx: InvoicingCtx, invoiceId: string, addresses: readonly string[]): Promise<string> {
  const locked = await tx.$queryRaw<{ now: Date }[]>`
    WITH locked AS (SELECT pg_advisory_xact_lock(hashtext(${`invoice_send:${ctx.tenantId}`})))
    SELECT now() AS now FROM locked`;
  if (!locked[0]) throw new Error("invoice send: the reservation lock returned no clock");
  const digest = addressDigest(addresses);
  const rows = await tx.$queryRaw<{ just: boolean; member: number; workspace: number }[]>`
    WITH live AS (
      SELECT a.target_id, a.actor_type, a.actor_id, a.created_at, a.metadata
        FROM audit_event a
       WHERE a.tenant_id = ${ctx.tenantId} AND a.action = ${SEND_ATTEMPT_ACTION}
         AND a.created_at > now() - interval '1 day'
         AND NOT EXISTS (SELECT 1 FROM audit_event v
                          WHERE v.tenant_id = a.tenant_id AND v.action = ${SEND_VOID_ACTION}
                            AND v.target_id = a.target_id
                            AND v.metadata->>'attempt' = a.metadata->>'attempt')
    )
    SELECT
      EXISTS (SELECT 1 FROM live
               WHERE live.target_id = ${invoiceId} AND live.metadata->>'to' = ${digest}
                 AND live.created_at > now() - make_interval(secs => ${INVOICE_RESEND_AFTER_SECONDS})) AS just,
      (SELECT coalesce(sum((live.metadata->>'addresses')::int), 0)::int FROM live
        WHERE live.actor_type = 'MEMBER' AND live.actor_id = ${ctx.actor.memberId}
          AND live.created_at > now() - interval '1 hour') AS member,
      (SELECT coalesce(sum((live.metadata->>'addresses')::int), 0)::int FROM live) AS workspace`;
  const used = rows[0];
  if (!used) throw new Error("invoice send: no budget row");
  if (used.just) return fail("INVOICE_JUST_SENT");
  if (
    used.member + addresses.length > INVOICE_SEND_BUDGET.memberPerHour ||
    used.workspace + addresses.length > INVOICE_SEND_BUDGET.workspacePerDay
  ) {
    return fail("INVOICE_SEND_LIMIT");
  }
  // The reservation: a count, the list's digest and its own id — never an address.
  const attempt = randomUUID();
  await record(tx, {
    action: SEND_ATTEMPT_ACTION,
    targetType: "Invoice",
    targetId: invoiceId,
    metadata: { addresses: addresses.length, to: digest, attempt },
  });
  return attempt;
}

export type InvoiceSendResult = {
  readonly kind: "INVOICE" | "CREDIT_NOTE";
  readonly displayNumber: string;
  /** The addresses that took it. */
  readonly sent: readonly string[];
  /** Blocked (bounced or reported before) or refused by the transport for that address. */
  readonly blocked: readonly string[];
  /** The transport failed for these. */
  readonly failed: readonly string[];
  /** This was its first send: it is in the client's portal now. */
  readonly firstSend: boolean;
  /** Mail went but recording the send failed — sending again would mail twice. */
  readonly recorded: boolean;
};

/** `invoice:send` — email the issued invoice or credit note with its PDF (C79 (a), (e)). */
export async function sendInvoice(ctx: InvoicingCtx, invoiceId: string, input: { readonly to: unknown }): Promise<InvoiceSendResult> {
  const to = parseRecipients(input.to);

  // 1. The gates, the budget and what the mail says.
  const read = await withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await openInvoice(tx, ctx, invoiceId, "invoice:send");
    const invoice = await tx.invoice.findFirst({
      where: { id: invoiceId },
      select: {
        status: true,
        kind: true,
        total: true,
        payLinkUrl: true,
        pdfFile: { select: { id: true, r2Key: true, sha256: true, originalFilename: true } },
      },
    });
    if (!invoice) return deny("NOT_FOUND");
    if (invoice.status === "DRAFT") return fail("INVOICE_NOT_READY");
    let issued: Awaited<ReturnType<typeof readIssuedInvoice>>;
    try {
      issued = await readIssuedInvoice(tx, ctx.tenantId, invoiceId, { strict: true });
    } catch (e) {
      if (e instanceof SnapshotUnreadable) {
        console.error(`invoice send: ${e.message} (invoice ${invoiceId})`);
        return fail("INVOICE_PDF_UNAVAILABLE");
      }
      throw e;
    }
    if (!issued) return deny("NOT_FOUND");
    // Every ISSUED credit note withholds the fixed-amount link; what is LEFT
    // TO PAY counts only those the client has been SENT (the code review's
    // low — the portal's own rule, so the mail never names a credit note the
    // client does not hold). In turn, one statement each.
    const credited = invoice.kind === "INVOICE" ? await readCreditedTotal(tx, invoiceId) : null;
    const creditedSent = invoice.kind === "INVOICE" ? await readCreditedTotal(tx, invoiceId, { sentOnly: true }) : null;
    const replyTo = await resolveReplyAddress(tx, ctx.tenantId);
    return { invoice, issued, credited, creditedSent, replyTo };
  });
  const { invoice, issued, credited, creditedSent, replyTo } = read;
  // The portal's line links the invoice itself — only while the client's
  // portal (and invoicing in it) is open (the code review's low).
  const gates = await resolvePortalModuleGates(ctx.tenantId);
  const portalUrl = gates.portal === "ok" && gates.invoicing === "ok" ? new URL(`/portal/invoices/${invoiceId}`, appUrl).toString() : null;

  // 2. The archived PDF — made now if its issue did not — exactly as archived.
  let file = invoice.pdfFile;
  if (!file) {
    const made = await ensureInvoicePdf(ctx, invoiceId);
    file = await withTenant(ctx.tenantId, memberPrincipal(ctx), (tx) =>
      tx.fileObject.findFirst({ where: { id: made.fileObjectId }, select: { id: true, r2Key: true, sha256: true, originalFilename: true } }),
    );
    if (!file) return fail("INVOICE_PDF_UNAVAILABLE");
  }
  let bytes: Uint8Array | null;
  try {
    bytes = await getStorage().getObject(file.r2Key);
  } catch (e) {
    console.error(`invoice send: the PDF could not be read (invoice ${invoiceId}): ${errorTag(e)}`);
    return fail("INVOICE_PDF_UNAVAILABLE");
  }
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > PDF_MAX_BYTES) return fail("INVOICE_PDF_UNAVAILABLE");
  if (createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
    console.error(`invoice send: the stored PDF does not match its record (invoice ${invoiceId}, file ${file.id})`);
    return fail("INVOICE_PDF_UNAVAILABLE");
  }

  // 3. The mail, in the invoice's language, saying what the invoice is NOW.
  const kind = invoice.kind;
  let state: InvoiceMailState = { kind: "open" };
  if (kind === "INVOICE") {
    if (invoice.status === "PAID") state = { kind: "paid" };
    else if (invoice.status === "CREDITED") state = { kind: "credited" };
    else if (creditedSent && creditedSent.count > 0 && invoice.total !== null) {
      const left = readFixed(invoice.total, 2) - creditedSent.total;
      state = left > 0n ? { kind: "partly", left } : { kind: "credited" };
    }
  }
  const mail = renderInvoiceMail(issued.print, {
    // Re-checked against today's fence (the security review's nit): a host
    // taken off the list since the issue is never mailed again — and never
    // once anything of the invoice is credited (a fixed-amount link).
    payLink:
      kind === "INVOICE" && invoice.payLinkUrl !== null && (credited?.count ?? 0) === 0
        ? (payLinkUrl(invoice.payLinkUrl)?.href ?? null)
        : null,
    state,
    portalUrl,
    replyable: replyTo !== null,
  });
  const attachment = {
    filename: file.originalFilename ?? `${issued.print.displayNumber}.pdf`,
    contentType: "application/pdf" as const,
    content: bytes,
  };

  // 4. The reservation — the gates again, the budget under the workspace's
  //    lock, this send's place committed BEFORE any mail goes.
  const attempt = await withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await openInvoice(tx, ctx, invoiceId, "invoice:send");
    return reserveSend(tx, ctx, invoiceId, to);
  });

  // 5. Each address in turn — each its own outcome.
  const sent: string[] = [];
  const blocked: string[] = [];
  const failed: string[] = [];
  for (const address of to) {
    try {
      const outcome = await send({
        to: address,
        subject: mail.subject,
        text: mail.text,
        ...(replyTo ? { replyTo } : {}),
        attachments: [attachment],
      });
      (outcome === "sent" ? sent : blocked).push(address);
    } catch (e) {
      if (isRecipientRefusal(e)) blocked.push(address);
      else {
        failed.push(address);
        // The name and code only: a transport's message can quote the address.
        console.error(`invoice send: the transport failed (invoice ${invoiceId}): ${errorTag(e)}`);
      }
    }
  }
  const base = { kind, displayNumber: issued.print.displayNumber, sent, blocked, failed };
  if (sent.length === 0) {
    // Nothing went: VOID the reservation, so a retry of the same addresses is
    // no "double click" and the budget is not spent (the code review's
    // medium). Best effort — a failure leaves the reservation, which only
    // errs towards refusing.
    try {
      await withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
        await openInvoice(tx, ctx, invoiceId, "invoice:send");
        await record(tx, {
          action: SEND_VOID_ACTION,
          targetType: "Invoice",
          targetId: invoiceId,
          // Names the ONE reservation it cancels (the fix-pass review's low).
          metadata: { addresses: to.length, to: addressDigest(to), attempt },
        });
      });
    } catch (e) {
      console.error(`invoice send: the void of a send that reached nobody failed (invoice ${invoiceId}): ${e instanceof DomainError ? e.code : errorTag(e)}`);
    }
    return { ...base, firstSend: false, recorded: false };
  }

  // 6. The record — after the mail, so "sent" is never claimed for mail that did not go.
  try {
    const firstSend = await retryOnContention(() =>
      guarded(() =>
        withTenant(
          ctx.tenantId,
          memberPrincipal(ctx),
          async (tx) => {
            const clientId = await openInvoice(tx, ctx, invoiceId, "invoice:send");
            const locked = await lockInvoice(tx, invoiceId);
            // The record first: the guard admits `sent_at` only beside this
            // transaction's record of the send by this member.
            const delivery = await tx.invoiceDelivery.create({
              data: { tenantId: ctx.tenantId, clientId, invoiceId, method: "EMAIL", recipients: sent, sentByMemberId: ctx.actor.memberId },
              select: { id: true },
            });
            const first = locked.sentAt === null;
            if (first) {
              await tx.invoice.update({
                where: { id: invoiceId },
                data: { sentAt: new Date(), ...(locked.status === "ISSUED" ? { status: "SENT" as const } : {}) },
                select: { id: true },
              });
            }
            await record(tx, {
              action: "invoice.sent",
              targetType: "Invoice",
              targetId: invoiceId,
              // Counts, never an address: the addresses are on the record of the send.
              metadata: { deliveryId: delivery.id, method: "email", sent: sent.length, notSent: blocked.length + failed.length, first },
            });
            return first;
          },
          { lockTimeoutMs: SEND_LOCK_WAIT_MS },
        ),
      ),
    );
    return { ...base, firstSend, recorded: true };
  } catch (e) {
    // The mail went. Say so, rather than an error that invites sending again —
    // a spent lock wait, a lost deadlock, a gate that closed meanwhile alike.
    console.error(
      `invoice send: mail went but the send was not recorded (invoice ${invoiceId}): ${e instanceof DomainError ? e.code : errorTag(e)}`,
    );
    return { ...base, firstSend: false, recorded: false };
  }
}

/** `invoice:send` — "Mark as sent": an issued invoice sent another way, once (C79 (a)). */
export async function markInvoiceSent(ctx: InvoicingCtx, invoiceId: string): Promise<void> {
  await guarded(() =>
    withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
      const clientId = await openInvoice(tx, ctx, invoiceId, "invoice:send");
      const locked = await lockInvoice(tx, invoiceId);
      if (locked.status === "DRAFT") return fail("INVOICE_NOT_READY");
      if (locked.sentAt !== null) return fail("INVOICE_ALREADY_SENT");
      const delivery = await tx.invoiceDelivery.create({
        data: { tenantId: ctx.tenantId, clientId, invoiceId, method: "MARKED", recipients: [], sentByMemberId: ctx.actor.memberId },
        select: { id: true },
      });
      await tx.invoice.update({
        where: { id: invoiceId },
        data: { sentAt: new Date(), ...(locked.status === "ISSUED" ? { status: "SENT" as const } : {}) },
        select: { id: true },
      });
      await record(tx, {
        action: "invoice.sent",
        targetType: "Invoice",
        targetId: invoiceId,
        metadata: { deliveryId: delivery.id, method: "marked", first: true },
      });
    }),
  );
}

/** A date input's `YYYY-MM-DD`, or a typed refusal. */
function parseDay(raw: unknown): string {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return fail("INVOICE_PAID_ON");
  const d = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || isoDay(d) !== raw) return fail("INVOICE_PAID_ON");
  return raw;
}

/** Days between two `YYYY-MM-DD`s, b − a. */
const daysBetween = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * `invoice:record_payment` — "Mark as paid…" (C79 (d)): an unpaid INVOICE paid,
 * on the day the money arrived — not after today in the workspace's zone, not
 * more than a year before the invoice's date — with the agency's own note.
 */
export async function markInvoicePaid(
  ctx: InvoicingCtx,
  invoiceId: string,
  input: { readonly paidOn: unknown; readonly note: unknown },
  now: Date = new Date(),
): Promise<void> {
  const paidOn = parseDay(input.paidOn);
  const note = input.note === undefined || input.note === null ? null : textOrNull(input.note, PAYMENT_NOTE_MAX);
  await guarded(() =>
    withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
      const clientId = await openInvoice(tx, ctx, invoiceId, "invoice:record_payment");
      const locked = await lockInvoice(tx, invoiceId);
      if (locked.kind !== "INVOICE" || (locked.status !== "ISSUED" && locked.status !== "SENT")) return fail("INVOICE_NOT_PAYABLE");
      const today = todayIn((await readPreferences(tx, ctx.tenantId)).timezone, now);
      if (paidOn > today || (locked.issueDate !== null && daysBetween(paidOn, isoDay(locked.issueDate)) > 366)) {
        return fail("INVOICE_PAID_ON");
      }
      await tx.invoice.update({
        where: { id: invoiceId },
        data: { status: "PAID", paidOn: new Date(`${paidOn}T00:00:00Z`) },
        select: { id: true },
      });
      // The note on its own class-A row, AFTER the move: its guard admits it
      // only beside this transaction's move to PAID.
      if (note !== null) {
        await tx.invoicePaymentNote.create({
          data: { tenantId: ctx.tenantId, clientId, invoiceId, note, createdByMemberId: ctx.actor.memberId },
          select: { invoiceId: true },
        });
      }
      await record(tx, {
        action: "invoice.paid",
        targetType: "Invoice",
        targetId: invoiceId,
        // The day and whether there is a note — never the note (it is the agency's).
        metadata: { paidOn, noted: note !== null },
      });
    }),
  );
}

/**
 * `invoice:record_payment` — "Mark as unpaid" (C79 (h)): a paid INVOICE back to
 * SENT (or ISSUED, never sent), its day and note cleared — audited with what
 * was undone, the only trace of it once the row forgets.
 */
export async function markInvoiceUnpaid(ctx: InvoicingCtx, invoiceId: string): Promise<void> {
  await guarded(() =>
    withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
      await openInvoice(tx, ctx, invoiceId, "invoice:record_payment");
      const locked = await lockInvoice(tx, invoiceId);
      if (locked.kind !== "INVOICE" || locked.status !== "PAID") return fail("INVOICE_NOT_PAID");
      // Whether there was a note, read under the lock: the move below takes it
      // away — the invoice's own guard deletes it with the payment.
      const noted = (await tx.invoicePaymentNote.count({ where: { invoiceId } })) > 0;
      await tx.invoice.update({
        where: { id: invoiceId },
        data: { status: locked.sentAt !== null ? "SENT" : "ISSUED", paidOn: null },
        select: { id: true },
      });
      await record(tx, {
        action: "invoice.payment_undone",
        targetType: "Invoice",
        targetId: invoiceId,
        metadata: { paidOn: locked.paidOn ? isoDay(locked.paidOn) : null, noted },
      });
    }),
  );
}
