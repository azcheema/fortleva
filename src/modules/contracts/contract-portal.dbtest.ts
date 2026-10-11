import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { withRequestContext } from "@/lib/request-context";
import { DomainError } from "@/lib/domain-error";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";
import { CONTRACT_SENT_MAIL, CONTRACT_SIGNED_MAIL } from "@/notify/contract-mail-keys";
import { listInbox } from "@/notify/inbox";
import { resolvePortalModuleGates, type PortalPrincipal } from "@/portal";
import { countClientSummary } from "@/portal/weekly-summary";
import { LocalDiskTransport, setStorage } from "@/storage";

import { readContract, startContract, updateContractDraft } from "./drafts";
import { countPortalContractsToSign, listPortalContracts, portalContractsShown, readPortalContract } from "./portal";
import { decidePortalContract } from "./portal-sign";
import { sendContract, withdrawContract } from "./send";
import { parseContractDecision } from "./sign-input";

/**
 * THE CLIENT'S SIDE OF A CONTRACT against the real database and the real
 * app_runtime role (Phase 4 slice 112b2; founder decisions C84, C85; migration
 * 20261013090000; the design: docs/research/2026-10-10-slice-112-contracts-
 * design.md §13):
 *   - the agency's signature carries the workspace's CONFIRMED reply address,
 *     else none — never a login email (C85 (e));
 *   - what a contact reads: their own client's sent contracts, main contacts
 *     only, no email, no member id, never a draft;
 *   - signing and declining through the service — a census write under the
 *     signer's own principal: the contract moved, the evidence the REQUEST's,
 *     the audit row the contact's, the sender told, the signed copy drawn and
 *     mailed; once; only by the signer; never on a withdrawn contract;
 *   - "waiting for your signature" — the home's count, the weekly summary's —
 *     joins the contract's own SENT status.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let acme: string;
let beta: string;
let eva: string; // acme, main contact, in the portal — the signer
let ella: string; // acme, main contact, in the portal — a colleague
let carl: string; // acme, collaborator, in the portal
let bo: string; // beta, main contact
let gates: Awaited<ReturnType<typeof resolvePortalModuleGates>>;
const emails: Record<string, string> = {};
const storageDir = mkdtempSync(join(tmpdir(), "fortleva-contract-portal-"));

const ctxOf = (memberId: string) => ({ tenantId: f.tenantId, actor: actorFor(memberId) });
const manager = () => ctxOf(f.seats.manager.memberId);
const principal = (contactId: string, clientId = acme): PortalPrincipal => ({ contactId, tenantId: f.tenantId, clientId, gates });

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

const doc = (...paras: string[]) => ({
  type: "doc",
  content: paras.map((t) => ({ type: "paragraph", content: [{ type: "text", text: t }] })),
});

async function sent(title: string, signer = eva): Promise<string> {
  const { id } = await startContract(manager(), { clientId: acme, templateId: null, title, signerContactId: signer });
  await updateContractDraft(manager(), id, { body: doc("Scope: a website.", "Price: 10 000 SEK.") });
  await sendContract(manager(), id, { seen: (await readContract(manager(), id)).updatedAt.toISOString(), typedName: "Maja Manager" });
  return id;
}

const sign = (contactId: string, contractId: string, typedName = "Eva Ek") =>
  withRequestContext({ requestId: randomUUID(), ip: "198.51.100.9", userAgent: "TestBrowser/1.0" }, () =>
    decidePortalContract(principal(contactId), contractId, parseContractDecision({ decision: "SIGNED", accepted: true, typedName })),
  );

const decline = (contactId: string, contractId: string, reason: string | null) =>
  decidePortalContract(principal(contactId), contractId, parseContractDecision({ decision: "DECLINED", reason }));

const agencyEmail = async (contractId: string) =>
  (await f.platform.contractSignature.findFirstOrThrow({ where: { contractId, party: "TENANT" }, select: { signerEmail: true } })).signerEmail;

const setPreference = async (key: string, value: object | null) => {
  await f.platform.tenantPreference.deleteMany({ where: { tenantId: f.tenantId, key } });
  if (value) await f.platform.tenantPreference.create({ data: { tenantId: f.tenantId, key, value } });
};

beforeAll(async () => {
  f = await setupTenant("ctrportal");
  setStorage(new LocalDiskTransport(storageDir));
  gates = await resolvePortalModuleGates(f.tenantId);
  const run = randomUUID().slice(0, 8);
  acme = randomUUID();
  beta = randomUUID();
  eva = randomUUID();
  ella = randomUUID();
  carl = randomUUID();
  bo = randomUUID();
  await f.platform.client.createMany({
    data: [
      { id: acme, tenantId: f.tenantId, name: "Acme AB", orgNr: "556677-8899", addressLine1: "Storgatan 1", postalCode: "111 22", city: "Stockholm", countryCode: "SE" },
      { id: beta, tenantId: f.tenantId, name: "Beta AB" },
    ],
  });
  const invitedAt = new Date("2026-09-01T09:00:00Z");
  const contact = (id: string, clientId: string, name: string, profile: "CONTACT_PRIMARY" | "CONTACT_COLLABORATOR") => {
    emails[id] = `ctrportal-${name.toLowerCase().replace(/\s+/g, "")}-${run}@test.invalid`;
    return {
      id,
      tenantId: f.tenantId,
      clientId,
      name,
      email: emails[id]!,
      portalProfile: profile,
      portalStatus: "ACTIVE" as const,
      invitedAt,
      emailVerified: true,
    };
  };
  await f.platform.contact.createMany({
    data: [
      contact(eva, acme, "Eva Ek", "CONTACT_PRIMARY"),
      contact(ella, acme, "Ella Eng", "CONTACT_PRIMARY"),
      contact(carl, acme, "Carl", "CONTACT_COLLABORATOR"),
      contact(bo, beta, "Bo", "CONTACT_PRIMARY"),
    ],
  });
  await f.platform.tenant.update({
    where: { id: f.tenantId },
    data: { legalName: "Portal Konsult AB", orgNr: "556016-0680", addressLine1: "Kungsgatan 2", postalCode: "411 19", city: "Göteborg", countryCode: "SE" },
  });
  // The fixture names every seat's user by its email; the agency's signature
  // copies the sender's NAME, which a client reads — so the sender gets a real
  // one, or the "no email in what a client reads" check below would find the
  // fixture's (the code review's high).
  await f.platform.user.update({ where: { id: f.seats.manager.userId }, data: { name: "Maja Manager" } });
}, 180_000);

afterAll(async () => {
  setStorage(null);
  if (!f) return;
  await f.deleteInvoices(); // contracts, their signatures and PDFs too (slice 112)
  await f.platform.notification.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.contact.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.client.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.tenantKey.deleteMany({ where: { tenantId: f.tenantId } });
  await f.cleanup();
}, 180_000);

describe("the agency's signature names the workspace's reply address, never a login (C85 (e))", () => {
  it("NULL with nothing confirmed — an owner present, only a pending address, or an address without its confirmation", async () => {
    // The fixture's workspace has an owner, whose login is `resolveReplyAddress`'s fallback.
    expect(await agencyEmail(await sent("Nothing set"))).toBeNull();
    await setPreference("mail.replyToPending", { email: "pending@sigs.example", requestedAt: new Date().toISOString(), requestedByMemberId: f.seats.owner.memberId });
    expect(await agencyEmail(await sent("Only pending"))).toBeNull();
    await setPreference("mail.replyTo", { email: "unconfirmed@sigs.example", requestedByMemberId: null });
    expect(await agencyEmail(await sent("Not confirmed"))).toBeNull();
    await setPreference("mail.replyToPending", null);
  });

  it("the confirmed address, lower-cased — frozen at sending", async () => {
    await setPreference("mail.replyTo", { email: "Hej@Portal.example", confirmedAt: new Date().toISOString(), requestedByMemberId: null });
    const id = await sent("Confirmed");
    expect(await agencyEmail(id)).toBe("hej@portal.example");
    await setPreference("mail.replyTo", null);
    expect(await agencyEmail(id)).toBe("hej@portal.example");
    // …and the client's row still carries the signer's own.
    const client = await f.platform.contractSignature.findFirstOrThrow({ where: { contractId: id, party: "CLIENT" }, select: { signerEmail: true } });
    expect(client.signerEmail).toBe(emails[eva]);
  });

  it("the send queues the signer's mail, once, in the contract's language, naming nothing but the link", async () => {
    const id = await sent("Mailed");
    const language = (await readContract(manager(), id)).language;
    const mails = await f.platform.emailOutbox.findMany({ where: { tenantId: f.tenantId, kind: CONTRACT_SENT_MAIL, params: { equals: { contractId: id } } } });
    expect(mails.map((m) => [m.receiverType, m.receiverId, m.toEmail, m.locale])).toEqual([["CONTACT", eva, emails[eva], language]]);
  });
});

describe("what a client reads", () => {
  it("a main contact reads their client's sent contracts — never a draft, never an email or a member id", async () => {
    const id = await sent("Readable");
    const { id: draft } = await startContract(manager(), { clientId: acme, templateId: null, title: "Still a draft", signerContactId: eva });

    const list = await listPortalContracts(principal(ella));
    expect(list.contracts.some((c) => c.id === id && c.status === "SENT" && !c.waitingForYou)).toBe(true);
    expect(list.contracts.some((c) => c.id === draft)).toBe(false);
    expect((await listPortalContracts(principal(eva))).contracts.find((c) => c.id === id)?.waitingForYou).toBe(true);
    expect(await outcome(readPortalContract(principal(eva), draft))).toBe("NOT_FOUND");

    const detail = await readPortalContract(principal(eva), id);
    expect(detail).toMatchObject({ title: "Readable", status: "SENT", waitingForYou: true, canSign: true, pdfReady: false });
    expect(detail.parties?.agency.name).toBe("Portal Konsult AB");
    expect(detail.signatures.map((s) => [s.party, s.name, s.status])).toEqual([
      ["TENANT", "Maja Manager", "SIGNED"],
      ["CLIENT", "Eva Ek", "PENDING"],
    ]);
    const text = JSON.stringify(detail);
    expect(text).not.toMatch(/@/);
    for (const seat of Object.values(f.seats)) expect(text).not.toContain(seat.memberId);
    // A colleague sees it, and whom it waits for — but may not sign it.
    expect((await readPortalContract(principal(ella), id)).canSign).toBe(false);
    expect(await portalContractsShown(principal(ella))).toBe(true);
  });

  it("a collaborator reads no contract; another client's person reads none of this client's", async () => {
    const id = await sent("Not theirs");
    expect(await outcome(listPortalContracts(principal(carl)))).toBe("FORBIDDEN");
    expect(await portalContractsShown(principal(carl))).toBe(false);
    expect(await outcome(readPortalContract(principal(bo, beta), id))).toBe("NOT_FOUND");
    expect((await listPortalContracts(principal(bo, beta))).contracts).toEqual([]);
    expect(await portalContractsShown(principal(bo, beta))).toBe(false);
  });
});

describe("signing and declining, under the signer's own principal", () => {
  it("SIGNED: the contract moves, the evidence is the request's, the contact's audit row, the sender told, the signed copy drawn and mailed — once", async () => {
    const id = await sent("To sign");
    const first = await sign(eva, id);
    expect([first.status, first.changed]).toEqual(["SIGNED", true]);

    const contract = await f.platform.contract.findFirstOrThrow({ where: { id }, select: { status: true, signedOn: true, signedPdfFileId: true } });
    expect(contract.status).toBe("SIGNED");
    expect(contract.signedOn).not.toBeNull();
    expect(contract.signedPdfFileId).not.toBeNull();
    const row = await f.platform.contractSignature.findFirstOrThrow({
      where: { contractId: id, party: "CLIENT" },
      select: { status: true, typedName: true, ip: true, userAgent: true, evidence: { select: { ip: true, userAgent: true } } },
    });
    expect(row).toEqual({ status: "SIGNED", typedName: "Eva Ek", ip: null, userAgent: null, evidence: { ip: "198.51.100.9", userAgent: "TestBrowser/1.0" } });

    const audits = (await f.audits("contract.signed")).filter((a) => a.targetId === id);
    expect(audits.map((a) => [a.actorType, a.actorId])).toEqual([["CONTACT", eva]]);
    const told = await f.platform.notification.findMany({ where: { tenantId: f.tenantId, kind: "contract.signed", entityId: id } });
    expect(told.map((n) => [n.receiverId, n.reason])).toEqual([[f.seats.manager.memberId, "REQUESTER"]]);
    const mails = await f.platform.emailOutbox.findMany({ where: { tenantId: f.tenantId, kind: CONTRACT_SIGNED_MAIL, params: { equals: { contractId: id } } } });
    expect(mails.map((m) => [m.receiverId, m.toEmail])).toEqual([[eva, emails[eva]]]);

    // The page: signed by both, the copy ready, nothing left to do.
    const detail = await readPortalContract(principal(eva), id);
    expect(detail).toMatchObject({ status: "SIGNED", waitingForYou: false, canSign: false, signedCopyReady: true });
    expect(detail.signatures.map((s) => s.status)).toEqual(["SIGNED", "SIGNED"]);

    // A second press: the decision that stands, nothing written again.
    const again = await sign(eva, id);
    expect([again.status, again.changed]).toEqual(["SIGNED", false]);
    expect((await f.audits("contract.signed")).filter((a) => a.targetId === id)).toHaveLength(1);
    expect(await f.platform.notification.count({ where: { tenantId: f.tenantId, kind: "contract.signed", entityId: id } })).toBe(1);

    // The sender's inbox names it, linked to its page.
    const inbox = await listInbox(manager(), { filter: "all" });
    expect(inbox.rows.find((r) => r.kind === "contract.signed" && r.subject?.href === `/contracts/${id}`)?.subject?.title).toBe("To sign · Acme AB");
  });

  it("DECLINED with a reason: the contract moves, the reason reaches the colleague and the agency, no signed-copy mail", async () => {
    const id = await sent("To decline");
    expect((await decline(eva, id, "  Too expensive this year. ")).status).toBe("DECLINED");
    expect((await f.platform.contract.findFirstOrThrow({ where: { id }, select: { status: true } })).status).toBe("DECLINED");
    const seen = await readPortalContract(principal(ella), id);
    expect(seen.signatures.find((s) => s.party === "CLIENT")).toMatchObject({ status: "DECLINED", declineReason: "Too expensive this year." });
    expect((await readContract(manager(), id)).signatures.find((s) => s.party === "CLIENT")?.declineReason).toBe("Too expensive this year.");
    const told = await f.platform.notification.findMany({ where: { tenantId: f.tenantId, kind: "contract.declined", entityId: id } });
    expect(told.map((n) => n.receiverId)).toEqual([f.seats.manager.memberId]);
    expect(await f.platform.emailOutbox.count({ where: { tenantId: f.tenantId, kind: CONTRACT_SIGNED_MAIL, params: { equals: { contractId: id } } } })).toBe(0);
    const audits = (await f.audits("contract.declined")).filter((a) => a.targetId === id);
    expect(audits.map((a) => [a.actorType, a.actorId])).toEqual([["CONTACT", eva]]);
  });

  it("only the signer: a colleague and a collaborator are refused, and the contract still waits", async () => {
    const id = await sent("Only Eva");
    expect(await outcome(sign(ella, id, "Ella Eng"))).toBe("NOT_FOUND");
    expect(await outcome(sign(carl, id, "Carl"))).toBe("FORBIDDEN");
    expect(await outcome(decline(ella, id, null))).toBe("NOT_FOUND");
    expect((await f.platform.contract.findFirstOrThrow({ where: { id }, select: { status: true } })).status).toBe("SENT");
  });

  it("a WITHDRAWN contract cannot be signed, is not waiting, and its pending row reads 'not signed'", async () => {
    const id = await sent("Withdrawn one");
    const before = await countPortalContractsToSign(principal(eva));
    await withdrawContract(manager(), id);
    expect(await countPortalContractsToSign(principal(eva))).toBe(before - 1);
    const detail = await readPortalContract(principal(eva), id);
    expect(detail).toMatchObject({ status: "WITHDRAWN", waitingForYou: false, canSign: false });
    expect(detail.signatures.find((s) => s.party === "CLIENT")?.status).toBe("NOT_SIGNED");
    expect(await outcome(sign(eva, id))).toBe("NOT_FOUND");
    // The database's row still says PENDING — which is why every read joins SENT.
    expect((await f.platform.contractSignature.findFirstOrThrow({ where: { contractId: id, party: "CLIENT" }, select: { status: true } })).status).toBe("PENDING");
  });

  it("refuses a signature without the tick or a name, before the database", async () => {
    expect(await outcome(Promise.resolve().then(() => parseContractDecision({ decision: "SIGNED", accepted: false, typedName: "Eva Ek" })))).toBe("INVALID_INPUT");
    expect(await outcome(Promise.resolve().then(() => parseContractDecision({ decision: "SIGNED", accepted: true, typedName: "   " })))).toBe("INVALID_INPUT");
    expect(await outcome(Promise.resolve().then(() => parseContractDecision({ decision: "DECLINED", reason: "x".repeat(1001) })))).toBe("INVALID_INPUT");
    // An id that is not a uuid string — a hand-built request can send an OBJECT,
    // which Prisma would read as a filter over every pending row (both reviews' low).
    const input = parseContractDecision({ decision: "SIGNED", accepted: true, typedName: "Eva Ek" });
    expect(await outcome(decidePortalContract(principal(eva), { not: "" } as unknown as string, input))).toBe("INVALID_INPUT");
    expect(await outcome(decidePortalContract(principal(eva), "", input))).toBe("INVALID_INPUT");
  });
});

describe("waiting for your signature — the home's count and the weekly summary's", () => {
  it("counts the SENT contracts whose pending row is this person's, and nobody else's", async () => {
    const pending = (
      await f.platform.contractSignature.findMany({
        where: { tenantId: f.tenantId, party: "CLIENT", status: "PENDING", signerContactId: eva, contract: { status: "SENT" } },
        select: { id: true },
      })
    ).length;
    expect(pending).toBeGreaterThan(0);
    expect(await countPortalContractsToSign(principal(eva))).toBe(pending);
    expect(await countPortalContractsToSign(principal(ella))).toBe(0);
    const since = new Date(Date.now() - 7 * 24 * 3600_000);
    expect((await countClientSummary(principal(eva), since, new Date()))?.contracts).toBe(pending);
    expect((await countClientSummary(principal(ella), since, new Date()))?.contracts).toBe(0);
    // A collaborator may see no contracts: the area is refused, which counts zero.
    expect((await countClientSummary(principal(carl), since, new Date()))?.contracts).toBe(0);
  });
});
