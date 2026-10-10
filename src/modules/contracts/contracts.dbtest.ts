import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { DomainError } from "@/lib/domain-error";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";
import { resolvePortalModuleGates, withPortalRead, type PortalPrincipal } from "@/portal";

import {
  deleteContractDraft,
  listContracts,
  listContractSigners,
  readContract,
  startContract,
  updateContractDraft,
} from "./drafts";
import { contractPreviewPdf } from "./preview";
import {
  createContractTemplate,
  deleteContractTemplate,
  listContractTemplates,
  readContractTemplate,
  updateContractTemplate,
} from "./templates";

/**
 * CONTRACT TEMPLATES AND DRAFTS against the real database and the real
 * app_runtime role (Phase 4 slice 112; founder decision C84; migration
 * 20261011120000):
 *   - the house recipe on every verb: the `contract:*` codes on all four gates,
 *     the client's scope, the write, its audit row;
 *   - starting a contract: the template's body copied, its fill-ins filled
 *     ONCE (the client's card, the workspace's company, the signer, today),
 *     the missing ones left and reported; the language the client's;
 *   - the signer: a MAIN contact of THIS client whose portal access is ACTIVE;
 *   - the DATABASE'S GUARDS, whatever the app does: templates written only by a
 *     holder of `contract:manage_templates` as themselves; a contract started
 *     only as a written draft by a holder of `contract:create`; only a draft's
 *     seven fields change, by a holder of `contract:edit`; NO status move in
 *     this slice; a draft deleted only by a holder of `contract:delete`; a
 *     contact writes nothing and reads no draft;
 *   - a second workspace sees none of it (behaviour, beside the posture suite).
 *
 * THE TEMPLATE TESTS need `contract:manage_templates` in the permission
 * catalogue (TEMPLATE_VERSION 16), which `prisma/seed.ts` writes. CI seeds an
 * empty database before this suite, so there they always run — and the suite
 * FAILS, never skips, if the code is missing in CI. On a dev database not yet
 * seeded they are skipped, named as such.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let other: Awaited<ReturnType<typeof setupTenant>>;
let acme: string;
let beta: string;
let eva: string; // acme, main contact, in the portal
let carl: string; // acme, collaborator, in the portal
let ivy: string; // acme, main contact, invited only
let bo: string; // beta, main contact, in the portal
let gates: Awaited<ReturnType<typeof resolvePortalModuleGates>>;
let hasTemplateCode = false;

const ctxOf = (memberId: string, tenantId = f.tenantId) => ({ tenantId, actor: actorFor(memberId) });
const owner = () => ctxOf(f.seats.owner.memberId);
const admin = () => ctxOf(f.seats.admin.memberId);
const manager = () => ctxOf(f.seats.manager.memberId);
const employee = () => ctxOf(f.seats.employee.memberId);
const principal = (contactId: string, clientId = acme): PortalPrincipal => ({ contactId, tenantId: f.tenantId, clientId, gates });

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
  "CONTRACT_TEMPLATE_GUARD",
  "CONTRACT_NOT_DRAFT",
  "CONTRACT_SIGNER_INVALID",
  "CONTRACT_GUARD",
  "contract_template_name_key",
  "contract_draft_bare",
  "contract_title",
  "contract_language",
  "row-level security",
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

const doc = (...paras: string[]) => ({
  type: "doc",
  content: paras.map((t) => ({ type: "paragraph", content: [{ type: "text", text: t }] })),
});

/** The plain text of a stored body. */
const textOf = (node: unknown): string => {
  if (node === null || typeof node !== "object") return "";
  const n = node as { text?: unknown; content?: unknown };
  if (typeof n.text === "string") return n.text;
  return Array.isArray(n.content) ? n.content.map(textOf).join("\n") : "";
};

/** A draft started blank by the manager — the guard tests' subject. */
const blankDraft = async (clientId = acme) => (await startContract(manager(), { clientId, templateId: null, title: "Blank", signerContactId: null })).id;

beforeAll(async () => {
  f = await setupTenant("cntr");
  other = await setupTenant("cntr");
  hasTemplateCode = (await f.platform.permission.count({ where: { code: "contract:manage_templates" } })) === 1;
  if (process.env["CI"] && !hasTemplateCode) {
    throw new Error("contract:manage_templates is not in the catalogue — CI must seed it (prisma/seed.ts) before test:db");
  }
  gates = await resolvePortalModuleGates(f.tenantId);
  const run = randomUUID().slice(0, 8);
  acme = randomUUID();
  beta = randomUUID();
  eva = randomUUID();
  carl = randomUUID();
  ivy = randomUUID();
  bo = randomUUID();
  await f.platform.client.createMany({
    data: [
      { id: acme, tenantId: f.tenantId, name: "Acme AB", addressLine1: "Storgatan 1", postalCode: "111 22", city: "Stockholm", countryCode: "SE", invoiceLocale: "en" },
      { id: beta, tenantId: f.tenantId, name: "Beta AB", orgNr: "556000-1111" },
    ],
  });
  const invitedAt = new Date("2026-09-01T09:00:00Z");
  await f.platform.contact.createMany({
    data: [
      { id: eva, tenantId: f.tenantId, clientId: acme, name: "Eva Ek", email: `cntr-eva-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "ACTIVE", invitedAt, emailVerified: true },
      { id: carl, tenantId: f.tenantId, clientId: acme, name: "Carl", email: `cntr-carl-${run}@test.invalid`, portalProfile: "CONTACT_COLLABORATOR", portalStatus: "ACTIVE", invitedAt, emailVerified: true },
      { id: ivy, tenantId: f.tenantId, clientId: acme, name: "Ivy", email: `cntr-ivy-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "INVITED", invitedAt },
      { id: bo, tenantId: f.tenantId, clientId: beta, name: "Bo", email: `cntr-bo-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "ACTIVE", invitedAt, emailVerified: true },
    ],
  });
  await f.platform.tenant.update({
    where: { id: f.tenantId },
    data: { legalName: "Cntr Konsult AB", orgNr: "556016-0680", addressLine1: "Kungsgatan 2", postalCode: "411 19", city: "Göteborg", countryCode: "SE" },
  });
}, 180_000);

afterAll(async () => {
  for (const t of [f, other]) {
    if (!t) continue;
    await t.deleteInvoices(); // contracts and templates too, under their GUC (slice 112)
    await t.platform.contact.deleteMany({ where: { tenantId: t.tenantId } });
    await t.platform.client.deleteMany({ where: { tenantId: t.tenantId } });
    await t.platform.tenantPreference.deleteMany({ where: { tenantId: t.tenantId } });
    await t.platform.tenantKey.deleteMany({ where: { tenantId: t.tenantId } });
    await t.cleanup();
  }
}, 180_000);

describe("templates — kept by owners and admins (C84 (g))", () => {
  it("an owner creates one, an admin changes it, a manager reads the list but cannot write", async ({ skip }) => {
    if (!hasTemplateCode) skip();
    const made = await createContractTemplate(owner(), { name: "Web build", body: doc("Between {{agency_name}} and {{client_name}}.") });
    expect(made.splitFillIns).toEqual([]);
    expect((await updateContractTemplate(admin(), made.id, { name: "Web build v2" })).name).toBe("Web build v2");
    expect((await listContractTemplates(manager())).map((r) => r.name)).toContain("Web build v2");
    expect(await outcome(createContractTemplate(manager(), { name: "Mine", body: null }))).toBe("FORBIDDEN");
    expect(await outcome(updateContractTemplate(manager(), made.id, { name: "Mine" }))).toBe("FORBIDDEN");
    expect(await outcome(readContractTemplate(manager(), made.id))).toBe("FORBIDDEN");
    expect(await outcome(listContractTemplates(employee()))).toBe("FORBIDDEN");
    expect((await f.audits("contract_template.created")).some((r) => r.targetId === made.id)).toBe(true);
    const updated = (await f.audits("contract_template.updated")).filter((r) => r.targetId === made.id);
    expect(updated).toHaveLength(1);
    expect(updated[0]!.actorId).toBe(f.seats.admin.memberId);
  });

  it("refuses a name already used, whatever its case, and writes nothing for an unchanged save", async ({ skip }) => {
    if (!hasTemplateCode) skip();
    const a = await createContractTemplate(owner(), { name: "Retainer", body: null });
    expect(await outcome(createContractTemplate(owner(), { name: "retainer", body: null }))).toBe("CONTRACT_TEMPLATE_NAME_TAKEN");
    expect(await outcome(createContractTemplate(owner(), { name: "   ", body: null }))).toBe("INVALID_INPUT");
    const before = (await f.audits("contract_template.updated")).length;
    await updateContractTemplate(owner(), a.id, { name: "Retainer", body: null });
    expect((await f.audits("contract_template.updated")).length).toBe(before);
    // The body's change is Postgres's to decide: the same document, re-sent, changes nothing.
    await updateContractTemplate(owner(), a.id, { body: doc("Same") });
    await updateContractTemplate(owner(), a.id, { body: doc("Same") });
    expect((await f.audits("contract_template.updated")).length).toBe(before + 1);
  });

  it("names a fill-in split by formatting on save", async ({ skip }) => {
    if (!hasTemplateCode) skip();
    const split = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "{{client_" }, { type: "text", text: "name}}", marks: [{ type: "bold" }] }] }],
    };
    const saved = await createContractTemplate(owner(), { name: "Split", body: split });
    expect(saved.splitFillIns).toEqual(["client_name"]);
  });

  it("is deleted by its keepers; contracts started from it keep their text", async ({ skip }) => {
    if (!hasTemplateCode) skip();
    const tpl = await createContractTemplate(owner(), { name: "Short-lived", body: doc("Kept: {{client_name}}") });
    const { id } = await startContract(manager(), { clientId: acme, templateId: tpl.id, title: "", signerContactId: null });
    await deleteContractTemplate(admin(), tpl.id);
    expect(textOf((await readContract(manager(), id)).body)).toBe("Kept: Acme AB");
    expect((await readContract(manager(), id)).templateName).toBeNull();
    expect((await f.audits("contract_template.deleted")).some((r) => r.targetId === tpl.id)).toBe(true);
  });

  it("the database refuses a template written by anyone but a keeper, as themselves", async ({ skip }) => {
    if (!hasTemplateCode) skip();
    const mgr = f.seats.manager.memberId;
    const own = f.seats.owner.memberId;
    expect(
      await refusal(
        asMember(mgr, (tx) =>
          tx.contractTemplate.create({ data: { tenantId: f.tenantId, name: `Raw ${randomUUID()}`, createdByMemberId: mgr, updatedByMemberId: mgr } }),
        ),
      ),
    ).toBe("CONTRACT_TEMPLATE_GUARD");
    // As someone else: the owner writing a row attributed to the admin.
    expect(
      await refusal(
        asMember(own, (tx) =>
          tx.contractTemplate.create({
            data: { tenantId: f.tenantId, name: `Raw ${randomUUID()}`, createdByMemberId: f.seats.admin.memberId, updatedByMemberId: own },
          }),
        ),
      ),
    ).toBe("CONTRACT_TEMPLATE_GUARD");
    // The SYSTEM principal keeps none.
    expect(
      await refusal(
        withTenant(f.tenantId, { type: "system" }, (tx) =>
          tx.contractTemplate.create({ data: { tenantId: f.tenantId, name: `Raw ${randomUUID()}`, createdByMemberId: own, updatedByMemberId: own } }),
        ),
      ),
    ).toBe("CONTRACT_TEMPLATE_GUARD");
  });
});

describe("starting a contract (C84 (a), (e))", () => {
  it("fills a template's fill-ins once, keeps the missing ones, and takes the client's language", async ({ skip }) => {
    if (!hasTemplateCode) skip();
    const tpl = await createContractTemplate(owner(), {
      name: "Full",
      body: doc(
        "{{agency_name}} ({{agency_org_nr}}), {{agency_address}}",
        "{{client_name}} ({{client_org_nr}}), {{client_address}}",
        "Signed for the client by {{signer_name}} on {{today}}. {{price}} stays.",
      ),
    });
    const { id } = await startContract(manager(), { clientId: acme, templateId: tpl.id, title: "", signerContactId: eva });
    const c = await readContract(manager(), id);
    const lines = textOf(c.body).split("\n");
    expect(lines[0]).toBe("Cntr Konsult AB (556016-0680), Kungsgatan 2, 411 19 Göteborg");
    // Acme has no org number: its token stays, and is reported.
    expect(lines[1]).toBe("Acme AB ({{client_org_nr}}), Storgatan 1, 111 22 Stockholm");
    expect(lines[2]).toMatch(/^Signed for the client by Eva Ek on \d{1,2} [A-Z][a-z]+ \d{4}\. \{\{price\}\} stays\.$/);
    expect(c.remainingFillIns).toEqual(["client_org_nr"]);
    expect(c.title).toBe("Full");
    expect(c.language).toBe("en"); // the client's invoice language
    expect(c.status).toBe("DRAFT");
    expect(c.version).toBe(1);
    expect(c.signer).toEqual({ id: eva, name: "Eva Ek", canSign: true });
    expect(c.templateName).toBe("Full");
    const created = (await f.audits("contract.created")).filter((r) => r.targetId === id);
    expect(created).toHaveLength(1);
    expect(created[0]!.actorId).toBe(f.seats.manager.memberId);
  });

  it("starts blank, in the workspace's language when the client has none", async () => {
    const { id } = await startContract(manager(), { clientId: beta, templateId: null, title: "  Blank one  ", signerContactId: null });
    const c = await readContract(manager(), id);
    expect(c.title).toBe("Blank one");
    expect(c.body).toBeNull();
    expect(c.language).toBe("sv");
    expect(await outcome(startContract(manager(), { clientId: beta, templateId: null, title: "", signerContactId: null }))).toBe("INVALID_INPUT");
  });

  it("a signer is a main contact of THIS client with portal access", async () => {
    expect((await listContractSigners(manager(), acme)).map((s) => s.id)).toEqual([eva]);
    for (const wrong of [carl, ivy, bo]) {
      expect(await outcome(startContract(manager(), { clientId: acme, templateId: null, title: "S", signerContactId: wrong }))).toBe("CONTRACT_SIGNER_INVALID");
    }
  });

  it("is refused to a member without contract:create, and lists to no one without contract:view", async () => {
    expect(await outcome(startContract(employee(), { clientId: acme, templateId: null, title: "E", signerContactId: null }))).toBe("FORBIDDEN");
    expect(await outcome(listContracts(employee()))).toBe("FORBIDDEN");
    expect(await outcome(readContract(employee(), await blankDraft()))).toBe("FORBIDDEN");
  });
});

describe("editing a draft", () => {
  it("writes and audits only what changed", async () => {
    const id = await blankDraft();
    const r = await updateContractDraft(manager(), id, {
      title: "Webbutveckling",
      body: doc("Ett: {{client_org_nr}}"),
      language: "sv", // acme's drafts start in English (its invoice language)
      signerContactId: eva,
      startsOn: "2026-11-01",
      endsOn: "2027-10-31",
    });
    expect(r.remainingFillIns).toEqual(["client_org_nr"]);
    const c = await readContract(manager(), id);
    expect([c.title, c.language, c.signerContactId, c.startsOn, c.endsOn]).toEqual(["Webbutveckling", "sv", eva, "2026-11-01", "2027-10-31"]);
    const edited = (await f.audits("contract.draft_edited")).filter((a) => a.targetId === id);
    expect(edited).toHaveLength(1);
    expect((edited[0]!.metadata as { fields: string[] }).fields.sort()).toEqual(["body", "endsOn", "language", "signerContactId", "startsOn", "title"]);
    // The same again changes nothing and writes no row.
    await updateContractDraft(manager(), id, { title: "Webbutveckling", body: doc("Ett: {{client_org_nr}}"), endsOn: "2027-10-31" });
    expect((await f.audits("contract.draft_edited")).filter((a) => a.targetId === id)).toHaveLength(1);
  });

  it("refuses an end before the start, a bad day, a signer who may not sign, and a member without contract:edit", async () => {
    const id = await blankDraft();
    expect(await outcome(updateContractDraft(manager(), id, { startsOn: "2026-12-01", endsOn: "2026-11-01" }))).toBe("INVALID_INPUT");
    expect(await outcome(updateContractDraft(manager(), id, { startsOn: "2026-02-30" }))).toBe("INVALID_INPUT");
    expect(await outcome(updateContractDraft(manager(), id, { signerContactId: carl }))).toBe("CONTRACT_SIGNER_INVALID");
    expect(await outcome(updateContractDraft(employee(), id, { title: "No" }))).toBe("FORBIDDEN");
    expect(await outcome(updateContractDraft(manager(), id, { body: { type: "doc", content: [{ type: "codeBlock", content: [{ type: "text", text: "x" }] }] } }))).toBe("INVALID_INPUT");
  });

  it("is deleted by a holder of contract:delete only", async () => {
    const id = await blankDraft();
    // Admins do not hold contract:delete (catalog: owners and managers).
    expect(await outcome(deleteContractDraft(admin(), id))).toBe("FORBIDDEN");
    await deleteContractDraft(manager(), id);
    expect(await outcome(readContract(manager(), id))).toBe("NOT_FOUND");
    expect((await f.audits("contract.draft_deleted")).some((a) => a.targetId === id)).toBe(true);
  });

  it("draws a draft's preview PDF for contract:view only", async () => {
    const id = await blankDraft();
    await updateContractDraft(manager(), id, { body: doc("Första stycket.", "Andra stycket — Åsa Öberg.") });
    const pdf = await contractPreviewPdf(manager(), id);
    expect(Buffer.from(pdf.bytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
    expect(pdf.fileName).toBe("blank-v1.pdf");
    expect(await outcome(contractPreviewPdf(employee(), id))).toBe("FORBIDDEN");
  }, 60_000);
});

describe("the database's guards on contract (migration 20261011120000)", () => {
  it("starts only a written draft, version 1, by a holder of contract:create as themselves", async () => {
    const mgr = f.seats.manager.memberId;
    const base = { tenantId: f.tenantId, clientId: acme, title: "Raw", language: "sv" };
    expect(await refusal(asMember(mgr, (tx) => tx.contract.create({ data: { ...base, createdByMemberId: f.seats.owner.memberId } })))).toBe("CONTRACT_GUARD");
    expect(await refusal(asMember(f.seats.employee.memberId, (tx) => tx.contract.create({ data: { ...base, createdByMemberId: f.seats.employee.memberId } })))).toBe(
      "CONTRACT_GUARD",
    );
    expect(await refusal(asMember(mgr, (tx) => tx.contract.create({ data: { ...base, createdByMemberId: mgr, status: "SENT" } })))).toBe("CONTRACT_GUARD");
    expect(await refusal(asMember(mgr, (tx) => tx.contract.create({ data: { ...base, createdByMemberId: mgr, signerContactId: bo } })))).toBe(
      "CONTRACT_SIGNER_INVALID",
    );
    expect(await refusal(asMember(mgr, (tx) => tx.contract.create({ data: { ...base, createdByMemberId: mgr, language: "de" } })))).toBe("contract_language");
    expect(await refusal(asMember(mgr, (tx) => tx.contract.create({ data: { ...base, createdByMemberId: mgr, title: " padded " } })))).toBe("contract_title");
  });

  it("moves no status in this slice and freezes everything but a draft's seven fields", async () => {
    const id = await blankDraft();
    const mgr = f.seats.manager.memberId;
    expect(await refusal(asMember(mgr, (tx) => tx.$executeRaw`UPDATE contract SET status = 'WITHDRAWN', withdrawn_at = now(), withdrawn_by_member_id = ${mgr} WHERE id = ${id}`))).toBe(
      "CONTRACT_GUARD",
    );
    expect(await refusal(asMember(mgr, (tx) => tx.$executeRaw`UPDATE contract SET created_by_member_id = ${f.seats.owner.memberId} WHERE id = ${id}`))).toBe("CONTRACT_GUARD");
    expect(await refusal(asMember(mgr, (tx) => tx.$executeRaw`UPDATE contract SET template_id = ${randomUUID()} WHERE id = ${id}`))).toBe("CONTRACT_GUARD");
    expect(await refusal(asMember(mgr, (tx) => tx.$executeRaw`UPDATE contract SET signer_contact_id = ${bo} WHERE id = ${id}`))).toBe("CONTRACT_SIGNER_INVALID");
    // RLS shows a member every row of the workspace; the guard is what refuses one without the code.
    expect(await refusal(asMember(f.seats.employee.memberId, (tx) => tx.$executeRaw`UPDATE contract SET title = 'E' WHERE id = ${id}`))).toBe("CONTRACT_GUARD");
  });

  it("refuses an edit by a member without contract:edit and a delete by one without contract:delete", async () => {
    const id = await blankDraft();
    expect(await refusal(asMember(f.seats.employee.memberId, (tx) => tx.contract.update({ where: { id }, data: { title: "E" }, select: { id: true } })))).toBe(
      "CONTRACT_GUARD",
    );
    expect(await refusal(asMember(f.seats.admin.memberId, (tx) => tx.contract.delete({ where: { id }, select: { id: true } })))).toBe("CONTRACT_GUARD");
    expect(await refusal(asMember(f.seats.manager.memberId, (tx) => tx.contract.delete({ where: { id }, select: { id: true } })))).toBe("ok");
  });

  it("a contact reads no draft and writes nothing", async () => {
    const id = await blankDraft();
    expect(await withPortalRead(principal(eva), (tx) => tx.contract.count())).toBe(0);
    expect(await withPortalRead(principal(eva), (tx) => tx.contractTemplate.count())).toBe(0);
    // Whether the read transaction refuses the statement or the gate hides the
    // row (zero rows), nothing is written.
    const wrote = await withPortalRead(principal(eva), (tx) => tx.$executeRaw`UPDATE contract SET title = 'Contact' WHERE id = ${id}`).catch(() => 0);
    expect(wrote).toBe(0);
    expect((await readContract(manager(), id)).title).toBe("Blank");
  });
});

describe("another workspace sees none of it", () => {
  it("lists, reads and edits nothing of this workspace's contracts", async () => {
    const id = await blankDraft();
    const stranger = ctxOf(other.seats.owner.memberId, other.tenantId);
    expect((await listContracts(stranger)).rows.map((r) => r.id)).not.toContain(id);
    expect(await outcome(readContract(stranger, id))).toBe("NOT_FOUND");
    expect(await outcome(updateContractDraft(stranger, id, { title: "Mine" }))).toBe("NOT_FOUND");
    expect(await outcome(deleteContractDraft(stranger, id))).toBe("NOT_FOUND");
    const raw = await withTenant(other.tenantId, { type: "member", id: other.seats.owner.memberId }, (tx) =>
      tx.$executeRaw`UPDATE contract SET title = 'Mine' WHERE id = ${id}`,
    );
    expect(raw).toBe(0);
  });
});
