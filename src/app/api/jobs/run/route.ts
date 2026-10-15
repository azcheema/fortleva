import { NextResponse } from "next/server";

import { isProduction } from "@/config";
import { runAgreementRenewals } from "@/jobs/agreement-renewals";
import { runClientDigests } from "@/jobs/client-digests";
import { runContractPdfs } from "@/jobs/contract-pdfs";
import { isCronRequest, secretMatches } from "@/jobs/cron-auth";
import { runMemberDigests } from "@/jobs/digests";
import { runExpirationReminders } from "@/jobs/expiration-reminders";
import { expirePendingUploads } from "@/jobs/expire-pending-uploads";
import { runFortnoxSend } from "@/jobs/fortnox-send";
import { runInvoicePdfs } from "@/jobs/invoice-pdfs";
import { runNotificationRetention } from "@/jobs/notification-retention";
import { drainOutboxKick } from "@/jobs/outbox-kick";
import { runPushes } from "@/jobs/push-sweep";
import { runReportDrafts } from "@/jobs/report-drafts";
import { runSealedAskMail } from "@/jobs/sealed-requests";
import { runBudgetAlerts, runTimeSweep } from "@/jobs/time-sweep";
import { runUpdateReminders } from "@/jobs/update-reminders";
import { runVaultRetention } from "@/jobs/vault-retention";
import { runWebsiteSpeed } from "@/jobs/website-speed";
import { runWeeklyReminders } from "@/jobs/weekly-reminders";

/**
 * Manual job kick (ARC-21 dev fallback): drains the email outbox, runs
 * the 2T timer/shift sweep (12 h / 14 h auto-stops — the reads already
 * settle lazily, this catches members who never came back), the
 * budget-threshold check and the opt-in weekly time reminder (2T D6 —
 * once per member per ISO week, the idempotency key being the whole
 * guard) and the renewal reminders (3V slice 89 — at 60/30/14/7/1 days,
 * once per band, `ExpirationReminderSent` being the guard) and the
 * sealed asks' mail (3V slice 93 — the answerers' reminders, day 3, 6, then
 * daily, and "it has opened"; the ask's own stamps being the guard) and the
 * vault's retention (3V slice 99 — a login 30 days in the bin is erased, a
 * share link's record 12 months after it expired — it DELETES DATA, in every
 * tenant of the database this server points at),
 * and the team's summary email (Phase 5 slice 100 — once per member per
 * period, only in the hours after their own hour; the outbox key the guard)
 * and the clients' weekly summary (slice 101 — once per client person per ISO
 * week, Monday morning in the workspace's time; the outbox key the guard)
 * and the progress-update reminders (slice 102 — the due day and the next
 * two working days, each once, 09:00–17:00 workspace time;
 * `ProjectUpdateReminderSent` the guard) and the inbox's housekeeping (slice
 * 104 — a notification over 90 days old or beyond its receiver's newest 500
 * is archived, an archived one DELETED a year later; the second job here that
 * deletes data, in every tenant), and phone and browser notifications (slice 106
 * — the backstop for a lost kick, SENDING REAL PUSHES to devices registered
 * against this server's key in every tenant, and forgetting device records:
 * gone, refused three times, a member no longer active, 90 days dormant),
 * and the invoice PDFs' backstop (Phase 4 slice 108 — an issued invoice
 * still without its PDF five minutes on gets one; it only adds files),
 * and the agreements' renewals (Phase 4 slices 113, 113b — 14 days before
 * a running recurring agreement renews, its coming period is DRAFTED onto its
 * client's renewal invoice draft and the people who may issue it are told;
 * then its passed renewal date MOVES ON to the next one, unless a started
 * period is still owed a draft — in every sending tenant),
 * and the nightly send to Fortnox (Phase 4 slice 114b — it SENDS VOUCHERS,
 * each with its invoice's PDF, into the Fortnox company of every workspace
 * connected by this deployment, and makes the night's bookkeeping file; while
 * `FORTNOX_TRANSPORT` is off — the default — it does nothing),
 * and the weekly website speed fetch (Phase 6 slice 118 — it ASKS GOOGLE's
 * Chrome UX Report about every measured site, in every sending workspace,
 * about once a week each, and keeps the answers; while `CRUX_TRANSPORT` is
 * off — the default — it does nothing),
 * and the monthly reports drafted by themselves (Phase 7 slice 120 — for
 * the month that just ended, every client with someone in the portal and
 * something to show gets the report the Make a report button would make,
 * private, in every sending workspace whose switch is on; it ADDS a PDF per
 * client per month, deletes nothing),
 * — and, since slice 122 (founder decision C98, going live), Vercel Cron
 * calls it every hour with GET (`vercel.json`), its `CRON_SECRET` the gate;
 * mail additionally leaves every five minutes through `/api/jobs/outbox`.
 * A POST is the manual kick: whenever a JOBS_RUN_TOKEN is configured the
 * caller must present it (constant-time compare); without one the POST
 * exists only outside production (local convenience) — a preview/staging
 * deployment without a token is closed. The proxy lists this path as
 * public: the secret IS the gate.
 */
/** How long the pushes' backstop may go on starting sends, across every workspace. */
const PUSH_BUDGET_MS = 60_000;
/** An upload presigned this long ago and never committed is released (slice 122). */
const PENDING_UPLOAD_MINUTES = 24 * 60;

/**
 * THE FUNCTION'S LIFETIME, declared (slice 103, the code review's medium):
 * with a real transport a send takes real time, and every job below the drain
 * must still run in the same kick. The drain may START sends for its first
 * minute only (`sendUntil`), a pass ends after three failed sends in a row, and
 * the rest of the run is the other jobs'.
 */
// Raised from 300 (slice 122's review): the jobs' own budgets add up to about
// five minutes on a heavy hour, and a kill would skip the last two. 800 is
// Vercel Pro's ceiling with Fluid compute (on by default for new projects;
// RUNBOOK §11 says to keep it on).
export const maxDuration = 800;

const notFound = () => NextResponse.json({ error: "not found" }, { status: 404 });

/** The manual kick: `x-jobs-token`, or — without a configured token — outside production only. */
export async function POST(request: Request): Promise<NextResponse> {
  const token = process.env["JOBS_RUN_TOKEN"];
  if (token ? !secretMatches(request.headers.get("x-jobs-token"), token) : isProduction) return notFound();
  return runAll();
}

/**
 * VERCEL CRON (slice 122, founder decision C98 — going live): the hourly
 * full run (`vercel.json`). Vercel's scheduler calls with GET and
 * `Authorization: Bearer <CRON_SECRET>`; with no secret configured there is
 * no GET caller at all, in any environment (`src/jobs/cron-auth.ts`).
 */
export async function GET(request: Request): Promise<NextResponse> {
  if (!isCronRequest(request)) return notFound();
  return runAll();
}

async function runAll(): Promise<NextResponse> {
  // The drain FIRST, as it always was (`src/jobs/outbox-kick.ts` holds its
  // bounds); the light kick at /api/jobs/outbox runs the same drain every
  // five minutes, so mail never waits for this hourly run.
  const outbox = await drainOutboxKick();
  const timeSweep = await runTimeSweep();
  const budgets = await runBudgetAlerts();
  // Reminders enqueue; the NEXT drain sends them. Draining again here
  // would send this minute's reminder a minute earlier and hide a bug in
  // the queue behind a convenience.
  const weeklyReminders = await runWeeklyReminders();
  const expirationReminders = await runExpirationReminders();
  const sealedAsks = await runSealedAskMail();
  const vaultRetention = await runVaultRetention();
  // Phase 5 slice 100: the team's summary email — enqueued here, sent by the
  // NEXT drain, like the reminders above.
  const digests = await runMemberDigests();
  // Phase 5 slice 101: the clients' weekly summary — Monday morning in each
  // workspace's time, enqueued here and sent by the NEXT drain.
  const clientDigests = await runClientDigests();
  // Phase 5 slice 102: progress-update reminders — on the due day and the
  // next two working days, 09:00–17:00 workspace time; sent by the NEXT drain.
  const updateReminders = await runUpdateReminders();
  // Phase 4 slice 108: an issued invoice's PDF its issue did not make. Its
  // failure is its own.
  let invoicePdfs: Awaited<ReturnType<typeof runInvoicePdfs>> | { failed: "discovery" };
  try {
    invoicePdfs = await runInvoicePdfs();
  } catch (e) {
    const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
    console.error(`jobs: invoice pdfs failed: ${e instanceof Error ? e.name : typeof e}${code}`);
    invoicePdfs = { failed: "discovery" };
  }
  // Phase 4 slice 112b: a sent contract's PDF, or a signed one's copy, that its
  // moment did not make. Its failure is its own.
  let contractPdfs: Awaited<ReturnType<typeof runContractPdfs>> | { failed: "discovery" };
  try {
    contractPdfs = await runContractPdfs();
  } catch (e) {
    const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
    console.error(`jobs: contract pdfs failed: ${e instanceof Error ? e.name : typeof e}${code}`);
    contractPdfs = { failed: "discovery" };
  }
  // Phase 4 slice 113 (C88): agreements' passed renewal dates move on —
  // AFTER the PDF backstops, and within a minute of its own (the security
  // review: it must never hold the route past them). Its failure is its own.
  let agreementRenewals: Awaited<ReturnType<typeof runAgreementRenewals>> | { failed: "discovery" };
  try {
    agreementRenewals = await runAgreementRenewals();
  } catch (e) {
    const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
    console.error(`jobs: agreement renewals failed: ${e instanceof Error ? e.name : typeof e}${code}`);
    agreementRenewals = { failed: "discovery" };
  }
  // Phase 4 slice 114b (C89 (b), (c)): the nightly send to Fortnox — AFTER the
  // invoice PDFs' backstop (a voucher's PDF is attached when it exists) and
  // within 45 seconds of its own. Its failure is its own.
  let fortnoxSend: Awaited<ReturnType<typeof runFortnoxSend>> | { failed: "discovery" };
  try {
    fortnoxSend = await runFortnoxSend();
  } catch (e) {
    const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
    console.error(`jobs: fortnox send failed: ${e instanceof Error ? e.name : typeof e}${code}`);
    fortnoxSend = { failed: "discovery" };
  }
  // Phase 6 slice 118 (C94 (c)): the weekly speed fetch — Google asked about
  // every measured site due this week, within 45 seconds of its own. Its
  // failure is its own.
  let websiteSpeed: Awaited<ReturnType<typeof runWebsiteSpeed>> | { failed: "discovery" };
  try {
    websiteSpeed = await runWebsiteSpeed();
  } catch (e) {
    const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
    console.error(`jobs: website speed failed: ${e instanceof Error ? e.name : typeof e}${code}`);
    websiteSpeed = { failed: "discovery" };
  }
  // Phase 7 slice 120 (C96): the monthly reports drafted by themselves — for
  // the month that just ended, every client with someone in the portal and
  // something to show, in every sending workspace whose switch is on; it
  // adds files, deletes nothing; within 45 seconds of its own. Its failure
  // is its own.
  let reportDrafts: Awaited<ReturnType<typeof runReportDrafts>> | { failed: "discovery" };
  try {
    reportDrafts = await runReportDrafts();
  } catch (e) {
    const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
    console.error(`jobs: report drafts failed: ${e instanceof Error ? e.name : typeof e}${code}`);
    reportDrafts = { failed: "discovery" };
  }
  // Phase 5 slice 106 (founder decision C74): phone and browser notifications —
  // the BACKSTOP for a push whose kick was lost (each is due for fifteen
  // minutes, then never), and the jobs above's own notifications, which their
  // kicks will also try after this response. Then the devices' housekeeping:
  // a device its member is no longer active for, or dormant 90 days, is
  // forgotten. Its failure is its own.
  let pushes: Awaited<ReturnType<typeof runPushes>> | { failed: "discovery" };
  try {
    pushes = await runPushes({ budgetMs: PUSH_BUDGET_MS });
  } catch (e) {
    const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
    console.error(`jobs: pushes failed: ${e instanceof Error ? e.name : typeof e}${code}`);
    pushes = { failed: "discovery" };
  }
  // Slice 122 (going live): an upload presigned a day ago and never committed
  // gives back its storage reservation and its bytes (R:58's "not scheduled
  // yet"). A day, not the PUT URL's fifteen minutes, so no commit in flight is
  // ever raced. Its failure is its own.
  let expiredUploads: Awaited<ReturnType<typeof expirePendingUploads>> | { failed: "discovery" };
  try {
    expiredUploads = await expirePendingUploads(PENDING_UPLOAD_MINUTES);
  } catch (e) {
    const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
    console.error(`jobs: expired uploads failed: ${e instanceof Error ? e.name : typeof e}${code}`);
    expiredUploads = { failed: "discovery" };
  }
  // Phase 5 slice 104: the inbox's housekeeping. LAST, and its failure is its
  // own: every job above has already run and reports below either way.
  let notificationRetention: Awaited<ReturnType<typeof runNotificationRetention>> | { failed: "discovery" };
  try {
    notificationRetention = await runNotificationRetention();
  } catch (e) {
    const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
    console.error(`jobs: notification retention failed: ${e instanceof Error ? e.name : typeof e}${code}`);
    notificationRetention = { failed: "discovery" };
  }
  return NextResponse.json({
    outbox,
    timeSweep,
    budgets,
    weeklyReminders,
    expirationReminders,
    sealedAsks,
    vaultRetention,
    digests,
    clientDigests,
    updateReminders,
    agreementRenewals,
    fortnoxSend,
    websiteSpeed,
    reportDrafts,
    invoicePdfs,
    contractPdfs,
    pushes,
    expiredUploads,
    notificationRetention,
  });
}
