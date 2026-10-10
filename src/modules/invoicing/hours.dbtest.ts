import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { DomainError } from "@/lib/domain-error";
import { dateColumn } from "@/lib/duration";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";
import { splitEntry, updateEntry } from "@/modules/time/entries";
import { changeItemVisibility, createItem } from "@/modules/work/items";
import { setProjectRounding, updateProject } from "@/projects/service";

import { createCreditDraft, creditInFull } from "./credit";
import { createDraft, deleteDraft, getInvoice, removeLine, updateDraftDetails, updateLine } from "./drafts";
import {
  addHoursToDraft,
  clearHourMarks,
  createInvoiceFromHours,
  listReadyToInvoice,
  markHours,
  readClientHours,
  returnHours,
} from "./hours";
import { billedSeconds, ROUNDING_MODES, ROUNDING_STEPS, type RoundingRule } from "./hours-lines";
import { issueInvoice, readIssueCheck } from "./issue";
import { updateCompanyDetails, updatePaymentDetails } from "./seller";
import { setFirstInvoiceNumber } from "./series";

/**
 * TRACKED HOURS ONTO INVOICES against the real database and the real
 * app_runtime role (Phase 4 slice 110; founder decisions C75 (a), (b), C80;
 * migration 20261010180000):
 *   - the rounding: the SQL twin equals the TypeScript rule, entry by entry;
 *   - the ready list and a client's hours — who sees them;
 *   - Create invoice / Add hours: lines, each hour's record, its mark, the
 *     period; two adds of the same hours at once — one wins;
 *   - a draft's hours go back with their line, or the draft;
 *   - an issued invoice keeps its hours (never locked — still editable);
 *   - a credit in full frees them, or moves them onto the corrected copy
 *     (an hour edited since moves as billed); a part credit keeps them, and
 *     they are returned by hand;
 *   - "Billed elsewhere" / "Won't invoice", and undo;
 *   - a split of a marked hour carries the mark; on a draft's line it is refused;
 *   - the guards past the services.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
const run = randomUUID().slice(0, 6);
const acme = randomUUID();
const beta = randomUUID();
let acmeP: string; // no rounding, portal on (tasks can be shared)
let roundP: string; // 15 min UP, minimum 30
let betaP: string;
let sharedTask: string;
let privateTask: string;

const ctxOf = (memberId: string) => ({ tenantId: f.tenantId, actor: actorFor(memberId) });
const owner = () => ctxOf(f.seats.owner.memberId);
const admin = () => ctxOf(f.seats.admin.memberId);
const manager = () => ctxOf(f.seats.manager.memberId);
const employee = () => ctxOf(f.seats.employee.memberId);

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

/** Which of the database's tokens refused a raw write. */
const TOKENS = [
  "INVOICE_HOURS_GUARD",
  "TIME_BILLING_GUARD",
  "INVOICE_HOURS_KEPT",
  "INVOICE_HAS_HOURS",
  "INVOICE_HOURS_MISMATCH",
  "HOURS_CHANGED",
  "INVOICE_NOT_DRAFT",
  "time_entry_one_billing_mark",
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

let day = 0;
/** A finished billable hour, planted as a row (the time module's own rules are its suites'). Each on its own day. */
async function hour(
  projectId: string,
  opts: {
    seconds?: number;
    rate?: string | null;
    workItemId?: string | null;
    memberId?: string;
    needsReview?: boolean;
    billable?: boolean;
    date?: string;
  } = {},
): Promise<string> {
  const id = randomUUID();
  day += 1;
  const date = opts.date ?? `2026-09-${String(1 + (day % 28)).padStart(2, "0")}`;
  const seconds = opts.seconds ?? 3600;
  const startedAt = new Date(`${date}T08:00:00Z`);
  const project = await f.platform.project.findUniqueOrThrow({ where: { id: projectId }, select: { clientId: true } });
  // A non-billable hour carries no rate (`time_entry_billable_rate`).
  const rate = opts.billable === false ? null : opts.rate === undefined ? "1000" : opts.rate;
  await f.platform.timeEntry.create({
    data: {
      id,
      tenantId: f.tenantId,
      clientId: project.clientId,
      projectId,
      workItemId: opts.workItemId ?? null,
      // Project work without a task carries a note (`time_entry_note_or_item`).
      description: opts.workItemId ? null : "Meeting",
      memberId: opts.memberId ?? f.seats.owner.memberId,
      startedAt,
      stoppedAt: new Date(startedAt.getTime() + seconds * 1000),
      durationSeconds: seconds,
      timezone: "Europe/Stockholm",
      localDate: dateColumn(date),
      entryMode: seconds === 0 ? "DURATION" : "MANUAL",
      source: "MANUAL",
      billable: opts.billable ?? true,
      billRate: rate,
      currency: rate === null ? null : "SEK",
      rateSource: rate === null ? "NONE" : "PROJECT",
      needsReview: opts.needsReview ?? false,
    },
  });
  return id;
}

const entry = (id: string) => f.platform.timeEntry.findUniqueOrThrow({ where: { id } });
const records = (invoiceId: string) => f.platform.invoiceLineTimeEntry.findMany({ where: { invoiceId }, orderBy: { localDate: "asc" } });
const linesOf = (invoiceId: string) => f.platform.invoiceLine.findMany({ where: { invoiceId }, orderBy: { position: "asc" } });

/** An invoice made from these hours and issued (by the admin). */
async function issuedFromHours(ids: readonly string[], grouping = "PROJECT"): Promise<string> {
  const { invoiceId } = await createInvoiceFromHours(admin(), { clientId: acme, entryIds: ids, grouping });
  await issueInvoice(admin(), invoiceId);
  return invoiceId;
}

beforeAll(async () => {
  f = await setupTenant("invh");
  const address = { addressLine1: "Gatan 1", postalCode: "111 22", city: "Stockholm", countryCode: "SE" };
  await f.platform.client.createMany({
    data: [
      { id: acme, tenantId: f.tenantId, name: `Acme ${run}`, orgNr: "556677-8899", ...address },
      { id: beta, tenantId: f.tenantId, name: `Beta ${run}`, ...address },
    ],
  });
  acmeP = randomUUID();
  roundP = randomUUID();
  betaP = randomUUID();
  const up = run.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
  await f.platform.project.createMany({
    data: [
      { id: acmeP, tenantId: f.tenantId, clientId: acme, key: `HA${up}`, name: `Webshop ${run}`, portalEnabled: true, billingCurrency: "SEK" },
      {
        id: roundP,
        tenantId: f.tenantId,
        clientId: acme,
        key: `HR${up}`,
        name: `Support ${run}`,
        billingCurrency: "SEK",
        invoiceRoundingStep: 15,
        invoiceRoundingMode: "UP",
        invoiceRoundingMinimum: 30,
      },
      { id: betaP, tenantId: f.tenantId, clientId: beta, key: `HB${up}`, name: `Beta site ${run}`, billingCurrency: "SEK" },
    ],
  });
  sharedTask = (await createItem(owner(), { projectId: acmeP, title: `Checkout redesign ${run}` })).id;
  await changeItemVisibility(owner(), sharedTask, "CLIENT_VISIBLE");
  privateTask = (await createItem(owner(), { projectId: acmeP, title: `Fix the mess ${run}` })).id;
  await updateCompanyDetails(owner(), {
    legalName: "Invh Konsult AB",
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
}, 120_000);

afterAll(async () => {
  if (!f) return;
  // Invoices first (their records RESTRICT the hours; the hours' marks are cleared there).
  await f.deleteInvoices();
  await f.platform.timeEntry.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.projectTimeSummary.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.notification.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.$executeRaw`DELETE FROM search_index WHERE tenant_id = ${f.tenantId}`;
  await f.platform.workItemActivity.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.workItem.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.workflowState.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.tenantCounter.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.memberProject.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.memberClient.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.rolePermission.deleteMany({ where: { tenantId: f.tenantId, source: "TENANT_GRANT" } });
  await f.platform.project.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.client.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.tenantKey.deleteMany({ where: { tenantId: f.tenantId } });
  await f.cleanup();
}, 120_000);

describe("rounding (C75 (b), C80 (c))", () => {
  it("the database's twin bills every entry exactly as the TypeScript rule does", async () => {
    const raws = [0, 1, 59, 60, 61, 299, 300, 449, 450, 451, 899, 900, 901, 1799, 1800, 3599, 3600, 3601, 5400, 86399];
    const rules: (RoundingRule | null)[] = [null];
    for (const step of ROUNDING_STEPS) {
      for (const mode of ROUNDING_MODES) rules.push({ stepMinutes: step, mode, minimumMinutes: null }, { stepMinutes: step, mode, minimumMinutes: 30 });
    }
    const cases = rules.flatMap((rule) => raws.map((raw) => ({ raw, rule })));
    const rows = await f.platform.$queryRaw<{ i: number; billed: number }[]>`
      SELECT c.i, time_billed_seconds(c.raw, c.step, c.mode::invoice_rounding_mode, c.minimum) AS billed
        FROM jsonb_to_recordset(${JSON.stringify(
          cases.map((c, i) => ({ i, raw: c.raw, step: c.rule?.stepMinutes ?? null, mode: c.rule?.mode ?? null, minimum: c.rule?.minimumMinutes ?? null })),
        )}::jsonb) AS c(i int, raw int, step int, mode text, minimum int)`;
    expect(rows).toHaveLength(cases.length);
    for (const r of rows) {
      const c = cases[r.i]!;
      expect(r.billed, `${c.raw}s under ${JSON.stringify(c.rule)}`).toBe(billedSeconds(c.raw, c.rule));
    }
  });
});

describe("the ready-to-invoice list", () => {
  it("lists a client's waiting hours and their value; a 0-second row and a non-billable one are not on it", async () => {
    const a = await hour(acmeP, { seconds: 5400 }); // 1,5 h × 1000
    await hour(acmeP, { seconds: 0 });
    await hour(acmeP, { billable: false });
    const r = await hour(roundP, { seconds: 300 }); // 5 min → 30 min (the minimum) × 1000
    const ready = await listReadyToInvoice(admin());
    const row = ready.find((x) => x.clientId === acme)!;
    expect(row.byCurrency).toEqual([{ currency: "SEK", seconds: 5400 + 1800, amount: 150_000n + 50_000n }]);
    const page = await readClientHours(admin(), acme);
    expect(page.hours.map((h) => h.id).sort()).toEqual([a, r].sort());
    expect(page.hours.find((h) => h.id === r)).toMatchObject({ rawSeconds: 300, billedSeconds: 1800 });
    await markHours(admin(), { clientId: acme, entryIds: [a, r], mark: "WONT_INVOICE" }); // out of later tests' way
  });

  it("is an owner's and an admin's: a manager and an employee are refused", async () => {
    expect(await outcome(listReadyToInvoice(manager()))).toBe("FORBIDDEN");
    expect(await outcome(listReadyToInvoice(employee()))).toBe("FORBIDDEN");
    expect(await outcome(readClientHours(manager(), acme))).toBe("FORBIDDEN");
  });

  it("a member scoped to one client sees and does nothing of another's", async () => {
    const theirs = await hour(betaP);
    for (const code of ["invoice:view", "invoice:generate_from_time", "invoice:create", "invoice:edit", "time:write_off"]) {
      const p = await f.platform.permission.findUniqueOrThrow({ where: { code }, select: { id: true } });
      await f.platform.rolePermission.create({
        data: { tenantId: f.tenantId, roleId: f.seats.employee.roleId, permissionId: p.id, source: "TENANT_GRANT" },
      });
    }
    await f.platform.memberClient.create({ data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, clientId: acme } });
    await f.platform.tenant.update({ where: { id: f.tenantId }, data: { permissionsVersion: { increment: 1 } } });
    try {
      expect((await listReadyToInvoice(employee())).some((r) => r.clientId === beta)).toBe(false);
      expect(await outcome(readClientHours(employee(), beta))).toBe("NOT_FOUND");
      expect(await outcome(createInvoiceFromHours(employee(), { clientId: beta, entryIds: [theirs], grouping: "PROJECT" }))).toBe("NOT_FOUND");
      expect(await outcome(markHours(employee(), { clientId: beta, entryIds: [theirs], mark: "WONT_INVOICE" }))).toBe("NOT_FOUND");
      // Another client's hour named under one's own client: the hour is not that client's.
      expect(await outcome(createInvoiceFromHours(employee(), { clientId: acme, entryIds: [theirs], grouping: "PROJECT" }))).toBe("HOURS_CHANGED");
    } finally {
      await f.platform.memberClient.deleteMany({ where: { tenantId: f.tenantId, memberId: f.seats.employee.memberId } });
      await f.platform.rolePermission.deleteMany({ where: { tenantId: f.tenantId, source: "TENANT_GRANT" } });
      await f.platform.tenant.update({ where: { id: f.tenantId }, data: { permissionsVersion: { increment: 1 } } });
    }
    await markHours(admin(), { clientId: beta, entryIds: [theirs], mark: "WONT_INVOICE" });
  });
});

describe("putting hours on a draft (C80 (a), (b))", () => {
  it("Create invoice: lines by project, each hour recorded and marked, the period its days, audited", async () => {
    const a = await hour(acmeP, { seconds: 3600, date: "2026-09-02" });
    const b = await hour(acmeP, { seconds: 1800, date: "2026-09-05" });
    const c = await hour(acmeP, { seconds: 3600, rate: "1200", date: "2026-09-03" });
    expect(await outcome(createInvoiceFromHours(manager(), { clientId: acme, entryIds: [a], grouping: "PROJECT" }))).toBe("FORBIDDEN");
    const made = await createInvoiceFromHours(admin(), { clientId: acme, entryIds: [a, b, c], grouping: "PROJECT" });
    const invoice = await f.platform.invoice.findUniqueOrThrow({ where: { id: made.invoiceId } });
    expect(invoice).toMatchObject({ status: "DRAFT", currency: "SEK", projectId: acmeP });
    expect(invoice.periodStart?.toISOString().slice(0, 10)).toBe("2026-09-02");
    expect(invoice.periodEnd?.toISOString().slice(0, 10)).toBe("2026-09-05");
    const lines = await linesOf(made.invoiceId);
    expect(lines.map((l) => [l.description, l.quantity.toFixed(3), l.unitPriceExVat.toFixed(2), l.amountExVat.toFixed(2), l.unit])).toEqual([
      [`Webshop ${run}`, "1.000", "1200.00", "1200.00", "h"],
      [`Webshop ${run}`, "1.500", "1000.00", "1500.00", "h"],
    ]);
    const recs = await records(made.invoiceId);
    expect(recs.map((r) => r.timeEntryId).sort()).toEqual([a, b, c].sort());
    for (const id of [a, b, c]) {
      const e = await entry(id);
      expect(recs.find((r) => r.timeEntryId === id)?.invoiceLineId).toBe(e.invoiceLineId);
      expect(e.lockedReason).toBeNull(); // never locked (C75 (a))
    }
    expect((await f.audits("invoice.hours_added")).at(-1)?.metadata).toMatchObject({ op: "created", grouping: "PROJECT", hours: 3, leftOut: 0 });
    // Gone from the list.
    expect((await readClientHours(admin(), acme)).hours.some((h) => [a, b, c].includes(h.id))).toBe(false);
    // The draft's page: "From N hours" under each line.
    const view = await getInvoice(admin(), made.invoiceId);
    expect(Object.values(view.hours!.perLine).sort()).toEqual([1, 2]);
    await deleteDraft(admin(), made.invoiceId);
  });

  it("per task: a shared task by its title, a private one and project work as Other work, in the client's language", async () => {
    const s = await hour(acmeP, { workItemId: sharedTask });
    const p = await hour(acmeP, { workItemId: privateTask });
    const n = await hour(acmeP);
    const made = await createInvoiceFromHours(admin(), { clientId: acme, entryIds: [s, p, n], grouping: "TASK" });
    const lines = await linesOf(made.invoiceId);
    expect(lines.map((l) => [l.description, l.quantity.toFixed(3)])).toEqual([
      [`Checkout redesign ${run}`, "1.000"],
      // Acme is Swedish: its invoices — and their lines' words — are Swedish.
      ["Övrigt arbete", "2.000"],
    ]);
    expect(lines.some((l) => l.description.includes("Fix the mess"))).toBe(false);
    await deleteDraft(admin(), made.invoiceId);
  });

  it("each entry rounded by its project's rule: 5 min at 15 up, minimum 30 → 30 min; a line of nothing is refused", async () => {
    const r1 = await hour(roundP, { seconds: 300 });
    const r2 = await hour(roundP, { seconds: 1000 }); // → 30 min (step) — the minimum is the same
    const made = await createInvoiceFromHours(admin(), { clientId: acme, entryIds: [r1, r2], grouping: "PROJECT" });
    const [line] = await linesOf(made.invoiceId);
    expect(line!.quantity.toFixed(3)).toBe("1.000");
    expect((await records(made.invoiceId)).map((r) => [r.rawSeconds, r.billedSeconds]).sort()).toEqual([
      [1000, 1800],
      [300, 1800],
    ]);
    await deleteDraft(admin(), made.invoiceId);
    // A few seconds with rounding off convert to 0,000 h: nothing to bill, nothing written.
    const tiny = await hour(acmeP, { seconds: 1 });
    expect(await outcome(createInvoiceFromHours(admin(), { clientId: acme, entryIds: [tiny], grouping: "PROJECT" }))).toBe("HOURS_NOTHING_TO_BILL");
    expect((await entry(tiny)).invoiceLineId).toBeNull();
    await markHours(admin(), { clientId: acme, entryIds: [tiny], mark: "WONT_INVOICE" });
  });

  it("Add hours to an open draft; two adds of the same hours at once — one wins, the other is refused", async () => {
    const d1 = await createDraft(admin(), { clientId: acme });
    const d2 = await createDraft(admin(), { clientId: acme });
    const x = await hour(acmeP);
    const y = await hour(acmeP);
    const results = await Promise.all([
      outcome(addHoursToDraft(admin(), d1, { entryIds: [x, y], grouping: "PROJECT" })),
      outcome(addHoursToDraft(owner(), d2, { entryIds: [y, x], grouping: "PROJECT" })),
    ]);
    expect([...results].sort()).toEqual(["HOURS_CHANGED", "ok"]);
    const won = results[0] === "ok" ? d1 : d2;
    expect((await records(won)).map((r) => r.timeEntryId).sort()).toEqual([x, y].sort());
    expect(await f.platform.invoiceLineTimeEntry.count({ where: { invoiceId: won === d1 ? d2 : d1 } })).toBe(0);
    // A draft holding hours keeps its currency (the design review's M3) — the service, and the database.
    expect(await outcome(updateDraftDetails(admin(), won, { currency: "EUR" }))).toBe("INVOICE_HAS_HOURS");
    expect(await refusal(asMember(f.seats.admin.memberId, (tx) => tx.$executeRaw`UPDATE invoice SET currency = 'EUR' WHERE id = ${won}`))).toBe(
      "INVOICE_HAS_HOURS",
    );
    // Remove the line: its hours are back on the list.
    const [line] = await linesOf(won);
    expect(await removeLine(admin(), won, line!.id)).toBe(2);
    expect((await entry(x)).invoiceLineId).toBeNull();
    expect(await f.platform.invoiceLineTimeEntry.count({ where: { invoiceId: won } })).toBe(0);
    // Deleting a draft does the same.
    await addHoursToDraft(admin(), d1, { entryIds: [x, y], grouping: "PERSON" });
    await deleteDraft(admin(), d1);
    expect((await entry(y)).invoiceLineId).toBeNull();
    await deleteDraft(admin(), d2);
    await markHours(admin(), { clientId: acme, entryIds: [x, y], mark: "WONT_INVOICE" });
  });
});

describe("an issued invoice keeps its hours — marked, never locked (C75 (a), C80 (e))", () => {
  it("the hours stay editable; the invoice does not change; nothing frees them uncredited", async () => {
    const h = await hour(acmeP);
    const id = await issuedFromHours([h]);
    const before = (await linesOf(id))[0]!;
    // Still editable, as ever: an edit of the hour changes the hour, never the invoice.
    await updateEntry(owner(), h, { durationText: "2h" });
    expect((await entry(h)).durationSeconds).toBe(7200);
    expect((await linesOf(id))[0]!.quantity.toFixed(3)).toBe(before.quantity.toFixed(3));
    expect((await entry(h)).invoiceLineId).toBe(before.id);
    // Not returned by hand while nothing credits it; not freed by a raw write either.
    expect(await outcome(returnHours(admin(), id, { entryIds: [h] }))).toBe("INVOICE_HOURS_KEPT");
    expect(
      await refusal(asMember(f.seats.admin.memberId, (tx) => tx.$executeRaw`UPDATE time_entry SET invoice_line_id = NULL WHERE id = ${h}`)),
    ).toBe("INVOICE_HOURS_KEPT");
    // No hour joins an issued invoice, and its record never changes.
    const other = await hour(acmeP);
    expect(
      await refusal(
        asMember(f.seats.admin.memberId, (tx) =>
          tx.invoiceLineTimeEntry.create({
            data: {
              tenantId: f.tenantId,
              clientId: acme,
              invoiceId: id,
              invoiceLineId: before.id,
              timeEntryId: other,
              projectId: acmeP,
              localDate: dateColumn("2026-09-01"),
              rawSeconds: 3600,
              billedSeconds: 3600,
              billRate: "1000",
            },
          }),
        ),
      ),
    ).toMatch(/INVOICE_HOURS_GUARD|INVOICE_NOT_DRAFT/);
    expect(
      await refusal(asMember(f.seats.admin.memberId, (tx) => tx.$executeRaw`DELETE FROM invoice_line_time_entry WHERE invoice_id = ${id}`)),
    ).not.toBe("ok");
    await markHours(admin(), { clientId: acme, entryIds: [other], mark: "WONT_INVOICE" });
  });

  it("a split of an invoiced hour carries the mark; on a draft's line it is refused", async () => {
    const h = await hour(acmeP, { seconds: 7200 });
    const id = await issuedFromHours([h]);
    const { second } = await splitEntry(owner(), h, { first: "1h" });
    expect((await entry(second.id)).invoiceLineId).toBe((await entry(h)).invoiceLineId);
    expect(await f.platform.invoiceLineTimeEntry.count({ where: { timeEntryId: second.id } })).toBe(0);
    // The Hours card lists the half too — marked here, with no record — so a
    // part credit can return it by hand (the code review's low).
    expect((await getInvoice(admin(), id)).hours?.rows.find((r) => r.entryId === second.id)?.state.kind).toBe("splitHere");
    // On a draft: not billed yet — its line is removed first.
    const d = await hour(acmeP, { seconds: 7200 });
    const draft = await createInvoiceFromHours(admin(), { clientId: acme, entryIds: [d], grouping: "PROJECT" });
    expect(await outcome(splitEntry(owner(), d, { first: "1h" }))).toBe("ENTRY_INVOICED");
    await deleteDraft(admin(), draft.invoiceId);
    await markHours(admin(), { clientId: acme, entryIds: [d], mark: "WONT_INVOICE" });
    // A new row is never born marked outside a split.
    expect(
      await refusal(
        asMember(f.seats.owner.memberId, (tx) =>
          tx.timeEntry.create({
            data: {
              tenantId: f.tenantId,
              clientId: acme,
              projectId: acmeP,
              description: "Meeting",
              memberId: f.seats.owner.memberId,
              startedAt: new Date("2026-09-10T08:00:00Z"),
              stoppedAt: new Date("2026-09-10T09:00:00Z"),
              durationSeconds: 3600,
              timezone: "Europe/Stockholm",
              localDate: dateColumn("2026-09-10"),
              entryMode: "MANUAL",
              billable: true,
              writtenOffAt: new Date(),
            },
          }),
        ),
      ),
    ).toBe("TIME_BILLING_GUARD");
  });

  // A split racing a put of the same hour (the code review's medium): the
  // split holds the hour before it writes, so either the put waits and
  // records the SHORTENED hour (its second half left waiting, unmarked), or
  // the split sees the mark and is refused — never a second half left
  // unmarked while the whole hour is billed. Its own budget: three rounds of
  // two transactions each over the Neon link.
  it("a split racing a put never leaves a billed hour's second half on the list", async () => {
    for (let i = 0; i < 3; i += 1) {
      const raced = await hour(acmeP, { seconds: 7200 });
      const draftId = await createDraft(admin(), { clientId: acme });
      const before = await f.platform.timeEntry.count({ where: { tenantId: f.tenantId, deletedAt: null } });
      const [split, put] = await Promise.all([
        outcome(splitEntry(owner(), raced, { first: "1h" })),
        outcome(addHoursToDraft(admin(), draftId, { entryIds: [raced], grouping: "PROJECT" })),
      ]);
      const after = await f.platform.timeEntry.count({ where: { tenantId: f.tenantId, deletedAt: null } });
      const rec = await f.platform.invoiceLineTimeEntry.findFirst({ where: { invoiceId: draftId, timeEntryId: raced } });
      if (split === "ok") {
        expect(after).toBe(before + 1);
        // Put first would have made the split refuse; so the put waited: it billed the hour as split, or lost.
        if (rec) expect(rec.rawSeconds).toBe(3600);
        else expect(put).toBe("HOURS_CHANGED");
      } else {
        expect(split).toMatch(/ENTRY_INVOICED|HOURS_CHANGED/);
        expect(after).toBe(before);
        expect(rec?.rawSeconds).toBe(7200);
      }
      await deleteDraft(admin(), draftId);
      const left = await f.platform.timeEntry.findMany({
        where: { tenantId: f.tenantId, projectId: acmeP, deletedAt: null, invoiceLineId: null, billedExternallyAt: null, writtenOffAt: null, billable: true, durationSeconds: { gt: 0 }, stoppedAt: { not: null } },
        select: { id: true },
      });
      if (left.length > 0) await markHours(admin(), { clientId: acme, entryIds: left.map((x) => x.id), mark: "WONT_INVOICE" });
    }
  }, 180_000);
});

describe("crediting (C80 (f))", () => {
  it("a credit in full frees the hours — the record stays", async () => {
    const h = await hour(acmeP);
    const id = await issuedFromHours([h]);
    await creditInFull(admin(), id, { reason: "Wrong client", correctedCopy: false });
    expect((await entry(h)).invoiceLineId).toBeNull();
    expect(await f.platform.invoiceLineTimeEntry.count({ where: { invoiceId: id } })).toBe(1);
    expect((await f.audits("invoice.credited")).at(-1)?.metadata).toMatchObject({ hoursFreed: 1 });
    expect((await readClientHours(admin(), acme)).hours.some((x) => x.id === h)).toBe(true);
    await markHours(admin(), { clientId: acme, entryIds: [h], mark: "WONT_INVOICE" });
  });

  it("with the corrected copy the hours move onto it, as billed — an hour edited since moves too", async () => {
    const a = await hour(acmeP);
    const b = await hour(acmeP, { rate: "1200" });
    const id = await issuedFromHours([a, b]);
    await updateEntry(owner(), a, { durationText: "3h" }); // edited after billing
    const credited = await creditInFull(admin(), id, { reason: "Wrong price", correctedCopy: true });
    const copy = credited.copyId!;
    const copyLines = await linesOf(copy);
    for (const id2 of [a, b]) {
      const e = await entry(id2);
      expect(copyLines.map((l) => l.id)).toContain(e.invoiceLineId);
    }
    const moved = await records(copy);
    const original = await records(id);
    expect(moved.map((r) => [r.timeEntryId, r.rawSeconds, r.billedSeconds]).sort()).toEqual(
      original.map((r) => [r.timeEntryId, r.rawSeconds, r.billedSeconds]).sort(),
    );
    expect((await f.audits("invoice.hours_added")).at(-1)?.metadata).toMatchObject({ op: "corrected_copy", fromInvoiceId: id, hours: 2 });
    // The copy then issues: its record agrees with its marks.
    await issueInvoice(admin(), copy);
    expect((await f.platform.invoice.findUniqueOrThrow({ where: { id: copy } })).status).toBe("ISSUED");
  });

  it("a part credit keeps the hours; particular ones are returned by hand", async () => {
    const a = await hour(acmeP);
    const b = await hour(acmeP);
    const id = await issuedFromHours([a, b], "PERSON");
    const cn = await createCreditDraft(admin(), id, { reason: "One hour too many" });
    const [cline] = await linesOf(cn);
    await updateLine(admin(), cn, cline!.id, { quantity: "1" });
    await issueInvoice(admin(), cn);
    expect((await entry(a)).invoiceLineId).not.toBeNull();
    // Returning takes putting hours on invoices AND crediting.
    expect(await outcome(returnHours(manager(), id, { entryIds: [a] }))).toBe("FORBIDDEN");
    expect(await returnHours(admin(), id, { entryIds: [a] })).toBe(1);
    expect((await entry(a)).invoiceLineId).toBeNull();
    expect((await entry(b)).invoiceLineId).not.toBeNull();
    expect(await outcome(returnHours(admin(), id, { entryIds: [a] }))).toBe("HOURS_CHANGED");
    const view = await getInvoice(admin(), id);
    expect(view.hours?.rows.find((r) => r.entryId === a)?.state.kind).toBe("returned");
    expect(view.hours?.rows.find((r) => r.entryId === b)?.state.kind).toBe("here");
    expect(view.can.returnHours).toBe(true);
    await markHours(admin(), { clientId: acme, entryIds: [a], mark: "WONT_INVOICE" });
  });
});

describe("Billed elsewhere / Won't invoice (C80 (g))", () => {
  it("an owner's and an admin's; off the list, still billable; undone", async () => {
    const h = await hour(acmeP);
    expect(await outcome(markHours(manager(), { clientId: acme, entryIds: [h], mark: "BILLED_ELSEWHERE" }))).toBe("FORBIDDEN");
    expect(await markHours(admin(), { clientId: acme, entryIds: [h], mark: "BILLED_ELSEWHERE" })).toBe(1);
    const e = await entry(h);
    expect(e.billedExternallyAt).not.toBeNull();
    expect(e.billable).toBe(true);
    expect((await readClientHours(admin(), acme)).marked.find((m) => m.id === h)?.mark).toBe("BILLED_ELSEWHERE");
    expect((await f.audits("time_entry.marked_billed_elsewhere")).at(-1)?.metadata).toMatchObject({ count: 1, entryIds: [h] });
    // Marked twice is "changed"; a marked hour joins no invoice.
    expect(await outcome(markHours(admin(), { clientId: acme, entryIds: [h], mark: "WONT_INVOICE" }))).toBe("HOURS_CHANGED");
    expect(await outcome(createInvoiceFromHours(admin(), { clientId: acme, entryIds: [h], grouping: "PROJECT" }))).toBe("HOURS_CHANGED");
    // The database: a manager's raw mark is refused.
    const other = await hour(acmeP);
    expect(
      await refusal(asMember(f.seats.manager.memberId, (tx) => tx.$executeRaw`UPDATE time_entry SET written_off_at = now() WHERE id = ${other}`)),
    ).toBe("TIME_BILLING_GUARD");
    // Undo.
    expect(await clearHourMarks(admin(), { clientId: acme, entryIds: [h] })).toBe(1);
    expect((await entry(h)).billedExternallyAt).toBeNull();
    expect((await readClientHours(admin(), acme)).hours.some((x) => x.id === h)).toBe(true);
    await markHours(admin(), { clientId: acme, entryIds: [h, other], mark: "WONT_INVOICE" });
  });
});

describe("the issue reads the hours", () => {
  it("a line naming a task the client may not see blocks the issue; a record the marks disagree with too", async () => {
    const p = await hour(acmeP, { workItemId: privateTask });
    const made = await createInvoiceFromHours(admin(), { clientId: acme, entryIds: [p], grouping: "PROJECT" });
    const [line] = await linesOf(made.invoiceId);
    // The text the builder writes for a task — its title — as it would have
    // while the task was shared; a substring is never enough (the code
    // review's medium: a project named like a task is not the task).
    await updateLine(admin(), made.invoiceId, line!.id, { description: `Fix the mess ${run}` });
    const check = await asMember(f.seats.admin.memberId, (tx) => readIssueCheck(tx, f.tenantId, made.invoiceId));
    expect(check.blockers).toContain("privateTask");
    expect(check.privateTaskLines).toEqual([line!.position]);
    expect(await outcome(issueInvoice(admin(), made.invoiceId))).toBe("INVOICE_NOT_READY");
    await updateLine(admin(), made.invoiceId, line!.id, { description: "Support" });
    // A record whose hour lost its mark (a write no service makes): the issue
    // is refused by the app and by the database's own trigger.
    await asMember(f.seats.admin.memberId, (tx) => tx.$executeRaw`UPDATE time_entry SET invoice_line_id = NULL WHERE id = ${p}`);
    expect(await outcome(issueInvoice(admin(), made.invoiceId))).toBe("INVOICE_NOT_READY");
    const series = await f.platform.invoiceSeries.findFirstOrThrow({ where: { tenantId: f.tenantId } });
    expect(
      await refusal(
        asMember(f.seats.admin.memberId, (tx) => tx.$executeRaw`
          UPDATE invoice SET status = 'ISSUED', series_id = ${series.id}, issued_at = now(), issued_by_member_id = ${f.seats.admin.memberId},
                 issue_date = (now() AT TIME ZONE 'UTC')::date, due_date = (now() AT TIME ZONE 'UTC')::date + payment_terms_days,
                 subtotal_ex_vat = 1000, vat_total = 250, total = 1250
           WHERE id = ${made.invoiceId}`),
      ),
    ).toBe("INVOICE_HOURS_MISMATCH");
    await deleteDraft(admin(), made.invoiceId);
    await markHours(admin(), { clientId: acme, entryIds: [p], mark: "WONT_INVOICE" });
  });

  it("a project named like a private task is not mistaken for it (the code review's medium)", async () => {
    // A private task titled exactly as the start of the project's name: the
    // default one-line-per-project text is the project's, never the task's.
    const named = (await createItem(owner(), { projectId: acmeP, title: "Webshop" })).id;
    const h = await hour(acmeP, { workItemId: named });
    const made = await createInvoiceFromHours(admin(), { clientId: acme, entryIds: [h], grouping: "PROJECT" });
    const check = await asMember(f.seats.admin.memberId, (tx) => readIssueCheck(tx, f.tenantId, made.invoiceId));
    expect(check.blockers).not.toContain("privateTask");
    // …while the line a TASK grouping wrote for it while shared is caught once it is private again.
    await deleteDraft(admin(), made.invoiceId);
    await changeItemVisibility(owner(), named, "CLIENT_VISIBLE");
    const byTask = await createInvoiceFromHours(admin(), { clientId: acme, entryIds: [h], grouping: "TASK" });
    expect((await linesOf(byTask.invoiceId))[0]!.description).toBe("Webshop");
    await changeItemVisibility(owner(), named, "INTERNAL");
    const again = await asMember(f.seats.admin.memberId, (tx) => readIssueCheck(tx, f.tenantId, byTask.invoiceId));
    expect(again.blockers).toContain("privateTask");
    await deleteDraft(admin(), byTask.invoiceId);
    await markHours(admin(), { clientId: acme, entryIds: [h], mark: "WONT_INVOICE" });
  });

  it("an hour changed since it was added is a caution, never a blocker", async () => {
    const h = await hour(acmeP);
    const made = await createInvoiceFromHours(admin(), { clientId: acme, entryIds: [h], grouping: "PROJECT" });
    await updateEntry(owner(), h, { durationText: "2h" });
    const check = await asMember(f.seats.admin.memberId, (tx) => readIssueCheck(tx, f.tenantId, made.invoiceId));
    expect(check.hoursChanged).toBe(1);
    expect(check.blockers).toEqual([]);
    await deleteDraft(admin(), made.invoiceId);
    await markHours(admin(), { clientId: acme, entryIds: [h], mark: "WONT_INVOICE" });
  });
});

describe("a project's rounding (C75 (b); founder decision C80 (h))", () => {
  it("is changed by those who set rates — owners and admins, never an employee or a manager — and the trail says from what to what", async () => {
    const rule = { stepMinutes: 6 as const, mode: "NEAREST" as const, minimumMinutes: null };
    // A manager and an employee may edit the project, never its rounding.
    expect(await outcome(setProjectRounding(manager(), acmeP, rule))).toBe("FORBIDDEN");
    expect(await outcome(setProjectRounding(employee(), acmeP, rule))).toBe("FORBIDDEN");
    expect(await outcome(setProjectRounding(admin(), acmeP, { ...rule, minimumMinutes: 999 }))).toBe("INVALID_INPUT");
    // An ADMIN holds no project:edit and still sets it (C80 (h)).
    expect(await setProjectRounding(admin(), acmeP, rule)).toBe(true);
    expect(await setProjectRounding(admin(), acmeP, rule)).toBe(false);
    const row = await f.platform.project.findUniqueOrThrow({ where: { id: acmeP } });
    expect([row.invoiceRoundingStep, row.invoiceRoundingMode, row.invoiceRoundingMinimum]).toEqual([6, "NEAREST", null]);
    expect((await f.audits("project.updated")).at(-1)?.metadata).toMatchObject({ fields: ["invoiceRounding"], invoiceRounding: { from: null, to: "6:NEAREST:0" } });
    // The project's own edit never touches it.
    await updateProject(manager(), acmeP, { name: `Webshop ${run}` });
    expect((await f.platform.project.findUniqueOrThrow({ where: { id: acmeP } })).invoiceRoundingStep).toBe(6);
    await setProjectRounding(owner(), acmeP, null);
  });
});

describe("the guards past the services", () => {
  it("an hour moves between invoices only onto a corrected copy; never joins without its record", async () => {
    const h = await hour(acmeP);
    const d1 = await createInvoiceFromHours(admin(), { clientId: acme, entryIds: [h], grouping: "PROJECT" });
    const d2 = await createDraft(admin(), { clientId: acme });
    const other = await asMember(f.seats.admin.memberId, async (tx) => {
      const l = await tx.invoiceLine.create({
        data: { tenantId: f.tenantId, clientId: acme, invoiceId: d2, position: 1, description: "x", quantity: "1", unitPriceExVat: "1", vatRatePct: "25", amountExVat: "1" },
        select: { id: true },
      });
      return l.id;
    });
    expect(
      await refusal(asMember(f.seats.admin.memberId, (tx) => tx.$executeRaw`UPDATE time_entry SET invoice_line_id = ${other} WHERE id = ${h}`)),
    ).toBe("TIME_BILLING_GUARD");
    const free = await hour(acmeP);
    expect(
      await refusal(asMember(f.seats.admin.memberId, (tx) => tx.$executeRaw`UPDATE time_entry SET invoice_line_id = ${other} WHERE id = ${free}`)),
    ).toBe("TIME_BILLING_GUARD");
    // Without the code, even with the record (a manager may edit drafts).
    const freeDay = (await entry(free)).localDate;
    expect(
      await refusal(
        asMember(f.seats.manager.memberId, (tx) =>
          tx.invoiceLineTimeEntry.create({
            data: { tenantId: f.tenantId, clientId: acme, invoiceId: d2, invoiceLineId: other, timeEntryId: free, projectId: acmeP, localDate: freeDay, rawSeconds: 3600, billedSeconds: 3600, billRate: "1000" },
          }),
        ),
      ),
    ).toBe("INVOICE_HOURS_GUARD");
    await deleteDraft(admin(), d1.invoiceId);
    await deleteDraft(admin(), d2);
    await markHours(admin(), { clientId: acme, entryIds: [h, free], mark: "WONT_INVOICE" });
  });
});
