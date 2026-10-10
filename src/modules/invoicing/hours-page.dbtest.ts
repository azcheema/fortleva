import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { DomainError } from "@/lib/domain-error";
import { dateColumn } from "@/lib/duration";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";
import { changeItemVisibility, createItem, deleteItem, updateItemFields } from "@/modules/work/items";
import { LocalDiskTransport, setStorage } from "@/storage";

import { createCreditDraft, creditInFull } from "./credit";
import { getInvoice, updateDraftDetails, updateLine } from "./drafts";
import { createInvoiceFromHours } from "./hours";
import { readLiveHoursPageText, sharedTasks } from "./hours-record";
import { issueInvoice, readIssueCheck } from "./issue";
import { readIssuedInvoice } from "./issued";
import { makeMissingInvoicePdfs } from "./pdf-store";
import { updateCompanyDetails, updatePaymentDetails } from "./seller";
import { setFirstInvoiceNumber } from "./series";

/**
 * THE TIME BREAKDOWN PAGE against the real database and the real app_runtime
 * role (Phase 4 slice 110b; founder decisions C80 (d), C81; migration
 * 20261010210000):
 *   - `work_item_named_to_client()` answers as `namedTaskShared` does (via
 *     `sharedTasks`), over a matrix of real task trees;
 *   - `invoice_hours_page()`: one row per line, day and printed task, "Other
 *     work" (null) for a private task and for an hour with no task — never a
 *     person, a note or a private title;
 *   - the tick: a draft field of an INVOICE only; the page is written BY THE
 *     DATABASE at issue, equal to what the draft showed, and frozen; a draft
 *     never holds one; a task renamed or made private before the issue is
 *     printed as it is then — and changes the issue fingerprint;
 *   - the corrected copy keeps the tick;
 *   - odd titles (only Unicode spaces, long emoji, quotes, a newline) go
 *     through the real function, the strict reader and the drawing (the
 *     design review's M1); the jobs sweep draws a ticked invoice as SYSTEM.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
const run = randomUUID().slice(0, 6);
const storageDir = mkdtempSync(join(tmpdir(), "fortleva-hours-page-"));
const acme = randomUUID();
let acmeP: string;
let roundP: string;
let sharedTask: string;
let privateTask: string;

const ctxOf = (memberId: string) => ({ tenantId: f.tenantId, actor: actorFor(memberId) });
const owner = () => ctxOf(f.seats.owner.memberId);
const admin = () => ctxOf(f.seats.admin.memberId);

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

const TOKENS = [
  "invoice_hours_page_issued",
  "invoice_include_hours_kind",
  "INVOICE_NOT_DRAFT",
  "the time breakdown is the draft",
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

/** A finished billable hour on `date`, planted as a row. Project work without a task carries a note. */
async function hour(projectId: string, date: string, opts: { seconds?: number; workItemId?: string | null; memberId?: string } = {}): Promise<string> {
  const id = randomUUID();
  const seconds = opts.seconds ?? 3600;
  const startedAt = new Date(`${date}T08:00:00Z`);
  const project = await f.platform.project.findUniqueOrThrow({ where: { id: projectId }, select: { clientId: true } });
  await f.platform.timeEntry.create({
    data: {
      id,
      tenantId: f.tenantId,
      clientId: project.clientId,
      projectId,
      workItemId: opts.workItemId ?? null,
      description: opts.workItemId ? `A note nobody outside may read ${run}` : `Meeting notes ${run}`,
      memberId: opts.memberId ?? f.seats.owner.memberId,
      startedAt,
      stoppedAt: new Date(startedAt.getTime() + seconds * 1000),
      durationSeconds: seconds,
      timezone: "Europe/Stockholm",
      localDate: dateColumn(date),
      entryMode: "MANUAL",
      source: "MANUAL",
      billable: true,
      billRate: "1000",
      currency: "SEK",
      rateSource: "PROJECT",
    },
  });
  return id;
}

type PageJson = { version: number; lines: { lineId: string; rows: { date: string; task: string | null; seconds: number }[] }[] };
const storedPage = async (invoiceId: string) =>
  (await f.platform.invoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { hoursPage: true } })).hoursPage as PageJson | null;

/** An invoice draft made from these hours, one line per project, ticked or not. */
async function draftFrom(ids: readonly string[], tick: boolean): Promise<string> {
  const { invoiceId } = await createInvoiceFromHours(admin(), { clientId: acme, entryIds: ids, grouping: "PROJECT" });
  if (tick) await updateDraftDetails(admin(), invoiceId, { includeHours: true });
  return invoiceId;
}

beforeAll(async () => {
  setStorage(new LocalDiskTransport(storageDir));
  f = await setupTenant("invp");
  const address = { addressLine1: "Gatan 1", postalCode: "111 22", city: "Stockholm", countryCode: "SE" };
  await f.platform.client.create({ data: { id: acme, tenantId: f.tenantId, name: `Acme ${run}`, orgNr: "556677-8899", ...address } });
  acmeP = randomUUID();
  roundP = randomUUID();
  const up = run.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
  await f.platform.project.createMany({
    data: [
      { id: acmeP, tenantId: f.tenantId, clientId: acme, key: `PA${up}`, name: `Webshop ${run}`, portalEnabled: true, billingCurrency: "SEK" },
      {
        id: roundP,
        tenantId: f.tenantId,
        clientId: acme,
        key: `PR${up}`,
        name: `Support ${run}`,
        billingCurrency: "SEK",
        invoiceRoundingStep: 15,
        invoiceRoundingMode: "UP",
        invoiceRoundingMinimum: 30,
      },
    ],
  });
  sharedTask = (await createItem(owner(), { projectId: acmeP, title: `Checkout redesign ${run}` })).id;
  await changeItemVisibility(owner(), sharedTask, "CLIENT_VISIBLE");
  privateTask = (await createItem(owner(), { projectId: acmeP, title: `Fix the mess ${run}` })).id;
  await updateCompanyDetails(owner(), {
    legalName: "Invp Konsult AB",
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
  await setFirstInvoiceNumber(owner(), "8001");
}, 120_000);

afterAll(async () => {
  setStorage(null);
  if (!f) return;
  // Invoices first (their records RESTRICT the hours; the hours' marks are cleared there).
  await f.deleteInvoices();
  await f.platform.timeEntry.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.projectTimeSummary.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.notification.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.$executeRaw`DELETE FROM search_index WHERE tenant_id = ${f.tenantId}`;
  await f.platform.workItemActivity.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.workItem.deleteMany({ where: { tenantId: f.tenantId, parentId: { not: null } } });
  await f.platform.workItem.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.workflowState.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.tenantCounter.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.memberProject.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.memberClient.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.project.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.client.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.tenantKey.deleteMany({ where: { tenantId: f.tenantId } });
  await f.cleanup();
}, 120_000);

describe("the rule a client's task names follow, in SQL (namedTaskShared's twin)", () => {
  it("answers as the TypeScript rule does over a matrix of real task trees", async () => {
    const task = async (title: string, opts: { parentId?: string; visibility?: "INTERNAL" | "CLIENT_VISIBLE" } = {}) =>
      (await createItem(owner(), { projectId: acmeP, title: `${title} ${run}`, ...opts })).id;
    const epic = async (title: string) => {
      const id = await task(title, { visibility: "CLIENT_VISIBLE" });
      await f.platform.workItem.update({ where: { id }, data: { type: "EPIC" }, select: { id: true } });
      return id;
    };
    // Live, shared and private; a shared top-level task deleted.
    await task("Live shared", { visibility: "CLIENT_VISIBLE" });
    await task("Live private");
    const deletedTop = await task("Deleted shared top", { visibility: "CLIENT_VISIBLE" });
    await deleteItem(owner(), deletedTop);
    // A shared epic → task → subtask; the subtask deleted: still named.
    const e1 = await epic("Epic kept");
    const t1 = await task("Task kept", { parentId: e1 });
    const s1 = await task("Subtask deleted under shared", { parentId: t1 });
    await deleteItem(owner(), s1);
    // The same, then the epic made private after the deletions: the deleted
    // task (its parent private now) and its deleted subtask (its root private) are not.
    const e2 = await epic("Epic made private");
    const t2 = await task("Task deleted", { parentId: e2 });
    const s2 = await task("Subtask deleted", { parentId: t2 });
    await deleteItem(owner(), s2);
    await deleteItem(owner(), t2);
    await changeItemVisibility(owner(), e2, "INTERNAL");
    // A private task under a shared epic, deleted.
    const e3 = await epic("Epic shared");
    const t3 = await task("Private task deleted", { parentId: e3, visibility: "INTERNAL" });
    await deleteItem(owner(), t3);

    const items = await f.platform.workItem.findMany({
      where: { tenantId: f.tenantId },
      select: { id: true, visibility: true, deletedAt: true, parentId: true, rootId: true },
    });
    expect(items.length).toBeGreaterThanOrEqual(13);
    const ts = await asMember(f.seats.admin.memberId, (tx) => sharedTasks(tx, f.tenantId, items));
    const sql = await asMember(f.seats.admin.memberId, (tx) =>
      tx.$queryRaw<{ id: string; named: boolean }[]>`
        SELECT w.id, work_item_named_to_client(${f.tenantId}, w.id) AS named FROM work_item w WHERE w.tenant_id = ${f.tenantId}`,
    );
    expect(sql).toHaveLength(items.length);
    for (const r of sql) expect(r.named, r.id).toBe(ts.has(r.id));
    // The matrix holds both answers, and the cases named above say what they should.
    expect(ts.has(deletedTop) && ts.has(s1) && ts.has(t1)).toBe(true);
    expect(ts.has(t2) || ts.has(s2) || ts.has(t3)).toBe(false);
    const missing = await asMember(f.seats.admin.memberId, (tx) =>
      tx.$queryRaw<{ named: boolean }[]>`SELECT work_item_named_to_client(${f.tenantId}, ${randomUUID()}) AS named`,
    );
    expect(missing[0]!.named).toBe(false);
  });
});

describe("the page (C80 (d), C81)", () => {
  it("is one row per line, day and printed task — a private task and an hour with no task are “Other work”, nobody is named", async () => {
    const d1 = "2026-08-03";
    const d2 = "2026-08-04";
    const ids = [
      await hour(acmeP, d1, { workItemId: sharedTask, seconds: 1800 }),
      await hour(acmeP, d1, { workItemId: sharedTask, seconds: 900, memberId: f.seats.manager.memberId }),
      await hour(acmeP, d1, { workItemId: privateTask, seconds: 600 }),
      await hour(acmeP, d1, { seconds: 1200 }),
      await hour(acmeP, d2, { workItemId: sharedTask, seconds: 3600 }),
      // Support rounds each entry: 5 minutes bill 30 (its minimum).
      await hour(roundP, d2, { seconds: 300 }),
    ];
    const invoiceId = await draftFrom(ids, true);
    const lines = await f.platform.invoiceLine.findMany({ where: { invoiceId }, orderBy: { position: "asc" }, select: { id: true, description: true } });
    expect(lines.map((l) => l.description)).toEqual([`Support ${run}`, `Webshop ${run}`]);
    const text = await asMember(f.seats.admin.memberId, (tx) => readLiveHoursPageText(tx, f.tenantId, invoiceId));
    const page = JSON.parse(text!) as PageJson;
    expect(page).toEqual({
      version: 1,
      lines: [
        { lineId: lines[0]!.id, rows: [{ date: d2, task: null, seconds: 1800 }] },
        {
          lineId: lines[1]!.id,
          rows: [
            { date: d1, task: `Checkout redesign ${run}`, seconds: 2700 },
            { date: d1, task: null, seconds: 1800 },
            { date: d2, task: `Checkout redesign ${run}`, seconds: 3600 },
          ],
        },
      ],
    });
    // Never a person, a note or a private title.
    const people = await f.platform.member.findMany({ where: { tenantId: f.tenantId }, select: { user: { select: { name: true } } } });
    expect(people.length).toBeGreaterThan(1);
    for (const p of people) if (p.user.name?.trim()) expect(text).not.toContain(p.user.name.trim());
    expect(text).not.toContain("Meeting notes");
    expect(text).not.toContain("A note nobody");
    expect(text).not.toContain("Fix the mess");
    // The draft page shows the same, as printed.
    const view = await getInvoice(admin(), invoiceId);
    expect(view.includeHours).toBe(true);
    expect(view.hoursPage?.lines.map((l) => [l.description, l.seconds, l.quantity])).toEqual([
      [`Support ${run}`, 1800, 500n],
      [`Webshop ${run}`, 8100, 2_250n],
    ]);
    expect(view.hoursPage?.withSeconds).toBe(false);
  });

  it("is written BY THE DATABASE at issue — what the draft showed — and frozen; unticked, none", async () => {
    const a = await hour(acmeP, "2026-08-05", { workItemId: sharedTask });
    const b = await hour(acmeP, "2026-08-06");
    const ticked = await draftFrom([a], true);
    const shown = await asMember(f.seats.admin.memberId, (tx) => readLiveHoursPageText(tx, f.tenantId, ticked));
    // A draft never carries a page, whatever is written to it.
    expect(
      await refusal(asMember(f.seats.admin.memberId, (tx) => tx.$executeRaw`UPDATE invoice SET hours_page = ${shown}::jsonb WHERE id = ${ticked}`)),
    ).toBe("invoice_hours_page_issued");
    await issueInvoice(admin(), ticked);
    // Byte for byte: the text the draft showed is the text frozen.
    const frozen = await f.platform.$queryRaw<{ page: string | null }[]>`SELECT hours_page::text AS page FROM invoice WHERE id = ${ticked}`;
    expect(frozen[0]!.page).toBe(shown);
    expect((await f.audits("invoice.issued")).at(-1)?.metadata).toMatchObject({ hoursPage: { lines: 1, rows: 1 } });
    // Frozen with everything else.
    for (const write of [
      (tx: TenantDb) => tx.$executeRaw`UPDATE invoice SET hours_page = NULL WHERE id = ${ticked}`,
      (tx: TenantDb) => tx.$executeRaw`UPDATE invoice SET include_hours = false WHERE id = ${ticked}`,
    ]) {
      expect(await refusal(asMember(f.seats.owner.memberId, write))).toBe("INVOICE_NOT_DRAFT");
    }
    // The issued invoice reads it back from the record.
    const issued = await getInvoice(admin(), ticked);
    expect(issued.hoursPage?.lines[0]?.rows).toEqual([{ date: "2026-08-05", task: `Checkout redesign ${run}`, seconds: 3600 }]);
    expect(issued.issued?.print.hoursPage).toEqual(issued.hoursPage);

    const plain = await draftFrom([b], false);
    await issueInvoice(admin(), plain);
    expect(await storedPage(plain)).toBeNull();
    expect((await getInvoice(admin(), plain)).hoursPage).toBeNull();
  });

  it("prints a task as it is AT ISSUE — renamed, or made private since it was added — and the change is “look again”", async () => {
    const renamed = (await createItem(owner(), { projectId: acmeP, title: `Old name ${run}`, visibility: "CLIENT_VISIBLE" })).id;
    const hidden = (await createItem(owner(), { projectId: acmeP, title: `Soon private ${run}`, visibility: "CLIENT_VISIBLE" })).id;
    const a = await hour(acmeP, "2026-08-07", { workItemId: renamed });
    const b = await hour(acmeP, "2026-08-07", { workItemId: hidden });
    const id = await draftFrom([a, b], true);
    const before = await asMember(f.seats.admin.memberId, (tx) => readIssueCheck(tx, f.tenantId, id));
    await updateItemFields(owner(), renamed, { title: `New name ${run}` });
    await changeItemVisibility(owner(), hidden, "INTERNAL");
    expect(await outcome(issueInvoice(admin(), id, { fingerprint: before.fingerprint }))).toBe("INVOICE_CHANGED");
    const now = await asMember(f.seats.admin.memberId, (tx) => readIssueCheck(tx, f.tenantId, id));
    await issueInvoice(admin(), id, { fingerprint: now.fingerprint });
    const page = await storedPage(id);
    expect(page?.lines[0]?.rows).toEqual([
      { date: "2026-08-07", task: `New name ${run}`, seconds: 3600 },
      { date: "2026-08-07", task: null, seconds: 3600 },
    ]);
    expect(JSON.stringify(page)).not.toContain("Soon private");
  });

  it("the tick changes the fingerprint too", async () => {
    const id = await draftFrom([await hour(acmeP, "2026-08-08")], false);
    const off = await asMember(f.seats.admin.memberId, (tx) => readIssueCheck(tx, f.tenantId, id));
    await updateDraftDetails(admin(), id, { includeHours: true });
    expect(await outcome(issueInvoice(admin(), id, { fingerprint: off.fingerprint }))).toBe("INVOICE_CHANGED");
  });

  it("is an invoice's only: a credit note refuses the tick, in the service and in the database", async () => {
    const id = await draftFrom([await hour(acmeP, "2026-08-09")], true);
    await issueInvoice(admin(), id);
    const cn = await createCreditDraft(admin(), id, { reason: "Wrong hours" });
    expect(await outcome(updateDraftDetails(admin(), cn, { includeHours: true }))).toBe("INVALID_INPUT");
    expect(await refusal(asMember(f.seats.admin.memberId, (tx) => tx.$executeRaw`UPDATE invoice SET include_hours = true WHERE id = ${cn}`))).toBe(
      "invoice_include_hours_kind",
    );
    // The service takes a boolean only.
    expect(await outcome(updateDraftDetails(admin(), cn, { includeHours: "yes" }))).toBe("INVALID_INPUT");
  });

  it("the corrected copy keeps the tick — and bills, and prints, the same hours", async () => {
    const a = await hour(acmeP, "2026-08-10", { workItemId: sharedTask });
    const id = await draftFrom([a], true);
    await issueInvoice(admin(), id);
    const { copyId } = await creditInFull(admin(), id, { reason: "Wrong price", correctedCopy: true });
    const copy = await getInvoice(admin(), copyId!);
    expect(copy.includeHours).toBe(true);
    expect(copy.hoursPage?.lines[0]?.rows).toEqual([{ date: "2026-08-10", task: `Checkout redesign ${run}`, seconds: 3600 }]);
  });

  it("the issue itself never changes the tick — the database refuses it before the number is taken", async () => {
    const id = await draftFrom([await hour(acmeP, "2026-08-11")], true);
    expect(
      await refusal(asMember(f.seats.admin.memberId, (tx) => tx.$executeRaw`UPDATE invoice SET status = 'ISSUED', include_hours = false WHERE id = ${id}`)),
    ).toBe("the time breakdown is the draft");
  });

  it("a line whose quantity was edited bills another number of hours than its breakdown shows: a caution, never a blocker", async () => {
    // (A corrected copy cannot get there: `creditInFull` refuses once any part
    // was credited, and only then are hours returned by hand.)
    const id = await draftFrom([await hour(acmeP, "2026-08-12"), await hour(acmeP, "2026-08-13")], true);
    const [line] = await f.platform.invoiceLine.findMany({ where: { invoiceId: id }, orderBy: { position: "asc" } });
    const before = await asMember(f.seats.admin.memberId, (tx) => readIssueCheck(tx, f.tenantId, id));
    expect(before.hoursPageDiffers).toEqual([]);
    await updateLine(admin(), id, line!.id, { quantity: "1" });
    const check = await asMember(f.seats.admin.memberId, (tx) => readIssueCheck(tx, f.tenantId, id));
    expect(check.blockers).toEqual([]);
    expect(check.hoursPageDiffers).toEqual([line!.position]);
  });
});

describe("a task title that reads like somewhere to pay (the security review's low)", () => {
  it("is cautioned in the issue dialog when the breakdown would print it — and only then", async () => {
    const task = (await createItem(owner(), { projectId: acmeP, title: `Betala till bankgiro 5555-1234 ${run}`, visibility: "CLIENT_VISIBLE" })).id;
    const id = await draftFrom([await hour(acmeP, "2026-08-20", { workItemId: task })], false);
    const off = await asMember(f.seats.admin.memberId, (tx) => readIssueCheck(tx, f.tenantId, id));
    expect(off.paymentText).toBe(false);
    await updateDraftDetails(admin(), id, { includeHours: true });
    const on = await asMember(f.seats.admin.memberId, (tx) => readIssueCheck(tx, f.tenantId, id));
    expect(on.paymentText).toBe(true);
    // The tick's direction is in the trail (the security review's nit).
    expect((await f.audits("invoice.draft_edited")).filter((a) => a.targetId === id).at(-1)?.metadata).toMatchObject({
      fields: ["includeHours"],
      includeHours: true,
    });
  });
});

describe("odd titles, and the PDF itself", () => {
  it("a title of only Unicode spaces is “Other work”; long emoji, quotes and a newline print — through the function, the strict reader and the drawing", async () => {
    const ch = (...codes: number[]) => String.fromCharCode(...codes);
    const titles = [
      ch(0xa0, 0x3000),
      ch(9),
      "🙂".repeat(450),
      `Line${ch(10)}break "quoted" ${ch(92)} ${ch(0x200f)}שלום`,
    ];
    const ids: string[] = [];
    for (const [i, title] of titles.entries()) {
      const task = (await createItem(owner(), { projectId: acmeP, title: `Odd ${i} ${run}`, visibility: "CLIENT_VISIBLE" })).id;
      await f.platform.workItem.update({ where: { id: task }, data: { title }, select: { id: true } });
      ids.push(await hour(acmeP, `2026-08-${String(14 + i).padStart(2, "0")}`, { workItemId: task }));
    }
    const id = await draftFrom(ids, true);
    await issueInvoice(admin(), id);
    const read = await asMember(f.seats.admin.memberId, (tx) => readIssuedInvoice(tx, f.tenantId, id, { strict: true }));
    const tasks = read!.print.hoursPage!.lines.flatMap((l) => l.rows.map((r) => r.task));
    expect(tasks).toContain(titles[2]); // 450 emoji: 900 UTF-16 units, under the 500-code-point cut
    expect(tasks).toContain(titles[3]);
    // Only spaces (NBSP, ideographic) and a lone tab: the SQL trims them to nothing — both “Other work”.
    expect(tasks.filter((t) => t === null)).toHaveLength(2);
    // …and the jobs sweep (as SYSTEM) draws it: at least two pages — the invoice's and the breakdown's.
    const made = await makeMissingInvoicePdfs(f.tenantId, new Date(Date.now() + 10 * 60_000));
    expect(made.failed).toBe(0);
    const row = await f.platform.invoice.findUniqueOrThrow({ where: { id }, select: { pdfFileId: true } });
    const file = await f.platform.fileObject.findUniqueOrThrow({ where: { id: row.pdfFileId! } });
    const bytes = readFileSync(join(storageDir, file.r2Key));
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(bytes.toString("latin1").match(/\/Type\s*\/Page\b/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect((await f.audits("invoice.pdf_generated")).find((a) => a.targetId === id)?.metadata).toMatchObject({ templateVersion: 3 });
  });
});

