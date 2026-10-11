import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { DomainError } from "@/lib/domain-error";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";
import { resolvePortalModuleGates, withCensusWrite, withPortalRead, type PortalPrincipal } from "@/portal";
import { LocalDiskTransport, setStorage } from "@/storage";

import { readContract, startContract, updateContractDraft } from "./drafts";
import { ensureContractPdf, makeMissingContractPdfs, readContractPrint } from "./pdf-store";
import { changeSentContract, newContractVersion, sendContract, withdrawContract } from "./send";

/**
 * SENDING AND SIGNING A CONTRACT against the real database and the real
 * app_runtime role (Phase 4 slice 112b; founder decisions C84 (b)–(d), C85;
 * migration 20261012090000):
 *   - the send: bound to the draft as read; the app's refusals (text, fill-ins,
 *     the signer in the portal); the guard WRITES the parties and the
 *     fingerprint and the two signature rows' names, emails and hash;
 *   - the database's guards: no send without `contract:send`, no signature row
 *     outside a send, a sent contract frozen, the PDFs set once;
 *   - THE CENSUS WRITE, under the signer's own principal: their own pending row
 *     signed or declined, the evidence moved to the class-A row, the contract
 *     moved by the definer — and every way it must refuse (another signer, a
 *     collaborator, a paused contact, a second decision, a column not theirs,
 *     a withdrawn contract);
 *   - withdraw, Change it, New version; the PDFs as sent and signed, and the
 *     sweep; the fingerprint's known answer.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let acme: string;
let beta: string;
let eva: string; // acme, main contact, in the portal — the signer
let ella: string; // acme, main contact, in the portal — another
let carl: string; // acme, collaborator, in the portal
let bo: string; // beta, main contact
let gates: Awaited<ReturnType<typeof resolvePortalModuleGates>>;
const storageDir = mkdtempSync(join(tmpdir(), "fortleva-contract-pdf-"));

const ctxOf = (memberId: string) => ({ tenantId: f.tenantId, actor: actorFor(memberId) });
const manager = () => ctxOf(f.seats.manager.memberId);
const employee = () => ctxOf(f.seats.employee.memberId);
const principal = (contactId: string, clientId = acme): PortalPrincipal => ({ contactId, tenantId: f.tenantId, clientId, gates });
const asMember = <T>(memberId: string, fn: (tx: TenantDb) => Promise<T>) => withTenant(f.tenantId, { type: "member", id: memberId }, fn);

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

/** What the DATABASE said — its meta, never the message, whose code frame quotes this file (memory). */
const said = async (p: Promise<unknown>): Promise<string> => {
  try {
    const n = await p;
    return n === 0 ? "0" : "ok";
  } catch (e) {
    const meta = JSON.stringify((e as { meta?: unknown })?.meta ?? "");
    const text = meta.length > 2 ? meta : e instanceof Error ? e.message : String(e);
    const token = /\b((?:CONTRACT|PORTAL)_[A-Z_]+):/.exec(text)?.[1];
    if (token) return token;
    if (/row-level security/.test(text)) return "RLS";
    if (/permission denied/.test(text)) return "DENIED";
    return `unexpected: ${text.slice(0, 400)}`;
  }
};

const doc = (...paras: string[]) => ({
  type: "doc",
  content: paras.map((t) => ({ type: "paragraph", content: [{ type: "text", text: t }] })),
});

/** A draft ready to send: text, the signer, no fill-in. */
async function readyDraft(title = "Web build", signer = eva): Promise<string> {
  const { id } = await startContract(manager(), { clientId: acme, templateId: null, title, signerContactId: signer });
  await updateContractDraft(manager(), id, { body: doc("Scope: a website.", "Price: 10 000 SEK.") });
  return id;
}

const seenOf = async (id: string) => (await readContract(manager(), id)).updatedAt.toISOString();

async function sent(title?: string): Promise<string> {
  const id = await readyDraft(title);
  await sendContract(manager(), id, { seen: await seenOf(id), typedName: "Maja Manager" });
  return id;
}

/** The signer decides their own row, under their own principal — the census write. */
const decide = (contactId: string, contractId: string, set: { status: "SIGNED" | "DECLINED"; typedName?: string; reason?: string }, clientId = acme) =>
  withCensusWrite(principal(contactId, clientId), (tx) =>
    tx.$executeRaw`
      UPDATE contract_signature
         SET status = ${set.status}::signature_status,
             typed_name = ${set.typedName ?? null},
             decline_reason = ${set.reason ?? null},
             decided_at = now(),
             ip = '203.0.113.7',
             user_agent = 'Mozilla/5.0 (test)'
       WHERE contract_id = ${contractId} AND party = 'CLIENT'`,
  );

beforeAll(async () => {
  f = await setupTenant("sigs");
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
  const contact = (id: string, clientId: string, name: string, profile: "CONTACT_PRIMARY" | "CONTACT_COLLABORATOR") => ({
    id,
    tenantId: f.tenantId,
    clientId,
    name,
    email: `sigs-${name.toLowerCase().replace(/\s+/g, "")}-${run}@test.invalid`,
    portalProfile: profile,
    portalStatus: "ACTIVE" as const,
    invitedAt,
    emailVerified: true,
  });
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
    data: { legalName: "Sigs Konsult AB", orgNr: "556016-0680", addressLine1: "Kungsgatan 2", postalCode: "411 19", city: "Göteborg", countryCode: "SE" },
  });
}, 180_000);

afterAll(async () => {
  setStorage(null);
  if (!f) return;
  await f.deleteInvoices(); // contracts, their signatures and PDFs too (slice 112)
  // Since slice 112b2 a send queues the signer's mail (and the store's audit
  // rows go with the tenant): the outbox RESTRICTs the tenant.
  await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.notification.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.contact.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.client.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.tenantKey.deleteMany({ where: { tenantId: f.tenantId } });
  await f.cleanup();
}, 180_000);

describe("the fingerprint", () => {
  it("is Postgres's canonical text, hashed — a known answer, so an upgrade that changes jsonb's text fails here", async () => {
    const rows = await f.platform.$queryRaw<{ text: string; hash: string }[]>`
      SELECT jsonb_build_object('b', 'x', 'a', 1, 'c', jsonb_build_object('z', NULL, 'y', true))::text AS text,
             encode(sha256(convert_to(jsonb_build_object('b', 'x', 'a', 1, 'c', jsonb_build_object('z', NULL, 'y', true))::text, 'UTF8')), 'hex') AS hash`;
    const expected = '{"a": 1, "b": "x", "c": {"y": true, "z": null}}';
    expect(rows[0]!.text).toBe(expected);
    expect(rows[0]!.hash).toBe(createHash("sha256").update(expected, "utf8").digest("hex"));
  });
});

describe("sending (C84 (b)–(d))", () => {
  it("freezes the parties and the fingerprint, and writes both signatures from the record", async () => {
    const id = await sent("Frozen");
    const c = await readContract(manager(), id);
    expect(c.status).toBe("SENT");
    expect(c.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    const row = await f.platform.contract.findFirstOrThrow({ where: { id }, select: { parties: true, sentByMemberId: true } });
    expect(row.sentByMemberId).toBe(f.seats.manager.memberId);
    expect(row.parties).toEqual({
      agency: { name: "Sigs Konsult AB", orgNr: "556016-0680", addressLine1: "Kungsgatan 2", addressLine2: null, postalCode: "411 19", city: "Göteborg", countryCode: "SE" },
      client: { name: "Acme AB", orgNr: "556677-8899", addressLine1: "Storgatan 1", addressLine2: null, postalCode: "111 22", city: "Stockholm", countryCode: "SE" },
    });
    const sigs = await f.platform.contractSignature.findMany({ where: { contractId: id }, orderBy: { party: "asc" } });
    expect(sigs.map((s) => [s.party, s.status])).toEqual([
      ["TENANT", "SIGNED"],
      ["CLIENT", "PENDING"],
    ]);
    // Names and addresses from the record — never the app's placeholders.
    expect(sigs[0]!.typedName).toBe("Maja Manager");
    expect(sigs[0]!.signerName).not.toBe("-");
    // Never the sender's login email (C85 (e), slice 112b2): this workspace has
    // confirmed no reply address, so the agency's row carries none.
    expect(sigs[0]!.signerEmail).toBeNull();
    expect(sigs[1]!.signerName).toBe("Eva Ek");
    expect(sigs[1]!.signerEmail).toMatch(/@test\.invalid$/);
    for (const s of sigs) expect(s.contentSha256).toBe(c.contentSha256);
    const audit = (await f.audits("contract.sent")).filter((a) => a.targetId === id);
    expect(audit).toHaveLength(1);
  });

  it("refuses a draft changed since it was read, text left to fill, a signer who cannot sign, and a member without the code", async () => {
    const id = await readyDraft("Refusals");
    const seen = await seenOf(id);
    await updateContractDraft(manager(), id, { title: "Refusals, edited" });
    expect(await outcome(sendContract(manager(), id, { seen, typedName: "M" }))).toBe("CONTRACT_CHANGED");
    await updateContractDraft(manager(), id, { body: doc("Price: {{client_org_nr}}") });
    expect(await outcome(sendContract(manager(), id, { seen: await seenOf(id), typedName: "M" }))).toBe("CONTRACT_FILL_INS_LEFT");
    await updateContractDraft(manager(), id, { body: doc("Fine.") });
    expect(await outcome(sendContract(employee(), id, { seen: await seenOf(id), typedName: "E" }))).toBe("FORBIDDEN");
    expect(await outcome(sendContract(manager(), id, { seen: await seenOf(id), typedName: "  " }))).toBe("INVALID_INPUT");
    // A signer who stops being a main contact between the draft and the send.
    const other = await readyDraft("Ella's", ella);
    await f.platform.contact.update({ where: { id: ella }, data: { portalProfile: "CONTACT_COLLABORATOR" } });
    try {
      expect(await outcome(sendContract(manager(), other, { seen: await seenOf(other), typedName: "M" }))).toBe("CONTRACT_SIGNER_INVALID");
    } finally {
      await f.platform.contact.update({ where: { id: ella }, data: { portalProfile: "CONTACT_PRIMARY" } });
    }
  });

  it("the database refuses a send by a member without contract:send, a signature outside a send, and any change to a sent contract", async () => {
    const draft = await readyDraft("Raw");
    expect(
      await said(asMember(f.seats.employee.memberId, (tx) => tx.$executeRaw`UPDATE contract SET status = 'SENT', sent_at = now(), sent_by_member_id = ${f.seats.employee.memberId} WHERE id = ${draft}`)),
    ).toBe("CONTRACT_GUARD");
    const id = await sent("Frozen raw");
    expect(
      await said(
        asMember(f.seats.manager.memberId, (tx) =>
          tx.contractSignature.create({
            data: { id: randomUUID(), tenantId: f.tenantId, clientId: acme, contractId: id, party: "CLIENT", signerContactId: ella, signerName: "x", signerEmail: "x", contentSha256: "0".repeat(64) },
          }),
        ),
      ),
    ).toBe("CONTRACT_SIGNATURE_GUARD");
    expect(await said(asMember(f.seats.manager.memberId, (tx) => tx.$executeRaw`UPDATE contract SET title = 'Changed' WHERE id = ${id}`))).toBe("CONTRACT_NOT_DRAFT");
    expect(await said(asMember(f.seats.manager.memberId, (tx) => tx.$executeRaw`UPDATE contract_signature SET typed_name = 'Forged' WHERE contract_id = ${id} AND party = 'TENANT'`))).toBe(
      "CONTRACT_SIGNATURE_GUARD",
    );
    // No DELETE grant at all: the database refuses before any trigger.
    expect(await said(asMember(f.seats.manager.memberId, (tx) => tx.$executeRaw`DELETE FROM contract_signature WHERE contract_id = ${id}`))).toBe("DENIED");
  });
});

describe("the client signs — a census write under their own principal", () => {
  it("signs their own row: the contract SIGNED, the evidence moved to the class-A row, nothing left on theirs", async () => {
    const id = await sent("To sign");
    expect(await decide(eva, id, { status: "SIGNED", typedName: "Eva Ek" })).toBe(1);
    const c = await readContract(manager(), id);
    expect(c.status).toBe("SIGNED");
    expect(c.signedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const sig = await f.platform.contractSignature.findFirstOrThrow({ where: { contractId: id, party: "CLIENT" }, include: { evidence: true } });
    expect([sig.status, sig.typedName, sig.ip, sig.userAgent]).toEqual(["SIGNED", "Eva Ek", null, null]);
    expect([sig.evidence?.ip, sig.evidence?.userAgent]).toEqual(["203.0.113.7", "Mozilla/5.0 (test)"]);
    // The signer reads both signature rows, never the evidence.
    expect(await withPortalRead(principal(eva), (tx) => tx.contractSignature.count({ where: { contractId: id } }))).toBe(2);
    expect(await withPortalRead(principal(eva), (tx) => tx.contractSignatureEvidence.count())).toBe(0);
  });

  it("refuses another signer's row, a collaborator, another client, a second decision and a column not theirs", async () => {
    const id = await sent("Not theirs");
    // Ella is a main contact of the same client and SEES the row, but she is not
    // its signer: the guard refuses her.
    expect(await said(decide(ella, id, { status: "SIGNED", typedName: "Ella Eng" }))).toBe("CONTRACT_SIGNATURE_GUARD");
    // A collaborator reads no signature row at all; another client's contact none either.
    expect(await decide(carl, id, { status: "SIGNED", typedName: "Carl" })).toBe(0);
    expect(await decide(bo, id, { status: "SIGNED", typedName: "Bo" }, beta)).toBe(0);
    expect(
      await said(
        withCensusWrite(principal(eva), (tx) =>
          tx.$executeRaw`UPDATE contract_signature SET status = 'SIGNED', typed_name = 'Eva Ek', decided_at = now(), signer_name = 'Someone'
                          WHERE contract_id = ${id} AND party = 'CLIENT'`,
        ),
      ),
    ).toBe("PORTAL_COLUMNS");
    expect(await decide(eva, id, { status: "SIGNED", typedName: "Eva Ek" })).toBe(1);
    expect(await said(decide(eva, id, { status: "DECLINED", reason: "Changed my mind" }))).toBe("CONTRACT_SIGNATURE_GUARD");
    expect((await readContract(manager(), id)).status).toBe("SIGNED");
  });

  it("refuses a paused signer, and a contract withdrawn before they signed", async () => {
    const paused = await sent("Paused");
    await f.platform.contact.update({ where: { id: eva }, data: { portalStatus: "SUSPENDED" } });
    try {
      expect(await said(decide(eva, paused, { status: "SIGNED", typedName: "Eva Ek" }))).toBe("RLS");
    } finally {
      await f.platform.contact.update({ where: { id: eva }, data: { portalStatus: "ACTIVE" } });
    }
    const id = await sent("Withdrawn first");
    await withdrawContract(manager(), id);
    expect(await said(decide(eva, id, { status: "SIGNED", typedName: "Eva Ek" }))).toBe("CONTRACT_NOT_OPEN");
    expect((await readContract(manager(), id)).status).toBe("WITHDRAWN");
  });

  it("declines with a reason; the contract DECLINED, and a new version follows once", async () => {
    const id = await sent("Declined");
    expect(await decide(eva, id, { status: "DECLINED", reason: "The price is too high." })).toBe(1);
    const c = await readContract(manager(), id);
    expect(c.status).toBe("DECLINED");
    expect(c.signatures.find((s) => s.party === "CLIENT")?.declineReason).toBe("The price is too high.");
    const { id: v2 } = await newContractVersion(manager(), id);
    const next = await readContract(manager(), v2);
    expect([next.status, next.version, next.supersedes?.id, next.title]).toEqual(["DRAFT", 2, id, "Declined"]);
    expect(await outcome(newContractVersion(manager(), id))).toBe("CONTRACT_NOT_REPLACEABLE");
  });
});

describe("the contract's move is the definer's alone", () => {
  it("neither a member nor a contact can imitate it with the marker", async () => {
    const id = await sent("Forged");
    expect(
      await said(
        asMember(f.seats.manager.memberId, async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.contract_decided', ${id}, true)`;
          return tx.$executeRaw`UPDATE contract SET status = 'SIGNED', signed_on = current_date WHERE id = ${id}`;
        }),
      ),
    ).toBe("CONTRACT_NOT_OPEN");
    expect(
      await said(
        withCensusWrite(principal(eva), async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.contract_decided', ${id}, true)`;
          return tx.$executeRaw`UPDATE contract SET status = 'SIGNED', signed_on = current_date WHERE id = ${id}`;
        }),
      ),
    ).toMatch(/^(CONTRACT_GUARD|RLS|0)$/);
    expect((await readContract(manager(), id)).status).toBe("SENT");
  });
});

describe("withdraw and Change it", () => {
  it("withdraws a sent contract once; Change it withdraws and copies at once", async () => {
    const id = await sent("To withdraw");
    await withdrawContract(manager(), id);
    expect(await outcome(withdrawContract(manager(), id))).toBe("CONTRACT_NOT_OPEN");
    expect((await f.audits("contract.withdrawn")).some((a) => a.targetId === id)).toBe(true);
    const other = await sent("To change");
    const { id: copy } = await changeSentContract(manager(), other);
    expect((await readContract(manager(), other)).status).toBe("WITHDRAWN");
    const draft = await readContract(manager(), copy);
    expect([draft.status, draft.version, draft.signerContactId]).toEqual(["DRAFT", 2, eva]);
    expect(await outcome(changeSentContract(employee(), copy))).toBe("FORBIDDEN");
  });
});

describe("the PDFs", () => {
  it("draws the PDF as sent once, the signed copy once signed, and refuses a signed copy before", async () => {
    const id = await sent("PDFs");
    const first = await ensureContractPdf(manager(), id, "sent");
    expect(first.created).toBe(true);
    expect((await ensureContractPdf(manager(), id, "sent")).fileObjectId).toBe(first.fileObjectId);
    expect(await outcome(ensureContractPdf(manager(), id, "signed"))).toBe("CONTRACT_NOT_READY");
    await decide(eva, id, { status: "SIGNED", typedName: "Eva Ek" });
    const print = await withTenant(f.tenantId, { type: "system" }, (tx) => readContractPrint(tx, f.tenantId, id, "signed"));
    expect(print?.signed?.signatures.map((s) => [s.party, s.typedName])).toEqual([
      ["TENANT", "Maja Manager"],
      ["CLIENT", "Eva Ek"],
    ]);
    const signed = await ensureContractPdf(manager(), id, "signed");
    expect(signed.fileName).toBe("pdfs-v1-signed.pdf");
    const files = await f.platform.fileObject.findMany({ where: { tenantId: f.tenantId, id: { in: [first.fileObjectId, signed.fileObjectId] } }, select: { kind: true, status: true } });
    expect(files.every((x) => x.kind === "CONTRACT_PDF" && x.status === "COMMITTED")).toBe(true);
    // A PDF is set once: the database refuses a second.
    expect(await said(asMember(f.seats.manager.memberId, (tx) => tx.$executeRaw`UPDATE contract SET pdf_file_id = ${signed.fileObjectId} WHERE id = ${id}`))).toBe("CONTRACT_GUARD");
  }, 60_000);

  it("the sweep makes what was missed, as the system", async () => {
    const id = await sent("Swept");
    const r = await makeMissingContractPdfs(f.tenantId, new Date(Date.now() + 10 * 60_000));
    expect(r.failed).toBe(0);
    expect(r.made).toBeGreaterThanOrEqual(1);
    expect((await readContract(manager(), id)).hasPdf).toBe(true);
  }, 60_000);
});
