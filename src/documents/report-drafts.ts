import { resolveScope, type MemberActor } from "@/authz/authorize";
import { withTenant, type TenantDb } from "@/db";
import { accessibleCodes, moduleOpenUnderSystem } from "@/entitlements/resolver";
import { DomainError, isUniqueViolation } from "@/lib/domain-error";
import { localDateString } from "@/lib/duration";
import { invoiceLocaleFor } from "@/modules/invoicing/print";
import { emit } from "@/notify/emit";
import { reasonsFor, type NotificationReason } from "@/notify/reasons";
import { synthesiseContactPrincipal } from "@/portal";
import { readPreferences } from "@/preferences/service";

import { audienceContact, deriveAsAudience } from "./made-report-check";
import { MADE_REPORT_MAX_PROJECTS, type MadeReportContent } from "./made-report-content";
import { errorTag, fileMadeReport } from "./made-reports";
import { DRAFT_CLIENT_CAP, DRAFT_MAX_ATTEMPTS, isEmptyContent, type DraftOutcome } from "./report-drafts-rules";
import { defaultReportMonth, reportMonthDate } from "./report-month";

/**
 * REPORTS DRAFTED BY THEMSELVES ON THE 1ST (Phase 7 slice 120; founder
 * decision C96; design docs/research/2026-10-15-slice-120-report-drafts-design.md
 * §2). Run per tenant by `src/jobs/report-drafts.ts` under THIS tenant's
 * SYSTEM principal, RLS live. For the month that just ended in the
 * workspace's zone, every ACTIVE client is CONSIDERED once:
 *
 *   EXISTS       a live REPORT for the month is already there (uploaded,
 *                made by hand, or drafted) — one report a month, whoever
 *                made it (C96 (a));
 *   NO_AUDIENCE  nobody at the client could sign in (slice 119's R1 — there
 *                is nobody to read it as);
 *   EMPTY        no project shown in the portal, or none with a finished
 *                task or a published update in the month (C96 (a));
 *   TOO_LARGE    over the drawing's ceilings (slice 119's R6 — the button,
 *                with fewer projects ticked, is the way);
 *   DRAFTED      the report the button would make, with every maker column
 *                NULL (`fileMadeReport`, madeBy null), audited as SYSTEM,
 *                and ONE inbox notice `report.drafted` (C96 (c));
 *   FAILED       the drawing, the upload or the write threw — tried again on
 *                later kicks up to `DRAFT_MAX_ATTEMPTS`, then left.
 *
 * THE LEDGER (`monthly_report_draft`, class A, design R4): one row per
 * client and month, so nothing is derived twice — deciding EMPTY costs a
 * derivation as the client's own contact. A DRAFTED row is written IN THE
 * SAME TRANSACTION as the draft, so two kicks over one client and month
 * cannot both file (the UNIQUE key; the loser's write rolls back whole, its
 * blob deleted, counted as `decidedElsewhere`). Every other outcome is its
 * own short transaction. The ledger is the job's own record and NOT
 * audited — the draft's `document.created` is (the fan-out's legs'
 * precedent).
 *
 * WHOSE VIEW, WHICH LANGUAGE, WHICH PROJECTS: the button's own defaults
 * (design R2) — the narrowest contact who could sign in, the client's
 * invoice language, every project the client sees in their portal, by
 * name. No summary, no "Coming next": those are the team's words, added by
 * making the month again (C96 (d), `makeReport`).
 *
 * THE WRITE TRANSACTION RE-ASKS THE WORKSPACE'S GATES (there is no member
 * to ask): the reports module open, the switch on, the client ACTIVE — and
 * "no live REPORT for the month" once more (the migration review's L1: a
 * member pressing Make a report while this derives must not end with two).
 *
 * WHO IS TOLD (design R6): every ACTIVE member who, checked as THEMSELVES,
 * holds the Reports tab's and the publish verb's codes on all four gates
 * and reaches the client DIRECTLY — tenant-wide, or assigned to the client
 * itself (CLIENT_MEMBER); a tenant-wide one hears it as REPORT_ACCESS.
 * Nobody → the draft is still made (it waits on the tab).
 *
 * BOUNDED (design R7): the caller's deadline; at most `DRAFT_CLIENT_CAP`
 * clients a kick per workspace (the rest next kick — the ledger makes it
 * resumable). One client's failure never stops the next. Reads in SEQUENCE
 * on every transaction (AGENTS.md's `Promise.all` trap); the receivers
 * resolved per member in their own transactions.
 */

const SYSTEM = { type: "system" } as const;

/** The codes a receiver needs: the tab's (`listClientReports`) and the publish verb's (`publishReport`). */
const RECEIVER_CODES = ["document:view", "report:view", "document:change_visibility", "report:upload"] as const;

export type DraftRun = {
  /** `YYYY-MM-01` — the month drafted (the one before the workspace's current month); null when nothing ran. */
  readonly month: string | null;
  /** Clients looked at this kick. */
  readonly considered: number;
  readonly drafted: number;
  readonly byOutcome: Readonly<Record<DraftOutcome, number>>;
  /** Clients another kick decided meanwhile (the ledger's UNIQUE key refused ours). */
  readonly decidedElsewhere: number;
  /** The reports module is closed to the tenant: nothing looked at. */
  readonly closed: boolean;
  /** The switch is off: nothing looked at, nothing recorded. */
  readonly off: boolean;
  /** The deadline cut the loop; the rest are considered next kick. */
  readonly outOfTime: boolean;
};

/** Thrown inside the write transaction when a report for the month appeared meanwhile (the review's L1). */
class ReportExistsNow extends Error {
  constructor() {
    super("a report for the month exists now");
    this.name = "ReportExistsNow";
  }
}

type Candidate = {
  readonly id: string;
  readonly name: string;
  readonly invoiceLocale: string | null;
  readonly countryCode: string | null;
  /** The FAILED row to update, when this is a retry. */
  readonly failedRow: { readonly id: string; readonly attempts: number } | null;
};

/** A live REPORT document of the client for the month — any maker. */
const liveReportForMonth = (tx: TenantDb, clientId: string, month: string) =>
  tx.document.findFirst({
    where: { clientId, kind: "REPORT", deletedAt: null, reportMonth: reportMonthDate(month) },
    select: { id: true },
  });

/**
 * The receivers of a client's notice — resolved once per member per run
 * (the renewals' resolver, slice 113b): each member's codes and scope read
 * as themselves, in their own transaction.
 */
function receiverResolver(tenantId: string): (clientId: string) => Promise<Map<string, NotificationReason>> {
  type Who = { readonly publishes: boolean; readonly all: boolean; readonly direct: readonly string[] };
  let members: string[] | null = null;
  const memo = new Map<string, Who>();
  return async (clientId) => {
    if (members === null) {
      members = await withTenant(tenantId, SYSTEM, async (tx) =>
        (await tx.member.findMany({ where: { tenantId, status: "ACTIVE" }, select: { id: true }, orderBy: { id: "asc" } })).map((m) => m.id),
      );
    }
    const assigned: string[] = [];
    const publishers: string[] = [];
    // In turn: each resolution is a transaction of its own (AGENTS.md's trap).
    for (const memberId of members) {
      let who = memo.get(memberId);
      if (!who) {
        const actor: MemberActor = { memberId };
        who = await withTenant(tenantId, SYSTEM, async (tx) => {
          const codes = await accessibleCodes(tx, tenantId, actor, RECEIVER_CODES);
          const scope = await resolveScope(tx, actor);
          return { publishes: RECEIVER_CODES.every((c) => codes.has(c)), all: scope.all, direct: scope.all ? [] : scope.directClientIds };
        });
        memo.set(memberId, who);
      }
      if (!who.publishes) continue;
      // DIRECT reach only (the Reports tab's rule): tenant-wide, or assigned to
      // the client itself — a member reaching it through a project is not told.
      if (who.all) publishers.push(memberId);
      else if (who.direct.includes(clientId)) assigned.push(memberId);
    }
    return reasonsFor([
      ["CLIENT_MEMBER", assigned],
      ["REPORT_ACCESS", publishers],
    ]);
  };
}

export async function draftMonthlyReports(
  tenantId: string,
  now: Date = new Date(),
  opts: { readonly deadline?: number; readonly clientCap?: number } = {},
): Promise<DraftRun> {
  const deadline = opts.deadline ?? Number.POSITIVE_INFINITY;
  const clientCap = opts.clientCap ?? DRAFT_CLIENT_CAP;
  const byOutcome: Record<DraftOutcome, number> = { DRAFTED: 0, EXISTS: 0, NO_AUDIENCE: 0, EMPTY: 0, TOO_LARGE: 0, FAILED: 0 };
  const out = { month: null as string | null, considered: 0, drafted: 0, byOutcome, decidedElsewhere: 0, closed: false, off: false, outOfTime: false };

  // 1. The workspace's gates and the list — one system transaction, in sequence.
  const prep = await withTenant(tenantId, SYSTEM, async (tx) => {
    if (!(await reportsOpen(tx, tenantId))) return { closed: true as const };
    const prefs = await readPreferences(tx, tenantId);
    if (!prefs.reports.draftMonthly) return { off: true as const };
    const today = localDateString(now, prefs.timezone);
    const month = defaultReportMonth(today);
    const tenant = await tx.tenant.findFirst({ where: { id: tenantId }, select: { name: true } });
    // Clients not yet DECIDED for the month: no ledger row, or a FAILED one
    // with tries left. `none` over "a row that settles it".
    const clients = await tx.client.findMany({
      where: {
        status: "ACTIVE",
        archivedAt: null,
        monthlyReportDrafts: {
          none: { month: reportMonthDate(month), OR: [{ outcome: { not: "FAILED" } }, { attempts: { gte: DRAFT_MAX_ATTEMPTS } }] },
        },
      },
      select: {
        id: true,
        name: true,
        invoiceLocale: true,
        countryCode: true,
        monthlyReportDrafts: { where: { month: reportMonthDate(month), outcome: "FAILED" }, select: { id: true, attempts: true }, take: 1 },
      },
      orderBy: { id: "asc" },
      take: clientCap,
    });
    const candidates: Candidate[] = clients.map((c) => ({
      id: c.id,
      name: c.name,
      invoiceLocale: c.invoiceLocale,
      countryCode: c.countryCode,
      failedRow: c.monthlyReportDrafts[0] ?? null,
    }));
    return { closed: false as const, off: false as const, today, month, timezone: prefs.timezone, agencyName: tenant?.name ?? "", candidates };
  });
  if ("closed" in prep && prep.closed) return { ...out, closed: true };
  if ("off" in prep && prep.off) return { ...out, off: true };
  if (!("candidates" in prep)) return out;
  out.month = prep.month;
  const { month, today, timezone, agencyName } = prep;
  const receiversOf = receiverResolver(tenantId);

  /**
   * The ledger's verdict for a client — its own transaction. False when another
   * kick decided meanwhile: the INSERT met the UNIQUE key, or the FAILED row the
   * retry set out from is no longer that row (the compare-and-set on its
   * outcome and attempts — the reviews' low: the key guards the INSERT path
   * only).
   */
  const decide = async (client: Candidate, outcome: Exclude<DraftOutcome, "DRAFTED">): Promise<boolean> => {
    try {
      return await withTenant(tenantId, SYSTEM, async (tx) =>
        client.failedRow ? writeRetryVerdict(tx, client.failedRow, { outcome, now }) : (await createVerdict(tx, tenantId, client.id, month, outcome, null, now), true),
      );
    } catch (e) {
      if (isUniqueViolation(e) && client.failedRow === null) return false;
      throw e;
    }
  };

  // 2. Per client, in sequence, while time remains.
  for (const client of prep.candidates) {
    if (Date.now() >= deadline) {
      out.outOfTime = true;
      break;
    }
    out.considered += 1;
    try {
      const outcome = await draftOne(tenantId, client, { month, today, timezone, agencyName, now, receiversOf });
      if (outcome === "DRAFTED") {
        byOutcome.DRAFTED += 1;
        out.drafted += 1;
      } else if (outcome === null) {
        // A gate closed between the facts and the write (the switch, the
        // modules, the client archived): nothing to record — the next kick's
        // prep answers for the workspace (the code review's nit).
      } else if (await decide(client, outcome)) {
        byOutcome[outcome] += 1;
      } else {
        out.decidedElsewhere += 1;
      }
    } catch (e) {
      if (e instanceof DecidedElsewhere || (isUniqueViolation(e) && client.failedRow === null)) {
        // The draft's write met the ledger's key, or the retry's row had moved
        // on: another kick decided it first; the write rolled back whole.
        out.decidedElsewhere += 1;
        continue;
      }
      console.error(`report-drafts: tenant ${tenantId} client ${client.id} failed: ${errorTag(e)}`);
      try {
        if (await decide(client, "FAILED")) byOutcome.FAILED += 1;
        else out.decidedElsewhere += 1;
      } catch (e2) {
        // The ledger itself refused: counted, logged, retried next kick (no row).
        byOutcome.FAILED += 1;
        console.error(`report-drafts: tenant ${tenantId} client ${client.id} ledger write failed: ${errorTag(e2)}`);
      }
    }
  }
  return out;
}

/** Thrown when the retry's compare-and-set took nothing: another kick decided the client meanwhile. */
class DecidedElsewhere extends Error {
  constructor() {
    super("another kick decided this client and month");
    this.name = "DecidedElsewhere";
  }
}

/** Thrown inside the write transaction when a workspace gate closed between the facts and the write. */
class GateClosed extends Error {
  constructor(which: string) {
    super(`report-drafts: ${which} closed meanwhile`);
    this.name = "GateClosed";
  }
}

const createVerdict = (tx: TenantDb, tenantId: string, clientId: string, month: string, outcome: DraftOutcome, documentId: string | null, now: Date) =>
  tx.monthlyReportDraft.create({
    data: { tenantId, clientId, month: reportMonthDate(month), outcome, documentId, attempts: 1, decidedAt: now },
    select: { id: true },
  });

/**
 * The retry's verdict onto its FAILED row — a COMPARE-AND-SET on the outcome
 * and the attempts it set out from, so two kicks over one FAILED row cannot
 * both write (the reviews' low). Zero rows taken = another kick got there:
 * false for a verdict, a throw for a draft (its transaction must roll back).
 */
async function writeRetryVerdict(
  tx: TenantDb,
  failedRow: { readonly id: string; readonly attempts: number },
  verdict: { readonly outcome: DraftOutcome; readonly documentId?: string; readonly now: Date },
): Promise<boolean> {
  const r = await tx.monthlyReportDraft.updateMany({
    where: { id: failedRow.id, outcome: "FAILED", attempts: failedRow.attempts },
    data: {
      outcome: verdict.outcome,
      documentId: verdict.documentId ?? null,
      // A retry that failed again counts; one that reached a verdict keeps its count.
      attempts: verdict.outcome === "FAILED" ? Math.min(failedRow.attempts + 1, DRAFT_MAX_ATTEMPTS) : failedRow.attempts,
      decidedAt: verdict.now,
    },
  });
  return r.count === 1;
}

/** Both modules a team member needs to open the Reports tab (AUTHZ §3: every report verb asks a `document:*` code too). */
async function reportsOpen(tx: TenantDb, tenantId: string): Promise<boolean> {
  if (!(await moduleOpenUnderSystem(tx, tenantId, "reports"))) return false;
  return moduleOpenUnderSystem(tx, tenantId, "documentation");
}

/** One client: the facts, the derivation as the contact, the draft — or a named outcome. */
async function draftOne(
  tenantId: string,
  client: Candidate,
  run: {
    readonly month: string;
    readonly today: string;
    readonly timezone: string;
    readonly agencyName: string;
    readonly now: Date;
    readonly receiversOf: (clientId: string) => Promise<Map<string, NotificationReason>>;
  },
): Promise<DraftOutcome | null> {
  const { month, now } = run;
  // The facts — one system transaction, in sequence.
  const facts = await withTenant(tenantId, SYSTEM, async (tx) => {
    if (await liveReportForMonth(tx, client.id, month)) return { outcome: "EXISTS" as const };
    const contact = await audienceContact(tx, tenantId, client.id);
    if (!contact) return { outcome: "NO_AUDIENCE" as const };
    const projects = await tx.project.findMany({
      where: { clientId: client.id, portalEnabled: true, archivedAt: null },
      select: { id: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
    if (projects.length === 0) return { outcome: "EMPTY" as const };
    if (projects.length > MADE_REPORT_MAX_PROJECTS) return { outcome: "TOO_LARGE" as const };
    return { outcome: null, contact, projectIds: projects.map((p) => p.id) };
  });
  if (facts.outcome) return facts.outcome;

  // As the contact — outside any transaction.
  const principal = await synthesiseContactPrincipal(tenantId, facts.contact);
  let content: MadeReportContent;
  try {
    content = await deriveAsAudience(principal, { month, timezone: run.timezone, projectIds: facts.projectIds });
  } catch (e) {
    if (e instanceof DomainError && e.code === "MADE_REPORT_TOO_LARGE") return "TOO_LARGE";
    if (e instanceof DomainError && e.code === "MADE_REPORT_NO_AUDIENCE") return "NO_AUDIENCE";
    throw e;
  }
  if (isEmptyContent(content)) return "EMPTY";

  // The draft — the button's filing, made by nobody.
  const receivers = await run.receiversOf(client.id);
  try {
    await fileMadeReport({
      tenantId,
      principal: SYSTEM,
      madeBy: null,
      clientId: client.id,
      clientName: client.name,
      agencyName: run.agencyName,
      month,
      locale: invoiceLocaleFor(client),
      today: run.today,
      summary: null,
      comingNext: null,
      projectIds: facts.projectIds,
      contact: facts.contact,
      content,
      now,
      beforeWrite: async (tx) => {
        // The workspace's gates, re-asked where it writes — and "no report for
        // the month" once more, against a member who pressed Make meanwhile.
        if (!(await reportsOpen(tx, tenantId))) throw new GateClosed("the reports module");
        const prefs = await readPreferences(tx, tenantId);
        if (!prefs.reports.draftMonthly) throw new GateClosed("the switch");
        const live = await tx.client.findFirst({ where: { id: client.id, status: "ACTIVE", archivedAt: null }, select: { id: true } });
        if (!live) throw new GateClosed("the client");
        if (await liveReportForMonth(tx, client.id, month)) throw new ReportExistsNow();
      },
      afterWrite: async (tx, documentId) => {
        // The ledger's DRAFTED row — in THIS transaction: the UNIQUE key (a
        // first try) or the compare-and-set on the FAILED row (a retry) is the
        // guard against a second kick; either refusal rolls the draft back.
        if (client.failedRow) {
          if (!(await writeRetryVerdict(tx, client.failedRow, { outcome: "DRAFTED", documentId, now }))) throw new DecidedElsewhere();
        } else {
          await createVerdict(tx, tenantId, client.id, month, "DRAFTED", documentId, now);
        }
        if (receivers.size > 0) {
          await emit(tx, tenantId, {
            kind: "report.drafted",
            entity: { type: "Document", id: documentId },
            clientId: client.id,
            receivers,
            // IDS ONLY (emit's rule); the month is read off the document live.
            params: { clientId: client.id, documentId },
            dedupeKey: `report.drafted:${documentId}`,
          });
        }
      },
    });
  } catch (e) {
    if (e instanceof ReportExistsNow) return "EXISTS";
    if (e instanceof GateClosed) return null;
    throw e;
  }
  return "DRAFTED";
}
