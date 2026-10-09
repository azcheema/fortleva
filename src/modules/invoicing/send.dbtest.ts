import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { record } from "@/audit/record";
import { AuthzError } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { DomainError } from "@/lib/domain-error";
import { setTransport, type MailTransport } from "@/mailer";
import { actorFor, noMfa, setupTenant } from "@/members/dbtest-fixture";
import { resolvePortalModuleGates, withPortalRead, type PortalPrincipal } from "@/portal";
import { getStorage, LocalDiskTransport, setStorage } from "@/storage";

import { createCreditDraft, creditInFull } from "./credit";
import { addLine, createDraft, getInvoice, updateDraftDetails, updateLine } from "./drafts";
import { issueInvoice, readIssueCheck } from "./issue";
import { ensureInvoicePdf } from "./pdf-store";
import { listPortalInvoices, readPortalInvoice } from "./portal";
import { readPortalInvoicePayment, resolvePortalInvoicePdf } from "./portal-writes";
import { markInvoicePaid, markInvoiceSent, markInvoiceUnpaid, sendInvoice } from "./send";
import { updateCompanyDetails, updatePaymentDetails } from "./seller";
import { setFirstInvoiceNumber } from "./series";

/**
 * SENDING, THE CLIENT'S PORTAL, PAY NOW, PAID BY HAND — against the real
 * database and the real `app_runtime` role (Phase 4 slice 109; founder
 * decision C79; migration 20261010120000_invoice_sending):
 *   - the DATABASE's rules on their own (raw writes): `sent_at` only beside a
 *     send's record by the same member in the same transaction; a send's
 *     record only by a member who may send, never changed; the pay link's
 *     CHECK; a payment recorded or undone, never rewritten; the payment's
 *     note only with its payment;
 *   - the services: the PDF emailed exactly as archived, each address its own
 *     outcome, nothing recorded when nothing went; Mark as sent; Mark as
 *     paid / unpaid; the issue's code and the owners' mail for a pay link;
 *   - the PORTAL, as the client: only SENT invoices and credit notes of their
 *     own client, a main contact's only — the database's gate and belt, not
 *     only the projection — the payment broker's link withheld once anything
 *     is credited, the PDF broker audited to the contact.
 *
 * Tenant slug prefix `invsend-` is registered in `DBTEST_PREFIXES`
 * (e2e/fixtures/seed-cli.ts) so `sweep-dbtests` collects orphans.
 */

// Every test here issues invoices (each a dozen statements and a PDF) and
// sends them several times over the Neon link: the default 30 s budget was
// spent by one that sends three times (measured 2026-10-10).
vi.setConfig({ testTimeout: 120_000 });

let f: Awaited<ReturnType<typeof setupTenant>>;
let gates: Awaited<ReturnType<typeof resolvePortalModuleGates>>;
let acme: string;
let beta: string;
let carol: string; // acme, main contact
let dan: string; // acme, collaborator
let bo: string; // beta, main contact
const run = randomUUID().slice(0, 8);
const storageDir = mkdtempSync(join(tmpdir(), "fortleva-send-pdf-"));
const BLOCKED = `blocked-${run}@test.invalid`;

/** Every message the mailer handed to the transport, with its attachments' bytes. */
const mailed: Parameters<MailTransport>[0][] = [];
let restoreTransport: MailTransport | null = null;

const ctxOf = (memberId: string) => ({ tenantId: f.tenantId, actor: actorFor(memberId) });
const owner = () => ctxOf(f.seats.owner.memberId);
const admin = () => ctxOf(f.seats.admin.memberId);
const manager = () => ctxOf(f.seats.manager.memberId);

/** "ok" or the deterministic reason/code a call was refused with. */
const outcome = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (e instanceof AuthzError) return e.reason;
    if (e instanceof DomainError) return e.code;
    throw e;
  }
};

/** "ok", or which of the database's tokens / constraints refused a raw write. */
const TOKENS = [
  "INVOICE_PAYMENT_NOTE_GUARD",
  "INVOICE_DELIVERY_GUARD",
  "INVOICE_ALREADY_SENT",
  "INVOICE_NOT_DRAFT",
  "INVOICE_GUARD",
  "invoice_pay_link",
  "invoice_sent",
  "invoice_paid",
  "permission denied",
] as const;
const refusal = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "ok";
  } catch (e) {
    const text = `${e instanceof Error ? e.message : String(e)} ${JSON.stringify((e as { meta?: unknown })?.meta ?? "")}`;
    return TOKENS.find((t) => text.includes(t)) ?? `unexpected: ${text.slice(0, 300)}`;
  }
};

const asMember = <T>(memberId: string, fn: (tx: TenantDb) => Promise<T>) => withTenant(f.tenantId, { type: "member", id: memberId }, fn);

const principal = (contactId: string, clientId = acme): PortalPrincipal => ({ contactId, tenantId: f.tenantId, clientId, gates });

/** A draft of one line at 25 % in SEK — the pay link set when given. */
async function draftFor(clientId: string, price: string, payLink?: string): Promise<string> {
  const id = await createDraft(manager(), { clientId });
  await updateDraftDetails(manager(), id, { currency: "SEK", ...(payLink ? { payLinkUrl: payLink } : {}) });
  const line = await addLine(manager(), id, { description: `Work at ${price}` });
  await updateLine(manager(), id, line, { unitPrice: price });
  return id;
}

/** An issued invoice (the admin's code is fresh — `actorFor` — and, with a link, typed in this request). */
async function issuedFor(clientId: string, price: string, payLink?: string): Promise<string> {
  const id = await draftFor(clientId, price, payLink);
  await issueInvoice(admin(), id, payLink ? { codeTypedNow: true } : {});
  return id;
}

/** Mark sent through the service (a send's record + sent_at, ISSUED → SENT). */
async function sentFor(clientId: string, price: string, payLink?: string): Promise<string> {
  const id = await issuedFor(clientId, price, payLink);
  await markInvoiceSent(admin(), id);
  return id;
}

const row = (id: string) => f.platform.invoice.findUniqueOrThrow({ where: { id } });

beforeAll(async () => {
  setStorage(new LocalDiskTransport(storageDir));
  restoreTransport = setTransport(async (m) => {
    if (m.to.includes("boom")) throw new Error("transport down for this one");
    mailed.push(m);
  });
  f = await setupTenant("invsend");
  gates = await resolvePortalModuleGates(f.tenantId);
  acme = randomUUID();
  beta = randomUUID();
  carol = randomUUID();
  dan = randomUUID();
  bo = randomUUID();
  const address = { addressLine1: "Gatan 1", postalCode: "111 22", city: "Stockholm", countryCode: "SE" };
  await f.platform.client.createMany({
    data: [
      { id: acme, tenantId: f.tenantId, name: "Acme AB", orgNr: "556677-8899", billingEmail: `billing-${run}@test.invalid`, ...address },
      { id: beta, tenantId: f.tenantId, name: "Beta AB", ...address },
    ],
  });
  const invitedAt = new Date("2026-09-01T09:00:00Z");
  await f.platform.contact.createMany({
    data: [
      { id: carol, tenantId: f.tenantId, clientId: acme, name: "Carol", email: `invsend-carol-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "ACTIVE", invitedAt, emailVerified: true },
      { id: dan, tenantId: f.tenantId, clientId: acme, name: "Dan", email: `invsend-dan-${run}@test.invalid`, portalProfile: "CONTACT_COLLABORATOR", portalStatus: "ACTIVE", invitedAt, emailVerified: true },
      { id: bo, tenantId: f.tenantId, clientId: beta, name: "Bo", email: `invsend-bo-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "ACTIVE", invitedAt, emailVerified: true },
    ],
  });
  await updateCompanyDetails(owner(), {
    legalName: "Invsend Konsult AB",
    orgNr: "556016-0680",
    vatNumber: "SE556016068001",
    seat: "Stockholm",
    fSkattApproved: true,
    addressLine1: "Storgatan 1",
    postalCode: "111 22",
    city: "Stockholm",
    countryCode: "SE",
  });
  await updatePaymentDetails(owner(), { bankgiro: "5050-1055" });
  await setFirstInvoiceNumber(owner(), "7001");
  await f.platform.emailSuppression.create({ data: { email: BLOCKED, reason: "HARD_BOUNCE", source: "dbtest" } });
}, 120_000);

afterAll(async () => {
  if (restoreTransport) setTransport(restoreTransport);
  setStorage(null);
  await f?.platform.emailSuppression.deleteMany({ where: { email: BLOCKED } });
  if (!f) return;
  await f.deleteInvoices();
  await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.contact.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.client.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.tenantKey.deleteMany({ where: { tenantId: f.tenantId } });
  await f.cleanup();
}, 120_000);

describe("the database's rules on sending (raw writes)", () => {
  it("sent_at only beside this transaction's record of the send by the same member — once", async () => {
    const id = await issuedFor(acme, "100");
    const admins = f.seats.admin.memberId;
    // No record of the send: refused.
    expect(await refusal(asMember(admins, (tx) => tx.$executeRaw`UPDATE invoice SET sent_at = now(), status = 'SENT' WHERE id = ${id}`))).toBe(
      "INVOICE_GUARD",
    );
    // A record by SOMEONE ELSE: refused.
    expect(
      await refusal(
        asMember(admins, (tx) =>
          tx.$executeRaw`INSERT INTO invoice_delivery (id, tenant_id, client_id, invoice_id, method, recipients, sent_by_member_id)
                         VALUES (${randomUUID()}, ${f.tenantId}, ${acme}, ${id}, 'MARKED', '{}', ${f.seats.owner.memberId})`,
        ),
      ),
    ).toBe("INVOICE_DELIVERY_GUARD");
    // The record, then the send, in one transaction: accepted.
    expect(
      await refusal(
        asMember(admins, async (tx) => {
          await tx.$executeRaw`INSERT INTO invoice_delivery (id, tenant_id, client_id, invoice_id, method, recipients, sent_by_member_id)
                               VALUES (${randomUUID()}, ${f.tenantId}, ${acme}, ${id}, 'MARKED', '{}', ${admins})`;
          await tx.$executeRaw`UPDATE invoice SET sent_at = now(), status = 'SENT' WHERE id = ${id}`;
        }),
      ),
    ).toBe("ok");
    // Never moved again, never cleared.
    expect(await refusal(asMember(admins, (tx) => tx.$executeRaw`UPDATE invoice SET sent_at = NULL WHERE id = ${id}`))).toBe("INVOICE_ALREADY_SENT");
  });

  it("a send's record: only a member who may send, of an issued invoice, one to three plain addresses, never changed", async () => {
    const id = await issuedFor(acme, "100");
    const draft = await draftFor(acme, "100");
    const insert = (memberId: string, invoiceId: string, method: string, recipients: string) =>
      asMember(memberId, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO invoice_delivery (id, tenant_id, client_id, invoice_id, method, recipients, sent_by_member_id)
           VALUES ($1, $2, $3, $4, $5::invoice_delivery_method, $6::text[], $7)`,
          randomUUID(),
          f.tenantId,
          acme,
          invoiceId,
          method,
          recipients,
          memberId,
        ),
      );
    // The manager holds no invoice:send.
    expect(await refusal(insert(f.seats.manager.memberId, id, "MARKED", "{}"))).toBe("INVOICE_DELIVERY_GUARD");
    expect(await refusal(insert(f.seats.admin.memberId, draft, "MARKED", "{}"))).toBe("INVOICE_DELIVERY_GUARD");
    expect(await refusal(insert(f.seats.admin.memberId, id, "EMAIL", "{}"))).toBe("INVOICE_DELIVERY_GUARD");
    expect(await refusal(insert(f.seats.admin.memberId, id, "EMAIL", "{a@x.test,b@x.test,c@x.test,d@x.test}"))).toBe("INVOICE_DELIVERY_GUARD");
    expect(await refusal(insert(f.seats.admin.memberId, id, "EMAIL", "{Upper@x.test}"))).toBe("INVOICE_DELIVERY_GUARD");
    expect(await refusal(insert(f.seats.admin.memberId, id, "EMAIL", "{{a@x.test},{b@x.test}}"))).toBe("INVOICE_DELIVERY_GUARD");
    expect(await refusal(insert(f.seats.admin.memberId, id, "MARKED", "{a@x.test}"))).toBe("INVOICE_DELIVERY_GUARD");
    expect(await refusal(insert(f.seats.admin.memberId, id, "EMAIL", "{a@x.test,b@x.test}"))).toBe("ok");
    // No UPDATE grant, and the guard says so too.
    expect(
      await refusal(asMember(f.seats.admin.memberId, (tx) => tx.$executeRaw`UPDATE invoice_delivery SET recipients = '{z@x.test}' WHERE invoice_id = ${id}`)),
    ).toBe("permission denied");
  });

  it("a payment is recorded or undone, never rewritten — and its note only with its payment", async () => {
    const id = await sentFor(acme, "100");
    const admins = f.seats.admin.memberId;
    await markInvoicePaid(admin(), id, { paidOn: new Date().toISOString().slice(0, 10), note: "Ref 42" });
    // The day rewritten in place: refused.
    expect(
      await refusal(asMember(admins, (tx) => tx.$executeRaw`UPDATE invoice SET paid_on = paid_on - 1 WHERE id = ${id}`)),
    ).toBe("INVOICE_GUARD");
    // The note: never changed, never removed while paid.
    expect(
      await refusal(asMember(admins, (tx) => tx.$executeRaw`DELETE FROM invoice_payment_note WHERE invoice_id = ${id}`)),
    ).toBe("INVOICE_PAYMENT_NOTE_GUARD");
    // …and never added to an old payment, even beside a touch of its row (the delta re-check's low).
    const other = await sentFor(acme, "100");
    await markInvoicePaid(admin(), other, { paidOn: new Date().toISOString().slice(0, 10), note: null });
    expect(
      await refusal(
        asMember(admins, async (tx) => {
          await tx.$executeRaw`UPDATE invoice SET updated_at = now() WHERE id = ${other}`;
          await tx.$executeRaw`INSERT INTO invoice_payment_note (tenant_id, client_id, invoice_id, note, created_by_member_id)
                               VALUES (${f.tenantId}, ${acme}, ${other}, 'late note', ${admins})`;
        }),
      ),
    ).toBe("INVOICE_PAYMENT_NOTE_GUARD");
    // A credit note is never paid; a draft never sent.
    const cn = await createCreditDraft(admin(), id, { reason: "Wrong" });
    expect(await refusal(asMember(admins, (tx) => tx.$executeRaw`UPDATE invoice SET sent_at = now() WHERE id = ${cn}`))).toBe("invoice_sent");
  });

  it("the pay link's CHECK: Stripe's or PayPal's own pages only, an invoice's only", async () => {
    const draft = await draftFor(acme, "100");
    const set = (url: string) =>
      refusal(asMember(f.seats.manager.memberId, (tx) => tx.$executeRaw`UPDATE invoice SET pay_link_url = ${url} WHERE id = ${draft}`));
    expect(await set("https://buy.stripe.com/abc")).toBe("ok");
    expect(await set("https://www.paypal.com/invoice/p/#INV2-ABCD")).toBe("ok");
    for (const bad of [
      "http://buy.stripe.com/abc",
      "https://buy.stripe.com@evil.example/abc",
      "https://buy.stripe.com.evil.example/abc",
      "https://buy.stripe.com:8443/abc",
      "https://checkout.stripe.com/c/pay/x",
      "https://evil.example/",
      "https://buy.stripe.com/a\\b",
    ]) {
      expect(await set(bad), bad).toBe("invoice_pay_link");
    }
  });
});

describe("a Pay now link (C79 (c), (f), (g))", () => {
  it("a draft takes only a Stripe or PayPal payment page — a credit note none", async () => {
    const draft = await draftFor(acme, "100");
    expect(await outcome(updateDraftDetails(manager(), draft, { payLinkUrl: "https://evil.example/pay" }))).toBe("INVOICE_PAY_LINK_REFUSED");
    expect(await outcome(updateDraftDetails(manager(), draft, { payLinkUrl: "HTTPS://BUY.STRIPE.COM/test_abc" }))).toBe("ok");
    expect((await row(draft)).payLinkUrl).toBe("https://buy.stripe.com/test_abc");
    // The trail names where the money would go.
    const edited = (await f.audits("invoice.draft_edited")).at(-1);
    expect(edited?.metadata).toMatchObject({ fields: ["payLinkUrl"], payLink: "https://buy.stripe.com/test_abc" });
    expect(await outcome(updateDraftDetails(manager(), draft, { payLinkUrl: "" }))).toBe("ok");
    expect((await row(draft)).payLinkUrl).toBeNull();
    const original = await issuedFor(acme, "100");
    const cn = await createCreditDraft(admin(), original, { reason: "Wrong" });
    expect(await outcome(updateDraftDetails(admin(), cn, { payLinkUrl: "https://buy.stripe.com/x" }))).toBe("INVALID_INPUT");
  });

  it("issuing one takes the issuer's code at that moment, and every owner is told — one without a link does not", async () => {
    const plain = await draftFor(acme, "100");
    expect(await outcome(issueInvoice({ tenantId: f.tenantId, actor: noMfa(f.seats.admin.memberId) }, plain))).toBe("ok");
    const linked = await draftFor(acme, "100", "https://buy.stripe.com/test_paid");
    // No code typed in this request — even with a fresh step-up from elsewhere
    // in the session (the security review's low) — and no fresh factor at all.
    expect(await outcome(issueInvoice(admin(), linked))).toBe("INVOICE_PAY_LINK_CODE");
    expect(
      await outcome(issueInvoice({ tenantId: f.tenantId, actor: noMfa(f.seats.admin.memberId) }, linked, { codeTypedNow: true })),
    ).toBe("INVOICE_PAY_LINK_CODE");
    expect((await row(linked)).status).toBe("DRAFT");
    expect(await outcome(issueInvoice(admin(), linked, { codeTypedNow: true }))).toBe("ok");
    const issued = (await f.audits("invoice.issued")).find((a) => a.targetId === linked);
    expect(issued?.metadata).toMatchObject({ payLink: "https://buy.stripe.com/test_paid" });
    const notices = await f.platform.emailOutbox.findMany({ where: { tenantId: f.tenantId, kind: "invoice.pay_link_issued" } });
    expect(notices.map((n) => n.receiverId)).toEqual([f.seats.owner.memberId]);
    expect(notices[0]?.params).toEqual({ invoiceId: linked });
    // Fixed at issue.
    expect(
      await refusal(asMember(f.seats.admin.memberId, (tx) => tx.$executeRaw`UPDATE invoice SET pay_link_url = NULL WHERE id = ${linked}`)),
    ).toBe("INVOICE_NOT_DRAFT");
  });

  it("the issue is bound to the link the issuer saw", async () => {
    const id = await draftFor(acme, "100");
    const seen = await asMember(f.seats.admin.memberId, (tx) => readIssueCheck(tx, f.tenantId, id));
    await updateDraftDetails(manager(), id, { payLinkUrl: "https://paypal.me/someone/100" });
    // No code typed (the dialog had no field — there was no link when it
    // opened): "it changed", never "type your code" (the fingerprint first —
    // the code review's low; the fix-pass review's test gap).
    expect(await outcome(issueInvoice(admin(), id, { fingerprint: seen.fingerprint }))).toBe("INVOICE_CHANGED");
  });
});

describe("sending (C79 (a), (e))", () => {
  it("emails the PDF exactly as archived to each address, records the send, and opens the portal", async () => {
    const id = await issuedFor(acme, "1000", "https://buy.stripe.com/test_send");
    mailed.length = 0;
    const r = await sendInvoice(admin(), id, { to: [`Accounts-${run}@test.invalid`, `cfo-${run}@test.invalid`, ""] });
    expect(r).toMatchObject({ sent: [`accounts-${run}@test.invalid`, `cfo-${run}@test.invalid`], blocked: [], failed: [], firstSend: true, recorded: true });
    expect(mailed).toHaveLength(2);
    const inv = await row(id);
    const file = await f.platform.fileObject.findUniqueOrThrow({ where: { id: inv.pdfFileId! } });
    const stored = await getStorage().getObject(file.r2Key);
    for (const m of mailed) {
      expect(m.subject).toBe(`Faktura ${inv.displayNumber} från Invsend Konsult AB`);
      expect(m.text).toContain("https://buy.stripe.com/test_send");
      // The portal line links the invoice itself.
      expect(m.text).toContain(`/portal/invoices/${id}`);
      expect(m.text).toContain("Bankgiro: 5050-1055");
      expect(m.attachments).toHaveLength(1);
      const a = m.attachments![0]!;
      expect(a.contentType).toBe("application/pdf");
      expect(a.filename).toBe(file.originalFilename);
      expect(createHash("sha256").update(a.content).digest("hex")).toBe(file.sha256);
      expect(Buffer.from(a.content).equals(Buffer.from(stored!))).toBe(true);
    }
    expect(inv.status).toBe("SENT");
    expect(inv.sentAt).not.toBeNull();
    const deliveries = await f.platform.invoiceDelivery.findMany({ where: { invoiceId: id } });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ method: "EMAIL", recipients: [`accounts-${run}@test.invalid`, `cfo-${run}@test.invalid`], sentByMemberId: f.seats.admin.memberId });
    const audit = (await f.audits("invoice.sent")).find((a) => a.targetId === id);
    expect(audit?.metadata).toEqual({ deliveryId: deliveries[0]!.id, method: "email", sent: 2, notSent: 0, first: true });
    // The reservation, committed before the mail: a count and a digest, never an address.
    const reserved = (await f.audits("invoice.send_attempted")).filter((a) => a.targetId === id);
    expect(reserved).toHaveLength(1);
    expect(reserved[0]!.metadata).toEqual({
      addresses: 2,
      to: expect.stringMatching(/^[0-9a-f]{16}$/),
      attempt: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(JSON.stringify(reserved[0]!.metadata)).not.toContain("@");
    // The same invoice to the same addresses within the minute: a double click.
    expect(await outcome(sendInvoice(admin(), id, { to: [`cfo-${run}@test.invalid`, `accounts-${run}@test.invalid`] }))).toBe(
      "INVOICE_JUST_SENT",
    );
  });

  it("a blocked address and a failing one are their own outcomes; nothing went → nothing recorded", async () => {
    const id = await issuedFor(acme, "100");
    mailed.length = 0;
    const none = await sendInvoice(admin(), id, { to: [BLOCKED, `boom-${run}@test.invalid`] });
    expect(none).toMatchObject({ sent: [], blocked: [BLOCKED], failed: [`boom-${run}@test.invalid`], recorded: false });
    expect(mailed).toHaveLength(0);
    expect((await row(id)).status).toBe("ISSUED");
    expect(await f.platform.invoiceDelivery.count({ where: { invoiceId: id } })).toBe(0);
    // Only the reservation remains — the trace of an attempt — and its void (the
    // code review's medium): a send that reached nobody is no double click.
    expect((await f.audits("invoice.send_attempted")).filter((a) => a.targetId === id)).toHaveLength(1);
    const voids = (await f.audits("invoice.send_attempt_voided")).filter((a) => a.targetId === id);
    expect(voids).toHaveLength(1);
    // …naming the one reservation it cancels.
    const attempts = (await f.audits("invoice.send_attempted")).filter((a) => a.targetId === id);
    expect((voids[0]!.metadata as { attempt: string }).attempt).toBe((attempts[0]!.metadata as { attempt: string }).attempt);
    const again = await sendInvoice(admin(), id, { to: [BLOCKED, `boom-${run}@test.invalid`] });
    expect(again).toMatchObject({ sent: [], recorded: false });
    // A corrected address may go at once: the double-click guard is per address list.
    const some = await sendInvoice(admin(), id, { to: [BLOCKED, `ok-${run}@test.invalid`] });
    expect(some).toMatchObject({ sent: [`ok-${run}@test.invalid`], blocked: [BLOCKED], recorded: true });
    const deliveries = await f.platform.invoiceDelivery.findMany({ where: { invoiceId: id } });
    expect(deliveries.map((d) => d.recipients)).toEqual([[`ok-${run}@test.invalid`]]);
  });

  it("refuses a draft, bad addresses, a member who may not send — and stops at the sending budget", async () => {
    const draft = await draftFor(acme, "100");
    expect(await outcome(sendInvoice(admin(), draft, { to: [`x-${run}@test.invalid`] }))).toBe("INVOICE_NOT_READY");
    const id = await issuedFor(acme, "100");
    expect(await outcome(sendInvoice(manager(), id, { to: [`x-${run}@test.invalid`] }))).toBe("FORBIDDEN");
    expect(await outcome(sendInvoice(admin(), id, { to: ["not an address"] }))).toBe("INVALID_INPUT");
    expect(await outcome(sendInvoice(admin(), id, { to: ["a@x.test", "b@x.test", "c@x.test", "d@x.test"] }))).toBe("INVALID_INPUT");
    expect(await outcome(sendInvoice(admin(), id, { to: [] }))).toBe("INVALID_INPUT");
    // The owner's hour: thirty addresses already reserved (on another invoice),
    // then one more — counted from the committed reservations, as the lock
    // lets each send see the others'.
    const spent = await issuedFor(acme, "100");
    await asMember(f.seats.owner.memberId, async (tx) => {
      for (let i = 0; i < 10; i += 1) {
        await record(tx, {
          action: "invoice.send_attempted",
          targetType: "Invoice",
          targetId: spent,
          metadata: { addresses: 3, to: `digest${i}` },
        });
      }
    });
    expect(await outcome(sendInvoice(owner(), id, { to: [`x-${run}@test.invalid`] }))).toBe("INVOICE_SEND_LIMIT");
    // The admin's own hour is untouched by the owner's.
    expect(await outcome(sendInvoice(admin(), id, { to: [`x-${run}@test.invalid`] }))).toBe("ok");
  });

  it("parallel sends queue on the workspace's lock: each sees the others' reservations", async () => {
    // Three at once, the same invoice and addresses: one goes, the others are
    // double clicks — the reservation is committed before any mail goes.
    const id = await issuedFor(acme, "100");
    mailed.length = 0;
    const results = await Promise.all(
      [0, 1, 2].map(() => outcome(sendInvoice(admin(), id, { to: [`race-${run}@test.invalid`] }))),
    );
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r === "INVOICE_JUST_SENT")).toHaveLength(2);
    expect(mailed.filter((m) => m.to === `race-${run}@test.invalid`)).toHaveLength(1);
  });

  it("says what the invoice is now: paid, or partly credited — and never offers the link then", async () => {
    const paid = await sentFor(acme, "1000", "https://buy.stripe.com/test_now");
    await markInvoicePaid(admin(), paid, { paidOn: new Date().toISOString().slice(0, 10), note: null });
    mailed.length = 0;
    await sendInvoice(admin(), paid, { to: [`copy-${run}@test.invalid`] });
    expect(mailed[0]?.text).toContain("är betald");
    expect(mailed[0]?.text).not.toContain("buy.stripe.com");

    const partly = await sentFor(acme, "1000", "https://buy.stripe.com/test_part");
    const cn = await createCreditDraft(admin(), partly, { reason: "Part" });
    const lines = await f.platform.invoiceLine.findMany({ where: { invoiceId: cn } });
    await updateLine(admin(), cn, lines[0]!.id, { unitPrice: "200" });
    await issueInvoice(admin(), cn);
    // The credit note issued but NOT sent: the client doesn't hold it, so the
    // mail names no "left to pay" — yet the fixed-amount link is withheld.
    mailed.length = 0;
    await sendInvoice(admin(), partly, { to: [`copy2-${run}@test.invalid`] });
    expect(mailed[0]?.text).toContain("Att betala");
    expect(mailed[0]?.text).not.toContain("Kvar att betala");
    expect(mailed[0]?.text).not.toContain("buy.stripe.com");
    // Sent: now it is what is left.
    await markInvoiceSent(admin(), cn);
    mailed.length = 0;
    await sendInvoice(admin(), partly, { to: [`copy3-${run}@test.invalid`] });
    expect(mailed[0]?.text).toContain("Kvar att betala");
    expect(mailed[0]?.text).not.toContain("buy.stripe.com");
  });

  it("a credit note is sent like an invoice — ISSUED → SENT — and is never paid", async () => {
    const original = await sentFor(acme, "500");
    const done = await creditInFull(admin(), original, { reason: "Cancelled", correctedCopy: false });
    mailed.length = 0;
    const r = await sendInvoice(admin(), done.creditNoteId, { to: [`cn-${run}@test.invalid`] });
    expect(r).toMatchObject({ kind: "CREDIT_NOTE", recorded: true, firstSend: true });
    expect(mailed[0]?.subject).toMatch(/^Kreditfaktura /);
    expect((await row(done.creditNoteId)).status).toBe("SENT");
    expect(await outcome(markInvoicePaid(admin(), done.creditNoteId, { paidOn: new Date().toISOString().slice(0, 10), note: null }))).toBe(
      "INVOICE_NOT_PAYABLE",
    );
  });
});

describe("Mark as sent, Mark as paid, Mark as unpaid (C79 (a), (d), (h))", () => {
  it("marks an invoice sent once, by a member who may send", async () => {
    const id = await issuedFor(acme, "100");
    expect(await outcome(markInvoiceSent(manager(), id))).toBe("FORBIDDEN");
    expect(await outcome(markInvoiceSent(admin(), id))).toBe("ok");
    expect(await outcome(markInvoiceSent(admin(), id))).toBe("INVOICE_ALREADY_SENT");
    const deliveries = await f.platform.invoiceDelivery.findMany({ where: { invoiceId: id } });
    expect(deliveries).toMatchObject([{ method: "MARKED", recipients: [] }]);
    expect((await row(id)).status).toBe("SENT");
  });

  it("paid with its day and the team's note; undone back to where it was, the note gone; audited without the note", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const sent = await sentFor(acme, "100");
    expect(await outcome(markInvoicePaid(manager(), sent, { paidOn: today, note: null }))).toBe("FORBIDDEN");
    expect(await outcome(markInvoicePaid(admin(), sent, { paidOn: "2999-01-01", note: null }))).toBe("INVOICE_PAID_ON");
    expect(await outcome(markInvoicePaid(admin(), sent, { paidOn: "2001-01-01", note: null }))).toBe("INVOICE_PAID_ON");
    expect(await outcome(markInvoicePaid(admin(), sent, { paidOn: today, note: "USD 15 short, bank fee" }))).toBe("ok");
    expect(await row(sent)).toMatchObject({ status: "PAID" });
    expect(await f.platform.invoicePaymentNote.findFirst({ where: { invoiceId: sent } })).toMatchObject({ note: "USD 15 short, bank fee" });
    const paidAudit = (await f.audits("invoice.paid")).find((a) => a.targetId === sent);
    expect(paidAudit?.metadata).toEqual({ paidOn: today, noted: true });
    expect(await outcome(markInvoicePaid(admin(), sent, { paidOn: today, note: null }))).toBe("INVOICE_NOT_PAYABLE");
    // The detail the page shows.
    const detail = await getInvoice(admin(), sent);
    expect(detail.paymentNote).toBe("USD 15 short, bank fee");
    expect(detail.can).toMatchObject({ markPaid: false, markUnpaid: true });

    expect(await outcome(markInvoiceUnpaid(manager(), sent))).toBe("FORBIDDEN");
    expect(await outcome(markInvoiceUnpaid(admin(), sent))).toBe("ok");
    expect(await row(sent)).toMatchObject({ status: "SENT", paidOn: null });
    expect(await f.platform.invoicePaymentNote.count({ where: { invoiceId: sent } })).toBe(0);
    const undone = (await f.audits("invoice.payment_undone")).find((a) => a.targetId === sent);
    expect(undone?.metadata).toEqual({ paidOn: today, noted: true });
    expect(await outcome(markInvoiceUnpaid(admin(), sent))).toBe("INVOICE_NOT_PAID");

    // Never sent: back to ISSUED.
    const unsent = await issuedFor(acme, "100");
    await markInvoicePaid(admin(), unsent, { paidOn: today, note: null });
    await markInvoiceUnpaid(admin(), unsent);
    expect(await row(unsent)).toMatchObject({ status: "ISSUED", paidOn: null, sentAt: null });
  });

  it("the database keys the reversal on the payment code — a role without invoice:send still undoes a payment back to SENT", async () => {
    // The code review's test gap: the admin holds both codes, so a guard that
    // keyed PAID → SENT on `invoice:send` would pass the tests above.
    const today = new Date().toISOString().slice(0, 10);
    const id = await sentFor(acme, "100");
    await markInvoicePaid(admin(), id, { paidOn: today, note: null });
    const perm = await f.platform.permission.findFirstOrThrow({ where: { code: "invoice:send" } });
    const grant = { tenantId: f.tenantId, roleId: f.seats.admin.roleId, permissionId: perm.id };
    const { source } = await f.platform.rolePermission.findFirstOrThrow({ where: grant, select: { source: true } });
    await f.platform.rolePermission.updateMany({ where: grant, data: { source: "TENANT_REVOKE" } });
    try {
      expect(
        await refusal(
          asMember(f.seats.admin.memberId, (tx) => tx.$executeRaw`UPDATE invoice SET status = 'SENT', paid_on = NULL WHERE id = ${id}`),
        ),
      ).toBe("ok");
      // …while a FIRST send by the same role is refused (it takes invoice:send).
      const unsent = await issuedFor(acme, "100");
      expect(
        await refusal(
          asMember(f.seats.admin.memberId, async (tx) => {
            await tx.$executeRaw`INSERT INTO invoice_delivery (id, tenant_id, client_id, invoice_id, method, recipients, sent_by_member_id)
                                 VALUES (${randomUUID()}, ${f.tenantId}, ${acme}, ${unsent}, 'MARKED', '{}', ${f.seats.admin.memberId})`;
          }),
        ),
      ).toBe("INVOICE_DELIVERY_GUARD");
    } finally {
      await f.platform.rolePermission.updateMany({ where: grant, data: { source } });
    }
  });

  it("a paid invoice credited later keeps its payment and note", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const id = await sentFor(acme, "300");
    await markInvoicePaid(admin(), id, { paidOn: today, note: "Paid by card" });
    await creditInFull(admin(), id, { reason: "Refunded", correctedCopy: false });
    const after = await row(id);
    expect(after.status).toBe("CREDITED");
    expect(after.paidOn).not.toBeNull();
    expect(await f.platform.invoicePaymentNote.count({ where: { invoiceId: id } })).toBe(1);
  });
});

describe("the client's portal (C79 (b)) — as the client", () => {
  let sentA: string;
  let unsentB: string;
  let draftC: string;
  let betaD: string;
  let creditE: string;
  let linkedF: string;

  beforeAll(async () => {
    sentA = await sentFor(acme, "1000", "https://buy.stripe.com/test_a");
    unsentB = await issuedFor(acme, "100");
    draftC = await draftFor(acme, "100");
    betaD = await sentFor(beta, "100");
    // Part of A credited, and that credit note sent.
    const cn = await createCreditDraft(admin(), sentA, { reason: "Part" });
    const lines = await f.platform.invoiceLine.findMany({ where: { invoiceId: cn } });
    await updateLine(admin(), cn, lines[0]!.id, { unitPrice: "400" });
    await issueInvoice(admin(), cn);
    await markInvoiceSent(admin(), cn);
    creditE = cn;
    linkedF = await sentFor(acme, "250", "https://www.paypal.com/ncp/payment/F");
    await markInvoicePaid(admin(), linkedF, { paidOn: new Date().toISOString().slice(0, 10), note: "SENTINEL-NOTE" });
    await markInvoiceUnpaid(admin(), linkedF);
  }, 180_000);

  it("a main contact reads exactly the sent invoices and credit notes of their own client — the database's gate, not only the projection", async () => {
    const list = await listPortalInvoices(principal(carol), { timeZone: "Europe/Stockholm" });
    const ids = list.invoices.map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining([sentA, creditE, linkedF]));
    expect(ids).not.toContain(unsentB);
    expect(ids).not.toContain(draftC);
    expect(ids).not.toContain(betaD);
    const credit = list.invoices.find((i) => i.id === creditE);
    expect(credit).toMatchObject({ kind: "CREDIT_NOTE", state: "CREDIT_NOTE", credits: { id: sentA } });
    expect(credit!.amount < 0n).toBe(true);
    expect(JSON.stringify(list, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain("SENTINEL");

    // Raw, under the contact's own principal: the same rows and nothing more.
    const raw = await withPortalRead(principal(carol), (tx) => tx.invoice.findMany({ select: { id: true, status: true, sentAt: true } }));
    expect(raw.length).toBeGreaterThan(0);
    expect(raw.every((r) => r.status !== "DRAFT" && r.sentAt !== null)).toBe(true);
    expect(raw.map((r) => r.id)).not.toContain(unsentB);
    expect(raw.map((r) => r.id)).not.toContain(betaD);
    // …and nothing of the agency's records of sends or payment notes.
    expect(await withPortalRead(principal(carol), (tx) => tx.invoiceDelivery.count())).toBe(0);
    expect(await withPortalRead(principal(carol), (tx) => tx.invoicePaymentNote.count())).toBe(0);
    // Another client's main contact sees theirs alone.
    const bos = await listPortalInvoices(principal(bo, beta), { timeZone: "Europe/Stockholm" });
    expect(bos.invoices.map((i) => i.id)).toEqual([betaD]);
  });

  it("a collaborator reads no invoice — refused by the capability AND by the database", async () => {
    // Money is a main contact's: the capability is not in a collaborator's profile.
    expect(await outcome(listPortalInvoices(principal(dan), { timeZone: "Europe/Stockholm" }))).toBe("FORBIDDEN");
    expect(await withPortalRead(principal(dan), (tx) => tx.invoice.count())).toBe(0);
  });

  it("one invoice: its credit notes, what is left — and the Pay now link only while nothing is credited", async () => {
    const a = await readPortalInvoice(principal(carol), sentA, { timeZone: "Europe/Stockholm" });
    expect(a.creditNotes.map((n) => n.id)).toEqual([creditE]);
    expect(a.leftToPay).toBe(a.amount + a.creditNotes[0]!.amount);
    const payA = await readPortalInvoicePayment(principal(carol), sentA);
    expect(payA.payLink).toBeNull();
    expect(payA.bank?.bankgiro).toBe("5050-1055");
    const payF = await readPortalInvoicePayment(principal(carol), linkedF);
    expect(payF.payLink).toBe("https://www.paypal.com/ncp/payment/F");
    expect(await outcome(readPortalInvoice(principal(carol), unsentB, { timeZone: "Europe/Stockholm" }))).toBe("NOT_FOUND");
    expect(await outcome(readPortalInvoicePayment(principal(carol), unsentB))).toBe("NOT_FOUND");
    expect(await outcome(readPortalInvoicePayment(principal(dan), linkedF))).toBe("FORBIDDEN");
  });

  it("the PDF: a short-lived link for a sent invoice, audited to the contact; nothing for an unsent one or another client's", async () => {
    // Marked as sent before its PDF was drawn (the service issues without one;
    // the issue ACTION draws it, the jobs route's sweep catches the rest):
    // the plane's one answer until it exists.
    expect(await outcome(resolvePortalInvoicePdf(principal(carol), sentA))).toBe("NOT_FOUND");
    await ensureInvoicePdf(admin(), sentA);
    const r = await resolvePortalInvoicePdf(principal(carol), sentA);
    expect(r.filename).toMatch(/^faktura-\d+\.pdf$/);
    const audit = (await f.audits("invoice.pdf_downloaded")).find((a) => a.targetId === sentA);
    expect(audit).toMatchObject({ actorType: "CONTACT", actorId: carol });
    expect(await outcome(resolvePortalInvoicePdf(principal(carol), unsentB))).toBe("NOT_FOUND");
    expect(await outcome(resolvePortalInvoicePdf(principal(bo, beta), sentA))).toBe("NOT_FOUND");
    expect(await outcome(resolvePortalInvoicePdf(principal(dan), sentA))).toBe("FORBIDDEN");
  });
});
