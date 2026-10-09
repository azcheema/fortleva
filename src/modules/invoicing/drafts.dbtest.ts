import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { DomainError } from "@/lib/domain-error";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";
import { setModuleEnabled } from "@/preferences/service";

import {
  addLine,
  createDraft,
  deleteDraft,
  getInvoice,
  listInvoices,
  moveLine,
  removeLine,
  setDraftVatProfile,
  updateDraftDetails,
  updateLine,
} from "./drafts";
import { formatFixed } from "./money";
import { updateDefaultPaymentTerms } from "./seller";

/**
 * INVOICE DRAFTS against the real database and the real app_runtime role
 * (Phase 4 slice 107; founder decision C75; migration 20261009120000):
 *   - the house recipe on every verb: `invoice:*` on all four gates (the
 *     module is `invoicing`), DIRECT client scope (a project-only member gets
 *     NOT_FOUND), the write, its audit row;
 *   - the money: a line's amount is quantity × price to the öre, VAT once per
 *     rate on the rate's sum, a VAT treatment's change moves the rates;
 *   - the DATABASE'S GUARDS — the part that must hold whatever the app does:
 *     a line's amount and rate, issuing only by a member who may, with totals
 *     equal to the lines, a frozen issued invoice and its lines, the status
 *     forward only and by the code for the step, no delete of an issued
 *     invoice except by the platform role under the maintenance GUC, and the
 *     issue race (a line written while the invoice is being issued waits for
 *     the issue and is then refused).
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let acme: string; // Swedish
let beta: string; // German business with a VAT number
let gamma: string; // US
let archived: string;
let acmeP: string;
let betaP: string;

const ctxOf = (memberId: string) => ({ tenantId: f.tenantId, actor: actorFor(memberId) });
const owner = () => ctxOf(f.seats.owner.memberId);
const admin = () => ctxOf(f.seats.admin.memberId);
const manager = () => ctxOf(f.seats.manager.memberId);
const employee = () => ctxOf(f.seats.employee.memberId);

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
  "INVOICE_NOT_DRAFT",
  "INVOICE_RATE_NOT_ALLOWED",
  "INVOICE_GUARD",
  "TENANT_INVOICE_DETAILS_GUARD",
  "invoice_line_amount",
  "invoice_line_finite",
  "invoice_issued_facts",
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

const asMember = <T>(memberId: string, fn: (tx: TenantDb) => Promise<T>, opts?: { timeoutMs?: number }) =>
  withTenant(f.tenantId, { type: "member", id: memberId }, fn, opts);

/** Issue a draft by raw SQL as `memberId`, with the totals its lines say (or the ones given). */
async function issueRaw(
  invoiceId: string,
  memberId: string,
  over: { subtotal?: string; vat?: string; total?: string; issueDateSql?: "today" | "lastYear"; due?: "terms" | "plusOne" } = {},
) {
  const detail = await getInvoice(owner(), invoiceId);
  const subtotal = over.subtotal ?? formatFixed(detail.totals.subtotal, 2);
  const vat = over.vat ?? formatFixed(detail.totals.vatTotal, 2);
  const total = over.total ?? formatFixed(detail.totals.total, 2);
  const number = Math.floor(Math.random() * 1_000_000) + 1;
  const dayShift = over.issueDateSql === "lastYear" ? 365 : 0;
  const dueExtra = over.due === "plusOne" ? 1 : 0;
  return asMember(memberId, (tx) =>
    tx.$executeRaw`
      UPDATE invoice
         SET status = 'ISSUED', series_id = 'test-series', number = ${number}, display_number = ${`T-${number}`},
             issue_date = CURRENT_DATE - ${dayShift}::int,
             due_date = CURRENT_DATE - ${dayShift}::int + payment_terms_days + ${dueExtra}::int,
             issued_at = now(), issued_by_member_id = ${memberId},
             subtotal_ex_vat = ${subtotal}::numeric, vat_total = ${vat}::numeric, total = ${total}::numeric
       WHERE id = ${invoiceId}`,
  );
}

beforeAll(async () => {
  f = await setupTenant("invd");
  acme = randomUUID();
  beta = randomUUID();
  gamma = randomUUID();
  archived = randomUUID();
  acmeP = randomUUID();
  betaP = randomUUID();
  await f.platform.client.createMany({
    data: [
      { id: acme, tenantId: f.tenantId, name: "Acme AB", countryCode: "SE" },
      { id: beta, tenantId: f.tenantId, name: "Beta GmbH", countryCode: "DE", vatNumber: "DE123456789" },
      { id: gamma, tenantId: f.tenantId, name: "Gamma Inc", countryCode: "US" },
      { id: archived, tenantId: f.tenantId, name: "Gone", status: "ARCHIVED" },
    ],
  });
  await f.platform.project.createMany({
    data: [
      { id: acmeP, tenantId: f.tenantId, clientId: acme, key: "INVA", name: "Acme site" },
      { id: betaP, tenantId: f.tenantId, clientId: beta, key: "INVB", name: "Beta site" },
    ],
  });
}, 120_000);

afterAll(async () => {
  if (!f) return;
  await f.deleteInvoices();
  await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.memberProject.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.memberClient.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.rolePermission.deleteMany({ where: { tenantId: f.tenantId, source: "TENANT_GRANT" } });
  await f.platform.project.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.client.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.tenantKey.deleteMany({ where: { tenantId: f.tenantId } });
  await f.cleanup();
}, 120_000);

describe("a new draft — where it starts", () => {
  it("starts from the client's country and VAT number, the workspace's defaults, and its maker", async () => {
    const se = await createDraft(manager(), { clientId: acme, projectId: acmeP });
    const de = await createDraft(manager(), { clientId: beta });
    const us = await createDraft(manager(), { clientId: gamma });
    const [a, b, c] = [await getInvoice(manager(), se), await getInvoice(manager(), de), await getInvoice(manager(), us)];
    expect(a.vatProfile).toBe("SE_DOMESTIC");
    expect(b.vatProfile).toBe("EU_REVERSE_CHARGE");
    expect(c.vatProfile).toBe("OUTSIDE_SCOPE");
    expect(a.status).toBe("DRAFT");
    expect(a.displayNumber).toBeNull();
    expect(a.currency).toBe("SEK");
    expect(a.paymentTermsDays).toBe(30);
    expect(a.project?.id).toBe(acmeP);
    expect(a.ourReference).toMatch(/^manager-invd-/);
    const created = (await f.audits("invoice.created")).filter((r) => r.targetId === se);
    expect(created).toHaveLength(1);
    expect(created[0]!.actorId).toBe(f.seats.manager.memberId);
  });

  it("follows what this client was last invoiced in, else the workspace's terms", async () => {
    const first = await createDraft(manager(), { clientId: gamma });
    await updateDraftDetails(manager(), first, { currency: "USD", paymentTermsDays: "15" });
    const next = await getInvoice(manager(), await createDraft(manager(), { clientId: gamma }));
    expect(next.currency).toBe("USD");
    expect(next.paymentTermsDays).toBe(15);
    // The workspace default moves a client with no invoices yet.
    await updateDefaultPaymentTerms(admin(), "45");
    const fresh = randomUUID();
    await f.platform.client.create({ data: { id: fresh, tenantId: f.tenantId, name: "Delta AB" } });
    const d = await getInvoice(manager(), await createDraft(manager(), { clientId: fresh }));
    expect(d.paymentTermsDays).toBe(45);
    await updateDefaultPaymentTerms(admin(), "");
  });

  it("refuses an archived client and another client's project", async () => {
    expect(await outcome(createDraft(manager(), { clientId: archived }))).toBe("ARCHIVED");
    expect(await outcome(createDraft(manager(), { clientId: acme, projectId: betaP }))).toBe("CLIENT_MISMATCH");
  });
});

describe("lines and money", () => {
  let id: string;
  beforeAll(async () => {
    id = await createDraft(manager(), { clientId: acme });
  });

  it("adds a line from its description alone, and computes the amount to the öre", async () => {
    const line = await addLine(manager(), id, { description: "Design work" });
    let detail = await getInvoice(manager(), id);
    expect(detail.lines).toHaveLength(1);
    expect(detail.lines[0]).toMatchObject({ quantity: 1000n, unitPrice: 0n, vatRate: 2500n, amount: 0n });
    expect(await updateLine(manager(), id, line, { quantity: "1,5", unitPrice: "999,99", unit: "h" })).toEqual([
      "quantity",
      "unit",
      "unitPrice",
    ]);
    detail = await getInvoice(manager(), id);
    expect(detail.lines[0]).toMatchObject({ quantity: 1500n, unitPrice: 99_999n, amount: 149_999n, unit: "h" });
    // A no-op writes nothing.
    expect(await updateLine(manager(), id, line, { quantity: "1.5" })).toEqual([]);
  });

  it("charges VAT once per rate on the rate's sum", async () => {
    const tiny = await createDraft(manager(), { clientId: acme });
    for (const d of ["a", "b", "c"]) {
      const l = await addLine(manager(), tiny, { description: d });
      await updateLine(manager(), tiny, l, { unitPrice: "0,01" });
    }
    const books = await addLine(manager(), tiny, { description: "Books" });
    await updateLine(manager(), tiny, books, { unitPrice: "100", vatRate: "6" });
    const t = (await getInvoice(manager(), tiny)).totals;
    expect(t.groups).toEqual([
      { rate: 2500n, net: 3n, vat: 1n },
      { rate: 600n, net: 10_000n, vat: 600n },
    ]);
    expect(t.total).toBe(10_003n + 601n);
  });

  it("refuses a rate the treatment does not have, a blank description, an amount past a line", async () => {
    const l = await addLine(manager(), id, { description: "Hosting" });
    expect(await outcome(updateLine(manager(), id, l, { vatRate: "0" }))).toBe("INVOICE_RATE_NOT_ALLOWED");
    expect(await outcome(updateLine(manager(), id, l, { description: "   " }))).toBe("INVOICE_LINE_DESCRIPTION_REQUIRED");
    expect(await outcome(updateLine(manager(), id, l, { quantity: "1000000", unitPrice: "99999999" }))).toBe(
      "INVOICE_AMOUNT_TOO_LARGE",
    );
    expect(await outcome(updateLine(manager(), id, l, { quantity: "0" }))).toBe("INVALID_INPUT");
    expect(await outcome(updateLine(manager(), id, l, { unitPrice: "1,005" }))).toBe("INVALID_INPUT");
    await removeLine(manager(), id, l);
  });

  it("reads a decimal comma as the member's language says (the fix-pass review's medium)", async () => {
    const l = await addLine(manager(), id, { description: "Hours" });
    // Swedish: "1,333" is 1.333 — the very text the table shows for it.
    expect(await updateLine(manager(), id, l, { quantity: "1,333" }, { decimalComma: true })).toEqual(["quantity"]);
    expect((await getInvoice(manager(), id)).lines.find((x) => x.id === l)?.quantity).toBe(1333n);
    // Elsewhere the same text is ambiguous and asked again; a Swedish "1.500" likewise.
    expect(await outcome(updateLine(manager(), id, l, { quantity: "2,125" }))).toBe("INVALID_INPUT");
    expect(await outcome(updateLine(manager(), id, l, { quantity: "1.500" }, { decimalComma: true }))).toBe("INVALID_INPUT");
    await removeLine(manager(), id, l);
  });

  it("moves a line through the swap slot, and leaves the first where it is going up", async () => {
    const second = await addLine(manager(), id, { description: "Second" });
    const before = (await getInvoice(manager(), id)).lines.map((l) => l.description);
    expect(await moveLine(manager(), id, second, "up")).toBe(true);
    const after = (await getInvoice(manager(), id)).lines.map((l) => l.description);
    expect(after).toEqual([before[1], before[0]]);
    expect(await moveLine(manager(), id, second, "up")).toBe(false);
  });

  it("a VAT treatment's change moves only the rates it does not have", async () => {
    const v = await createDraft(manager(), { clientId: acme });
    const a = await addLine(manager(), v, { description: "Std" });
    const b = await addLine(manager(), v, { description: "Food" });
    await updateLine(manager(), v, b, { vatRate: "12" });
    expect(await setDraftVatProfile(manager(), v, "EU_REVERSE_CHARGE")).toBe(2);
    expect((await getInvoice(manager(), v)).lines.map((l) => l.vatRate)).toEqual([0n, 0n]);
    expect(await setDraftVatProfile(manager(), v, "SE_DOMESTIC")).toBe(2);
    expect((await getInvoice(manager(), v)).lines.map((l) => l.vatRate)).toEqual([2500n, 2500n]);
    expect(await setDraftVatProfile(manager(), v, "SE_DOMESTIC")).toBe(0);
    expect(a).toBeTruthy();
    const edits = (await f.audits("invoice.draft_edited")).filter((r) => r.targetId === v);
    expect(edits.some((r) => JSON.stringify(r.metadata).includes("vatProfile"))).toBe(true);
  });

  it("refuses details out of bounds", async () => {
    expect(await outcome(updateDraftDetails(manager(), id, { currency: "XYZ" }))).toBe("INVALID_INPUT");
    expect(await outcome(updateDraftDetails(manager(), id, { paymentTermsDays: "121" }))).toBe("INVALID_INPUT");
    expect(await outcome(updateDraftDetails(manager(), id, { periodStart: "2026-10-09", periodEnd: "2026-10-01" }))).toBe(
      "INVALID_INPUT",
    );
    expect(await outcome(updateDraftDetails(manager(), id, { projectId: betaP }))).toBe("CLIENT_MISMATCH");
    expect(await updateDraftDetails(manager(), id, { buyerReference: "PO-1", periodStart: "2026-09-01" })).toEqual([
      "periodStart",
      "buyerReference",
    ]);
  });
});

describe("who may — the codes, the scope, the module", () => {
  it("the employee holds no invoice code; given them, a project-only seat still reaches nothing", async () => {
    const id = await createDraft(manager(), { clientId: acme, projectId: acmeP });
    expect(await outcome(listInvoices(employee()))).toBe("FORBIDDEN");
    for (const code of ["invoice:view", "invoice:edit"]) {
      const p = await f.platform.permission.findUniqueOrThrow({ where: { code }, select: { id: true } });
      await f.platform.rolePermission.create({
        data: { tenantId: f.tenantId, roleId: f.seats.employee.roleId, permissionId: p.id, source: "TENANT_GRANT" },
      });
    }
    await f.platform.memberProject.create({ data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, projectId: acmeP } });
    await f.platform.tenant.update({ where: { id: f.tenantId }, data: { permissionsVersion: { increment: 1 } } });
    expect(await outcome(getInvoice(employee(), id))).toBe("NOT_FOUND");
    expect(await outcome(addLine(employee(), id, { description: "x" }))).toBe("NOT_FOUND");
    expect((await listInvoices(employee())).rows).toHaveLength(0);
    // The list's client filter narrows the scope, never replaces it (the
    // security review's high: `?client=` once listed any client's invoices).
    expect((await listInvoices(employee(), { clientId: acme })).rows).toHaveLength(0);
    expect((await listInvoices(employee(), { clientId: beta })).rows).toHaveLength(0);
    // Assigned to the client itself, the same seat reaches it.
    await f.platform.memberClient.create({ data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, clientId: acme } });
    expect(await outcome(getInvoice(employee(), id))).toBe("ok");
    const reached = (await listInvoices(employee())).rows;
    // Never vacuous: the draft above is Acme's, so there is at least one row.
    expect(reached.length).toBeGreaterThan(0);
    expect(reached.every((r) => r.client.id === acme)).toBe(true);
    // …and the filter still narrows within the scope, never past it.
    expect((await listInvoices(employee(), { clientId: beta })).rows).toHaveLength(0);
    expect((await listInvoices(employee(), { clientId: acme })).rows.length).toBe(reached.length);
  });

  it("a manager makes and edits drafts but does not delete them; an admin does, with its lines", async () => {
    const id = await createDraft(manager(), { clientId: acme });
    await addLine(manager(), id, { description: "One" });
    expect(await outcome(deleteDraft(manager(), id))).toBe("FORBIDDEN");
    await deleteDraft(admin(), id);
    expect(await f.platform.invoice.count({ where: { id } })).toBe(0);
    expect(await f.platform.invoiceLine.count({ where: { invoiceId: id } })).toBe(0);
    const gone = (await f.audits("invoice.draft_deleted")).filter((r) => r.targetId === id);
    expect(gone).toHaveLength(1);
    expect(gone[0]!.actorId).toBe(f.seats.admin.memberId);
  });

  it("the tenant's own switch closes the module", async () => {
    await setModuleEnabled(owner(), "invoicing", false);
    try {
      expect(await outcome(listInvoices(manager()))).toBe("DISABLED_BY_TENANT");
      expect(await outcome(createDraft(manager(), { clientId: acme }))).toBe("DISABLED_BY_TENANT");
    } finally {
      await setModuleEnabled(owner(), "invoicing", true);
    }
  });
});

describe("the database's guards", () => {
  it("a line's amount is quantity × price, never NaN; its rate one the treatment has", async () => {
    const id = await createDraft(manager(), { clientId: acme });
    const base = { tenantId: f.tenantId, clientId: acme, invoiceId: id, description: "Raw", vatRatePct: "25" };
    expect(
      await refusal(
        asMember(f.seats.manager.memberId, (tx) =>
          tx.invoiceLine.create({ data: { ...base, position: 1, quantity: "2", unitPriceExVat: "10", amountExVat: "21" } }),
        ),
      ),
    ).toBe("invoice_line_amount");
    expect(
      await refusal(
        asMember(f.seats.manager.memberId, (tx) =>
          tx.$executeRaw`INSERT INTO invoice_line (id, tenant_id, client_id, invoice_id, position, description, quantity, unit_price_ex_vat, vat_rate_pct, amount_ex_vat, updated_at)
                         VALUES (${randomUUID()}, ${f.tenantId}, ${acme}, ${id}, 2, 'NaN', 'NaN', 1, 25, 'NaN', now())`,
        ),
      ),
    ).toBe("invoice_line_finite");
    const de = await createDraft(manager(), { clientId: beta });
    expect(
      await refusal(
        asMember(f.seats.manager.memberId, (tx) =>
          tx.invoiceLine.create({
            data: { ...base, clientId: beta, invoiceId: de, position: 1, quantity: "1", unitPriceExVat: "10", amountExVat: "10" },
          }),
        ),
      ),
    ).toBe("INVOICE_RATE_NOT_ALLOWED");
  });

  it("issuing: only a member who may, as themselves, dated today, due on its terms, with ≥ 1 line and the lines' totals", async () => {
    const empty = await createDraft(manager(), { clientId: acme });
    expect(await refusal(issueRaw(empty, f.seats.owner.memberId))).toBe("INVOICE_GUARD");

    const id = await createDraft(manager(), { clientId: acme });
    const l = await addLine(manager(), id, { description: "Work" });
    await updateLine(manager(), id, l, { quantity: "3", unitPrice: "1250" });
    // The manager does not hold invoice:issue.
    expect(await refusal(issueRaw(id, f.seats.manager.memberId))).toBe("INVOICE_GUARD");
    // Wrong totals, a backdated date, a due date of its own.
    expect(await refusal(issueRaw(id, f.seats.owner.memberId, { vat: "0.00", total: "3750.00" }))).toBe("INVOICE_GUARD");
    expect(await refusal(issueRaw(id, f.seats.owner.memberId, { issueDateSql: "lastYear" }))).toBe("INVOICE_GUARD");
    expect(await refusal(issueRaw(id, f.seats.owner.memberId, { due: "plusOne" }))).toBe("INVOICE_GUARD");
    // A treatment changed under the lines (raw, past the service) is caught at issue.
    await asMember(f.seats.manager.memberId, (tx) => tx.$executeRaw`UPDATE invoice SET vat_profile = 'OUTSIDE_SCOPE' WHERE id = ${id}`);
    expect(await refusal(issueRaw(id, f.seats.owner.memberId, { vat: "0.00", total: "3750.00" }))).toBe(
      "INVOICE_RATE_NOT_ALLOWED",
    );
    await asMember(f.seats.manager.memberId, (tx) => tx.$executeRaw`UPDATE invoice SET vat_profile = 'SE_DOMESTIC' WHERE id = ${id}`);
    expect(await refusal(issueRaw(id, f.seats.owner.memberId))).toBe("ok");
    const row = await f.platform.invoice.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("ISSUED");
    expect(row.total?.toFixed(2)).toBe("4687.50");
  });

  describe("an issued invoice", () => {
    let id: string;
    let line: string;
    beforeAll(async () => {
      id = await createDraft(manager(), { clientId: acme });
      line = await addLine(manager(), id, { description: "Frozen" });
      await updateLine(manager(), id, line, { unitPrice: "100" });
      expect(await refusal(issueRaw(id, f.seats.admin.memberId))).toBe("ok");
    });

    it("never changes — its content, its lines, its client", async () => {
      const m = f.seats.owner.memberId;
      expect(await refusal(asMember(m, (tx) => tx.$executeRaw`UPDATE invoice SET note = 'later' WHERE id = ${id}`))).toBe(
        "INVOICE_NOT_DRAFT",
      );
      expect(await refusal(asMember(m, (tx) => tx.$executeRaw`UPDATE invoice SET client_id = ${beta} WHERE id = ${id}`))).toBe(
        "INVOICE_GUARD",
      );
      expect(
        await refusal(asMember(m, (tx) => tx.$executeRaw`UPDATE invoice_line SET description = 'changed' WHERE id = ${line}`)),
      ).toBe("INVOICE_NOT_DRAFT");
      expect(await refusal(asMember(m, (tx) => tx.$executeRaw`DELETE FROM invoice_line WHERE id = ${line}`))).toBe(
        "INVOICE_NOT_DRAFT",
      );
      expect(
        await refusal(
          asMember(m, (tx) =>
            tx.invoiceLine.create({
              data: {
                tenantId: f.tenantId,
                clientId: acme,
                invoiceId: id,
                position: 9,
                description: "Late",
                quantity: "1",
                unitPriceExVat: "1",
                vatRatePct: "25",
                amountExVat: "1",
              },
            }),
          ),
        ),
      ).toBe("INVOICE_NOT_DRAFT");
      // The services say so in a sentence.
      expect(await outcome(updateDraftDetails(manager(), id, { note: "x" }))).toBe("INVOICE_NOT_DRAFT");
      expect(await outcome(addLine(manager(), id, { description: "x" }))).toBe("INVOICE_NOT_DRAFT");
    });

    it("its status moves only forward, by the code for the step", async () => {
      expect(await refusal(asMember(f.seats.owner.memberId, (tx) => tx.$executeRaw`UPDATE invoice SET status = 'DRAFT' WHERE id = ${id}`))).toBe(
        "INVOICE_GUARD",
      );
      // The manager holds no invoice:record_payment.
      expect(await refusal(asMember(f.seats.manager.memberId, (tx) => tx.$executeRaw`UPDATE invoice SET status = 'PAID' WHERE id = ${id}`))).toBe(
        "INVOICE_GUARD",
      );
      expect(await refusal(asMember(f.seats.admin.memberId, (tx) => tx.$executeRaw`UPDATE invoice SET status = 'PAID' WHERE id = ${id}`))).toBe(
        "ok",
      );
      expect(await refusal(asMember(f.seats.admin.memberId, (tx) => tx.$executeRaw`UPDATE invoice SET status = 'SENT' WHERE id = ${id}`))).toBe(
        "INVOICE_GUARD",
      );
    });

    it("is never deleted — not by a member, not by the runtime role with the GUC; only by the platform role under it", async () => {
      expect(await outcome(deleteDraft(admin(), id))).toBe("INVOICE_NOT_DRAFT");
      expect(
        await refusal(
          asMember(f.seats.owner.memberId, async (tx) => {
            await tx.$executeRaw`SELECT set_config('app.invoice_maintenance', 'on', true)`;
            await tx.$executeRaw`DELETE FROM invoice WHERE id = ${id}`;
          }),
        ),
      ).toBe("INVOICE_NOT_DRAFT");
      expect(await refusal(f.platform.$executeRaw`DELETE FROM invoice WHERE id = ${id}`)).toBe("INVOICE_NOT_DRAFT");
      // (The suite's own teardown deletes it the one way there is.)
      expect(await f.platform.invoice.count({ where: { id } })).toBe(1);
    });
  });

  it("THE ISSUE RACE: a line written while the invoice is being issued waits, then is refused", async () => {
    const id = await createDraft(manager(), { clientId: acme });
    const l = await addLine(manager(), id, { description: "Race" });
    await updateLine(manager(), id, l, { unitPrice: "10" });
    const detail = await getInvoice(owner(), id);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let xid: string | null = null;
    // Transaction A: the issue, held open after its UPDATE (the row lock).
    const issuing = asMember(
      f.seats.owner.memberId,
      async (tx) => {
        await tx.$executeRaw`
          UPDATE invoice
             SET status = 'ISSUED', series_id = 'race', number = 1, display_number = 'R-1',
                 issue_date = CURRENT_DATE, due_date = CURRENT_DATE + payment_terms_days,
                 issued_at = now(), issued_by_member_id = ${f.seats.owner.memberId},
                 subtotal_ex_vat = ${formatFixed(detail.totals.subtotal, 2)}::numeric,
                 vat_total = ${formatFixed(detail.totals.vatTotal, 2)}::numeric,
                 total = ${formatFixed(detail.totals.total, 2)}::numeric
           WHERE id = ${id}`;
        const rows = await tx.$queryRaw<{ xid: string }[]>`SELECT pg_current_xact_id()::xid::text AS xid`;
        xid = rows[0]!.xid;
        await gate;
      },
      { timeoutMs: 30_000 },
    );
    while (xid === null) await new Promise((r) => setTimeout(r, 20));
    // Transaction B: a line written straight past the services (no invoice
    // lock of its own) — only the line guard's FOR SHARE can make it wait.
    const writing = refusal(
      asMember(f.seats.manager.memberId, (tx) =>
        tx.invoiceLine.create({
          data: {
            tenantId: f.tenantId,
            clientId: acme,
            invoiceId: id,
            position: 5,
            description: "Slipped in",
            quantity: "1",
            unitPriceExVat: "1",
            vatRatePct: "25",
            amountExVat: "1",
          },
        }),
      ),
    );
    // B is waiting on A's row lock before A lets go — without the guard's
    // FOR SHARE it would not wait, would read the draft and succeed.
    // Measured on A's own transaction id: a session waiting on a row A holds
    // waits on A's xid (pg_locks is readable by every role, unlike another
    // role's pg_stat_activity query text).
    let waiting = 0;
    for (let i = 0; i < 200 && waiting === 0; i++) {
      await new Promise((r) => setTimeout(r, 25));
      const rows = await f.platform.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_locks
         WHERE locktype = 'transactionid' AND NOT granted AND transactionid::text = ${xid}`;
      waiting = rows[0]?.n ?? 0;
    }
    expect(waiting).toBeGreaterThan(0);
    release();
    await issuing;
    expect(await writing).toBe("INVOICE_NOT_DRAFT");
    expect(await f.platform.invoiceLine.count({ where: { invoiceId: id } })).toBe(1);
  });
});
