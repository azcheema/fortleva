import { record } from "@/audit/record";
import { requireRecentMfa, resolvePermissions, resolveScope } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { fortnoxClientId } from "@/config";
import { withTenant, type TenantDb } from "@/db";
import { hasAccess, requireAccess } from "@/entitlements/resolver";
import {
  codeChallengeOf,
  fakeCompanyTenantIdFor,
  fortnoxTransport,
  isFortnoxError,
  isStateShape,
  newPkceVerifier,
  newState,
  stateHashOf,
  type FortnoxCompany,
  type FortnoxTransport,
} from "@/integrations/fortnox";
import { fail, isDeadlock, isLockTimeout } from "@/lib/domain-error";
import { todayIn } from "@/lib/due-date";
import { INTEGRATION_CONNECTED_MAIL, INTEGRATION_DISCONNECTED_MAIL } from "@/notify/integration-mail-keys";
import { readPreferences } from "@/preferences/service";
import { allowStrict } from "@/ratelimit";

import { EXPORT_LOCK_WAIT_MS, EXPORT_TX_TIMEOUT_MS, pendingForFiles, readBookkeepingSettings } from "./bookkeeping";
import { ACCOUNT_ROLES, methodOf, type AccountRole } from "./bookkeeping-accounts";
import type { InvoicingCtx } from "./drafts";
import { errorTag } from "./pdf-store";
import { INVOICE_DETAILS_STEP_UP_MINUTES, noticeToOwners, readSeller } from "./seller";
import { normalizeOrgNr } from "./seller-fields";

/**
 * THE DIRECT FORTNOX CONNECTION, part 1 — connecting (Phase 4 slice 114;
 * founder decision C89; docs/research/2026-10-12-slice-114-fortnox-connection-
 * design.md, §10 overriding the body, §11 its code reviews). Nothing here
 * SENDS anything to Fortnox's books: the nightly send is slice 114b.
 *
 * A workspace's OWNER (`invoice:connect_bookkeeping`, ✦, seeded C — with a
 * TENANT-WIDE client scope: the connection decides where every client's
 * invoices go) presses Connect with their authenticator code TYPED IN THE FORM
 * (C89 (d) — the bank details' one-minute window): `beginFortnoxConnect`
 * writes an ATTEMPT (the OAuth state as its SHA-256, the PKCE verifier) and
 * answers Fortnox's consent screen, where one of the company's system
 * administrators approves a SERVICE ACCOUNT. Fortnox sends the browser back to
 * the callback, which `completeFortnoxConnect` serves:
 *
 *   1. the attempt SPENT — ONE compare-and-set, of this member, unspent,
 *      unexpired (the design review's S12): a forged or replayed callback
 *      finds nothing (EXPIRED);
 *   2. the code exchanged for an access token (the refresh token dropped
 *      unread); the company asked who it is; the token's own TenantId claim
 *      checked against its DatabaseNumber (S10);
 *   3. ITS ORG. NUMBER MUST BE THE WORKSPACE'S (the company card's), both
 *      normalised; empty, missing or unreadable on either side is a mismatch
 *      (S6) — the guard against connecting the wrong company;
 *   4. a FRESH service token asked for that TenantId (client credentials,
 *      never the cache — proves the consent is a service account's NOW) and the
 *      company asked again with it (binding the token to the same company);
 *   5. in ONE member transaction — the gates, then the bookkeeping file's lock
 *      (bounded, as every maker takes it) — the attempt's outcome, then the
 *      connection: new (CONNECTED), or the workspace's BROKEN one to the same
 *      company back to ACTIVE (RECONNECTED; R2) — audited, every active owner
 *      mailed.
 *
 * EVERY END AFTER THE SPEND IS THE ATTEMPT'S OUTCOME, exactly once: each
 * refusal (`seen_*` naming the company when it was the wrong one), and any
 * failure at all — a gate that closed during the minute at Fortnox, a lock
 * held too long (BUSY), a bug — as FAILED; audited `integration.connect_refused`
 * (S7, the code reviews' 1/2). The card renders it from the viewer's OWN
 * attempt row — never from the URL (S9). The database holds every rule that
 * matters (`integration_connection_guard`, `integration_connect_attempt_guard`,
 * migration 20261019090000).
 *
 * Impersonation never connects, finishes, checks or disconnects (S11).
 */

export type ConnectOutcome =
  | "CONNECTED"
  | "RECONNECTED"
  | "DENIED"
  | "NO_LICENCE"
  | "NO_ORG_NR"
  | "ORG_MISMATCH"
  | "NOT_SERVICE"
  | "ELSEWHERE"
  | "OTHER_COMPANY"
  | "ALREADY"
  | "BUSY"
  | "FAILED";

type Refusal = Exclude<ConnectOutcome, "CONNECTED" | "RECONNECTED">;

const CONNECT_OUTCOMES: ReadonlySet<string> = new Set<ConnectOutcome>([
  "CONNECTED",
  "RECONNECTED",
  "DENIED",
  "NO_LICENCE",
  "NO_ORG_NR",
  "ORG_MISMATCH",
  "NOT_SERVICE",
  "ELSEWHERE",
  "OTHER_COMPANY",
  "ALREADY",
  "BUSY",
  "FAILED",
]);

/** How long the callback may spend asking Fortnox (four calls). */
const CALLBACK_BUDGET_MS = 60_000;
/** How long the check may spend (a dozen calls). */
const CHECK_BUDGET_MS = 45_000;
/** A finished attempt is shown on the card for this long after it was spent. */
const OUTCOME_SHOWN_MS = 15 * 60_000;
/** The cross-workspace unique (the design review's Q1): a second workspace on one company. */
const LIVE_PER_COMPANY = "integration_connection_live_per_company";
/** The bookkeeping file's lock, bounded as every maker takes it (the code review's 3). */
const LOCKED = { lockTimeoutMs: EXPORT_LOCK_WAIT_MS, timeoutMs: EXPORT_TX_TIMEOUT_MS } as const;

const memberPrincipal = (ctx: InvoicingCtx) => ({ type: "member", id: ctx.actor.memberId }) as const;

const refuseImpersonation = (ctx: InvoicingCtx): void => {
  if (ctx.actor.impersonated) deny("FORBIDDEN", "impersonation never connects the bookkeeping program");
};

/** The transport, or FORTNOX_UNAVAILABLE (`FORTNOX_TRANSPORT` is off — C89 (a)). */
const transportOrFail = (): FortnoxTransport => fortnoxTransport() ?? fail("FORTNOX_UNAVAILABLE");

/**
 * The gates every connecting verb takes: the code ✦ on all four gates, the
 * module, a TENANT-WIDE scope (the security review's 4 — the bookkeeping
 * file's rule), and, for a press, the factor of a minute ago.
 */
async function openConnecting(tx: TenantDb, ctx: InvoicingCtx, opts: { readonly freshCode: boolean }): Promise<void> {
  refuseImpersonation(ctx);
  await requireAccess(tx, ctx.tenantId, ctx.actor, "invoice:connect_bookkeeping");
  await requireAccess(tx, ctx.tenantId, ctx.actor, "invoice:view");
  if (!(await resolveScope(tx, ctx.actor)).all) deny("FORBIDDEN");
  if (opts.freshCode) await requireRecentMfa(ctx.actor, INVOICE_DETAILS_STEP_UP_MINUTES);
}

type LiveConnection = {
  readonly id: string;
  readonly status: "ACTIVE" | "BROKEN";
  readonly transport: string;
  readonly appClientId: string;
  readonly externalTenantId: string;
  readonly companyName: string;
  readonly companyOrgNr: string;
  readonly connectedAt: Date;
  readonly connectedByMemberId: string;
  readonly brokenReason: unknown;
};

/** The workspace's live (ACTIVE or BROKEN) Fortnox connection, or null. */
async function liveConnection(tx: TenantDb, tenantId: string): Promise<LiveConnection | null> {
  const row = await tx.integrationConnection.findFirst({
    where: { tenantId, provider: "FORTNOX", status: { not: "DISCONNECTED" } },
    select: {
      id: true,
      status: true,
      transport: true,
      appClientId: true,
      externalTenantId: true,
      companyName: true,
      companyOrgNr: true,
      connectedAt: true,
      connectedByMemberId: true,
      brokenReason: true,
    },
  });
  if (!row || row.status === "DISCONNECTED") return null;
  return { ...row, status: row.status };
}

/** Made by THIS process's transport and Fortnox app — a row of another environment is never asked from here (S2). */
const isOurs = (live: LiveConnection): boolean => live.transport === (fortnoxTransport()?.kind ?? "off") && live.appClientId === fortnoxClientId;

/** An org. number normalised, or null when it is empty or no org. number (S6: never two empties equal). */
const orgOf = (raw: string | null | undefined): string | null => {
  try {
    return normalizeOrgNr(raw ?? null);
  } catch {
    return null;
  }
};

// ── Begin ───────────────────────────────────────────────────────────

export type ConnectStart = { readonly url: string };

/**
 * What would refuse a press of Connect, asked BEFORE the code is checked so a
 * plain refusal never spends one of the owner's code attempts (the code
 * review's 9). No write, no audit; `beginFortnoxConnect` asks it all again.
 */
export async function fortnoxConnectBlocker(ctx: InvoicingCtx): Promise<void> {
  refuseImpersonation(ctx);
  transportOrFail();
  await withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    // The code HELD, its ✦ window aside — the factor is the code about to be
    // typed (`resolvePermissions`' afterStepUp, as the card offers it).
    await requireAccess(tx, ctx.tenantId, ctx.actor, "invoice:view");
    const answers = await resolvePermissions(tx, ctx.actor, ["invoice:connect_bookkeeping"]);
    if (!answers.allowed.has("invoice:connect_bookkeeping") && !answers.afterStepUp.has("invoice:connect_bookkeeping")) deny("FORBIDDEN");
    if (!(await resolveScope(tx, ctx.actor)).all) deny("FORBIDDEN");
    if (orgOf((await readSeller(tx, ctx.tenantId)).company.orgNr) === null) fail("FORTNOX_NO_ORG_NR");
    if ((await liveConnection(tx, ctx.tenantId))?.status === "ACTIVE") fail("FORTNOX_ALREADY_CONNECTED");
  });
}

/**
 * `invoice:connect_bookkeeping` ✦ + the code typed in the form — a press of
 * Connect (or Connect again, on a BROKEN connection): the attempt, audited,
 * and the consent screen's address. FORTNOX_ALREADY_CONNECTED while ACTIVE;
 * FORTNOX_NO_ORG_NR without an org. number on the company card;
 * FORTNOX_TOO_MANY past ten presses an hour.
 */
export async function beginFortnoxConnect(ctx: InvoicingCtx): Promise<ConnectStart> {
  refuseImpersonation(ctx);
  const transport = transportOrFail();
  if (!(await allowStrict("fortnox.connect", `${ctx.tenantId}:${ctx.actor.memberId}`))) fail("FORTNOX_TOO_MANY");
  const state = newState();
  const verifier = newPkceVerifier();
  const company = await withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await openConnecting(tx, ctx, { freshCode: true });
    const { company: card } = await readSeller(tx, ctx.tenantId);
    const orgNr = orgOf(card.orgNr);
    if (orgNr === null) return fail("FORTNOX_NO_ORG_NR");
    const live = await liveConnection(tx, ctx.tenantId);
    if (live?.status === "ACTIVE") return fail("FORTNOX_ALREADY_CONNECTED");
    const attempt = await tx.integrationConnectAttempt.create({
      data: {
        tenantId: ctx.tenantId,
        provider: "FORTNOX",
        memberId: ctx.actor.memberId,
        stateHash: stateHashOf(state),
        pkceVerifier: verifier,
        // Dated by the database: now, and ten minutes on.
        expiresAt: new Date(),
      },
      select: { id: true },
    });
    await record(tx, {
      action: "integration.connect_started",
      targetType: "IntegrationConnectAttempt",
      targetId: attempt.id,
      metadata: { provider: "FORTNOX", reconnect: live !== null },
    });
    return { name: card.legalName ?? "-", orgNr };
  });
  const url = transport.consentUrl({
    state,
    codeChallenge: codeChallengeOf(verifier),
    ...(transport.kind === "fake"
      ? { fake: { companyTenantId: fakeCompanyTenantIdFor(ctx.tenantId), name: company.name, orgNr: company.orgNr } }
      : {}),
  });
  return { url };
}

// ── The callback ────────────────────────────────────────────────────

export type ConnectFinished = { readonly attemptId: string | null; readonly outcome: ConnectOutcome | "EXPIRED" };

/** Spend the attempt — ONE compare-and-set; its verifier, read in the same statement. */
async function spendAttempt(tx: TenantDb, ctx: InvoicingCtx, state: string): Promise<{ id: string; verifier: string } | null> {
  const rows = await tx.$queryRaw<{ id: string; verifier: string | null }[]>`
    UPDATE integration_connect_attempt t
       SET used_at = now(), pkce_verifier = NULL
      FROM (SELECT a.id, a.pkce_verifier
              FROM integration_connect_attempt a
             WHERE a.tenant_id = ${ctx.tenantId} AND a.state_hash = ${stateHashOf(state)}
               FOR UPDATE) was
     WHERE t.id = was.id
       AND t.member_id = ${ctx.actor.memberId}
       AND t.used_at IS NULL
       AND t.expires_at > statement_timestamp()
    RETURNING t.id, was.pkce_verifier AS verifier`;
  const row = rows[0];
  return row && row.verifier ? { id: row.id, verifier: row.verifier } : null;
}

/** A refusal: the attempt's outcome (and whose company it met), audited — in its own transaction. */
async function refuse(ctx: InvoicingCtx, attemptId: string, outcome: Refusal, seen: FortnoxCompany | null = null): Promise<ConnectFinished> {
  await withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await tx.integrationConnectAttempt.update({
      where: { id: attemptId },
      data: {
        outcome,
        ...(seen && outcome === "ORG_MISMATCH" ? { seenCompanyName: seen.name.slice(0, 200), seenOrgNr: (seen.orgNr ?? "-").slice(0, 20) } : {}),
      },
      select: { id: true },
    });
    await record(tx, {
      action: "integration.connect_refused",
      targetType: "IntegrationConnectAttempt",
      targetId: attemptId,
      metadata: { provider: "FORTNOX", reason: outcome },
    });
  });
  return { attemptId, outcome };
}

/** A Fortnox call's failure as the attempt's outcome. */
const outcomeOfError = (e: unknown, auth: Refusal): Refusal => {
  if (!isFortnoxError(e)) throw e;
  if (e.kind === "licence") return "NO_LICENCE";
  if (e.kind === "auth") return auth;
  return "FAILED";
};

/**
 * The callback (`/settings/invoicing/fortnox/callback`): see the header.
 * EXPIRED (no attempt) for a state that is not this member's, spent, or past
 * its ten minutes; otherwise the spent attempt's outcome — never a throw once
 * the attempt is spent.
 */
export async function completeFortnoxConnect(
  ctx: InvoicingCtx,
  input: { readonly state: unknown; readonly code: unknown; readonly error: unknown },
  opts: { readonly now?: Date } = {},
): Promise<ConnectFinished> {
  refuseImpersonation(ctx);
  const transport = transportOrFail();
  if (!isStateShape(input.state)) return { attemptId: null, outcome: "EXPIRED" };
  const state = input.state;
  const spent = await withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    // All four gates (S11) — the code's ✦ window covers the ten minutes at
    // Fortnox; the code itself was typed at Connect.
    await openConnecting(tx, ctx, { freshCode: false });
    return spendAttempt(tx, ctx, state);
  });
  if (!spent) return { attemptId: null, outcome: "EXPIRED" };
  try {
    return await finishSpent(ctx, transport, spent, input, opts.now ?? new Date());
  } catch (e) {
    // Whatever broke after the spend — a gate closed meanwhile, a lock held too
    // long, a bug — the attempt says so (the code reviews' 1/2): BUSY for the
    // lock, FAILED for the rest, logged by name and code only. An outcome
    // already written (the connection committed, then the answer was lost) is
    // left as it is.
    const outcome: Refusal = isLockTimeout(e) || isDeadlock(e) ? "BUSY" : "FAILED";
    if (outcome === "FAILED") console.error(`fortnox connect: failed after the attempt was spent: ${errorTag(e)}`);
    try {
      return await refuse(ctx, spent.id, outcome);
    } catch {
      return { attemptId: spent.id, outcome };
    }
  }
}

async function finishSpent(
  ctx: InvoicingCtx,
  transport: FortnoxTransport,
  spent: { readonly id: string; readonly verifier: string },
  input: { readonly code: unknown; readonly error: unknown },
  now: Date,
): Promise<ConnectFinished> {
  if (input.error !== undefined && input.error !== null) {
    return refuse(ctx, spent.id, input.error === "error_missing_license" ? "NO_LICENCE" : "DENIED");
  }
  // No code and no `error`: not the administrator's no (C7) — something broke on the way back.
  if (typeof input.code !== "string" || input.code.length < 8 || input.code.length > 2048) return refuse(ctx, spent.id, "FAILED");

  const deadline = Date.now() + CALLBACK_BUDGET_MS;
  let company: FortnoxCompany;
  try {
    const exchanged = await transport.exchangeCode(input.code, spent.verifier, deadline);
    company = await transport.companyInformation(exchanged.accessToken, deadline);
    // The token's own claim must name the same company (S10).
    if (exchanged.tenantIdClaim !== null && exchanged.tenantIdClaim !== company.databaseNumber) return refuse(ctx, spent.id, "FAILED");
  } catch (e) {
    // The code exchange refused — an expired code, our own credentials, a PKCE
    // mismatch — is not the administrator saying no (the code review's 7):
    // DENIED is the consent screen's own `error` alone.
    if (isFortnoxError(e)) console.error(`fortnox connect: ${e.logTag}`);
    return refuse(ctx, spent.id, outcomeOfError(e, "FAILED"));
  }

  // The workspace's org. number — read again now, not at Connect.
  const cardOrg = await withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => orgOf((await readSeller(tx, ctx.tenantId)).company.orgNr));
  if (cardOrg === null) return refuse(ctx, spent.id, "NO_ORG_NR");
  const fortnoxOrg = orgOf(company.orgNr);
  if (fortnoxOrg === null || fortnoxOrg !== cardOrg) return refuse(ctx, spent.id, "ORG_MISMATCH", company);

  // A FRESH service token for that company — never the cache (the reviews'
  // S2/4) — and the company asked again with it.
  try {
    const serviceToken = await transport.tenantToken(company.databaseNumber, deadline, { fresh: true });
    const again = await transport.companyInformation(serviceToken, deadline);
    if (again.databaseNumber !== company.databaseNumber || orgOf(again.orgNr) !== cardOrg) return refuse(ctx, spent.id, "FAILED");
  } catch (e) {
    return refuse(ctx, spent.id, outcomeOfError(e, "NOT_SERVICE"));
  }

  const clientId = fortnoxClientId;
  if (clientId === null) return refuse(ctx, spent.id, "FAILED");
  try {
    return await withTenant(
      ctx.tenantId,
      memberPrincipal(ctx),
      async (tx): Promise<ConnectFinished> => {
        // The gates, then the bookkeeping file's lock — every maker's order.
        await openConnecting(tx, ctx, { freshCode: false });
        await tx.$executeRaw`SELECT invoice_export_lock(${ctx.tenantId})`;
        const live = await liveConnection(tx, ctx.tenantId);
        const today = todayIn((await readPreferences(tx, ctx.tenantId)).timezone, now);
        const sameCompany = live !== null && live.externalTenantId === company.databaseNumber && live.transport === transport.kind && live.appClientId === clientId;

        if (live?.status === "ACTIVE") {
          // Connected meanwhile — another tab, another owner (the code review's 5).
          return refusedInside(tx, ctx, spent.id, sameCompany ? "ALREADY" : "OTHER_COMPANY");
        }
        if (live) {
          if (!sameCompany) return refusedInside(tx, ctx, spent.id, "OTHER_COMPANY");
          await setOutcome(tx, spent.id, "RECONNECTED");
          // Raw, for the JSON column's SQL NULL (no generated client outside src/db).
          await tx.$executeRaw`
            UPDATE integration_connection
               SET status = 'ACTIVE'::integration_status,
                   connect_attempt_id = ${spent.id},
                   connected_by_member_id = ${ctx.actor.memberId},
                   connected_at = ${now},
                   company_name = ${company.name.slice(0, 200)},
                   broken_since = NULL,
                   broken_reason = NULL,
                   last_night = ${today}::date
             WHERE tenant_id = ${ctx.tenantId} AND id = ${live.id}`;
          await record(tx, {
            action: "integration.reconnected",
            targetType: "IntegrationConnection",
            targetId: live.id,
            metadata: { provider: "FORTNOX", externalTenantId: company.databaseNumber },
          });
          await noticeToOwners(tx, ctx.tenantId, now, { kind: INTEGRATION_CONNECTED_MAIL, key: `integration_connected:${spent.id}` });
          return { attemptId: spent.id, outcome: "RECONNECTED" };
        }

        await setOutcome(tx, spent.id, "CONNECTED");
        const made = await tx.integrationConnection.create({
          data: {
            tenantId: ctx.tenantId,
            provider: "FORTNOX",
            status: "ACTIVE",
            transport: transport.kind,
            appClientId: clientId,
            externalTenantId: company.databaseNumber,
            companyName: company.name.slice(0, 200),
            companyOrgNr: cardOrg,
            connectAttemptId: spent.id,
            connectedByMemberId: ctx.actor.memberId,
            // Stamped by the database.
            connectedAt: now,
            // The connect day: the first night is the next (S5).
            lastNight: new Date(`${today}T00:00:00Z`),
          },
          select: { id: true },
        });
        await record(tx, {
          action: "integration.connected",
          targetType: "IntegrationConnection",
          targetId: made.id,
          metadata: { provider: "FORTNOX", externalTenantId: company.databaseNumber },
        });
        await noticeToOwners(tx, ctx.tenantId, now, { kind: INTEGRATION_CONNECTED_MAIL, key: `integration_connected:${spent.id}` });
        return { attemptId: spent.id, outcome: "CONNECTED" };
      },
      LOCKED,
    );
  } catch (e) {
    // That Fortnox company is another workspace's (the cross-workspace unique, Q1).
    if (uniqueViolationOn(e, LIVE_PER_COMPANY)) return refuse(ctx, spent.id, "ELSEWHERE");
    throw e;
  }
}

async function setOutcome(tx: TenantDb, attemptId: string, outcome: ConnectOutcome): Promise<void> {
  await tx.integrationConnectAttempt.update({ where: { id: attemptId }, data: { outcome }, select: { id: true } });
}

/** A refusal decided inside the final transaction: its outcome and audit row there. */
async function refusedInside(tx: TenantDb, ctx: InvoicingCtx, attemptId: string, outcome: Refusal): Promise<ConnectFinished> {
  await setOutcome(tx, attemptId, outcome);
  await record(tx, {
    action: "integration.connect_refused",
    targetType: "IntegrationConnectAttempt",
    targetId: attemptId,
    metadata: { provider: "FORTNOX", reason: outcome },
  });
  return { attemptId, outcome };
}

/** A unique violation on one named index — from Prisma's META, never its message (the code-frame trap). */
function uniqueViolationOn(e: unknown, index: string): boolean {
  if (typeof e !== "object" || e === null) return false;
  const err = e as { code?: unknown; meta?: unknown };
  let meta = "";
  try {
    meta = JSON.stringify(err.meta ?? {});
  } catch {
    return false;
  }
  return (err.code === "P2002" || err.code === "P2010" || err.code === "23505") && meta.includes(index);
}

// ── Disconnect ──────────────────────────────────────────────────────

/**
 * `invoice:connect_bookkeeping` ✦ + the code typed in the form — the
 * workspace's live connection DISCONNECTED (kept as history), audited, every
 * active owner mailed. Never refused for a send in flight: a disconnect is the
 * kill switch (the design review's S5) — and it needs no Fortnox, so it works
 * with the transport off too. FORTNOX_NOT_CONNECTED with none;
 * INVOICE_EXPORT_BUSY while a bookkeeping file holds the lock past its bound.
 */
export async function disconnectFortnox(ctx: InvoicingCtx, opts: { readonly now?: Date } = {}): Promise<void> {
  refuseImpersonation(ctx);
  const now = opts.now ?? new Date();
  try {
    await withTenant(
      ctx.tenantId,
      memberPrincipal(ctx),
      async (tx) => {
        await openConnecting(tx, ctx, { freshCode: true });
        await tx.$executeRaw`SELECT invoice_export_lock(${ctx.tenantId})`;
        const live = await liveConnection(tx, ctx.tenantId);
        if (!live) return fail("FORTNOX_NOT_CONNECTED");
        await tx.integrationConnection.update({
          where: { id: live.id },
          data: { status: "DISCONNECTED", disconnectedByMemberId: ctx.actor.memberId, disconnectedAt: now },
          select: { id: true },
        });
        await record(tx, {
          action: "integration.disconnected",
          targetType: "IntegrationConnection",
          targetId: live.id,
          metadata: { provider: "FORTNOX", externalTenantId: live.externalTenantId },
        });
        await noticeToOwners(tx, ctx.tenantId, now, { kind: INTEGRATION_DISCONNECTED_MAIL, key: `integration_disconnected:${live.id}` });
      },
      LOCKED,
    );
  } catch (e) {
    if (isLockTimeout(e) || isDeadlock(e)) return fail("INVOICE_EXPORT_BUSY");
    throw e;
  }
}

// ── The card ────────────────────────────────────────────────────────

export type FortnoxCard = {
  /** This deployment connects to a Fortnox at all (`FORTNOX_TRANSPORT` is not off). */
  readonly available: boolean;
  /** The viewer may connect and disconnect (the code ✦ and every client; its step-up is the code typed in the form). */
  readonly canConnect: boolean;
  /** The viewer may ask "Is Fortnox ready?" (the code or `invoice:export`, and every client). */
  readonly canCheck: boolean;
  /** The company card has an org. number — Connect needs one (offered only then: the code review's 9). */
  readonly hasOrgNr: boolean;
  readonly connection: {
    readonly status: "ACTIVE" | "BROKEN";
    readonly companyName: string;
    readonly companyOrgNr: string;
    readonly connectedAt: Date;
    readonly connectedBy: string | null;
    /** Why it stopped — the KIND only (S8: the details live on the Bookkeeping page). */
    readonly brokenKind: string | null;
    /** Made by another deployment's Fortnox app (a database copied between environments): never sent from here. */
    readonly foreign: boolean;
  } | null;
  /** The company card's org. number differs from the connected company's: new invoices would not go (R3). */
  readonly orgDiffers: boolean;
  /** Entries waiting for a file — the first night's — for a viewer who may see the books, while a Fortnox exists. */
  readonly pending: { readonly count: number; readonly first: string | null; readonly last: string | null } | null;
  /** The viewer's OWN attempt the callback just finished (S9), or null. */
  readonly outcome: {
    readonly outcome: ConnectOutcome;
    readonly seenCompanyName: string | null;
    readonly seenOrgNr: string | null;
  } | null;
};

/** `settings:view` + `invoice:view` — the Fortnox card on Settings → Invoicing. */
export async function readFortnoxCard(
  ctx: InvoicingCtx,
  opts: { readonly attemptId?: string | null; readonly now?: Date } = {},
): Promise<FortnoxCard> {
  const now = opts.now ?? new Date();
  const available = fortnoxTransport() !== null;
  return withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "settings:view");
    await requireAccess(tx, ctx.tenantId, ctx.actor, "invoice:view");
    // In sequence (AGENTS.md's `Promise.all` trap).
    const answers = await resolvePermissions(tx, ctx.actor, ["invoice:connect_bookkeeping"]);
    const mayExport = await hasAccess(tx, ctx.tenantId, ctx.actor, "invoice:export");
    const everyClient = (await resolveScope(tx, ctx.actor)).all;
    const holdsCode = answers.allowed.has("invoice:connect_bookkeeping") || answers.afterStepUp.has("invoice:connect_bookkeeping");
    const canConnect = !ctx.actor.impersonated && everyClient && holdsCode;
    const canCheck = !ctx.actor.impersonated && everyClient && (holdsCode || mayExport);
    const cardOrg = orgOf((await readSeller(tx, ctx.tenantId)).company.orgNr);
    const live = await liveConnection(tx, ctx.tenantId);
    let connection: FortnoxCard["connection"] = null;
    if (live) {
      const by = await tx.member.findFirst({ where: { id: live.connectedByMemberId }, select: { user: { select: { name: true } } } });
      const reason = live.brokenReason as { kind?: unknown } | null;
      connection = {
        status: live.status,
        companyName: live.companyName,
        companyOrgNr: live.companyOrgNr,
        connectedAt: live.connectedAt,
        connectedBy: by?.user.name ?? null,
        brokenKind: live.status === "BROKEN" && typeof reason?.kind === "string" ? reason.kind : null,
        foreign: !isOurs(live),
      };
    }
    // The first night's entries, for a viewer the Bookkeeping page opens for —
    // only while a Fortnox exists to send them to, and nothing is connected yet
    // (the card shows them only then: the code review's 8, the re-check's 5).
    let pending: FortnoxCard["pending"] = null;
    if (available && live === null && mayExport && everyClient) {
      pending = await pendingForFiles(tx, ctx.tenantId, now);
    }
    let outcome: FortnoxCard["outcome"] = null;
    if (opts.attemptId && /^[0-9a-f-]{36}$/.test(opts.attemptId)) {
      const a = await tx.integrationConnectAttempt.findFirst({
        where: { id: opts.attemptId, memberId: ctx.actor.memberId, outcome: { not: null }, usedAt: { gt: new Date(now.getTime() - OUTCOME_SHOWN_MS) } },
        select: { outcome: true, seenCompanyName: true, seenOrgNr: true },
      });
      if (a?.outcome && CONNECT_OUTCOMES.has(a.outcome)) {
        outcome = { outcome: a.outcome as ConnectOutcome, seenCompanyName: a.seenCompanyName, seenOrgNr: a.seenOrgNr };
      }
    }
    return {
      available,
      canConnect,
      canCheck,
      hasOrgNr: cardOrg !== null,
      connection,
      orgDiffers: live !== null && cardOrg !== live.companyOrgNr,
      pending,
      outcome,
    };
  });
}

// ── The check ───────────────────────────────────────────────────────

export type FortnoxCheckItem =
  | { readonly key: "consent"; readonly ok: boolean; readonly problem?: "gone" | "licence" | "unreachable" }
  | { readonly key: "year"; readonly ok: boolean; readonly day: string }
  | { readonly key: "method"; readonly ok: boolean; readonly fortnox: "ACCRUAL" | "CASH" | null; readonly ours: "INVOICE" | "CASH" | null }
  | { readonly key: "series"; readonly ok: boolean; readonly series: string; readonly problem?: "missing" | "notManual" }
  | { readonly key: "account"; readonly ok: boolean; readonly role: AccountRole; readonly account: string; readonly problem?: "missing" | "inactive" }
  | { readonly key: "refused"; readonly ok: false; readonly code: string | null; readonly detail: string | null };

export type FortnoxCheck = { readonly ok: boolean; readonly items: readonly FortnoxCheckItem[] };

/**
 * "Is Fortnox ready?" (the design's §4.4) — READ-ONLY questions to the
 * connected company with a FRESH service token: the consent alive, a financial
 * year for today and its method against the workspace's, the voucher series (it
 * exists and is manual), the ten accounts (each exists and is active). Writes
 * nothing, audits nothing (Q5, R7). `invoice:view`, the code or
 * `invoice:export`, and a tenant-wide scope (the security review's 4/5 —
 * Fortnox's own words are shown); ten checks per ten minutes per workspace.
 */
export async function checkFortnox(ctx: InvoicingCtx, opts: { readonly now?: Date } = {}): Promise<FortnoxCheck> {
  refuseImpersonation(ctx);
  const transport = transportOrFail();
  const now = opts.now ?? new Date();
  const facts = await withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "invoice:view");
    const answers = await resolvePermissions(tx, ctx.actor, ["invoice:connect_bookkeeping"]);
    const owner = answers.allowed.has("invoice:connect_bookkeeping") || answers.afterStepUp.has("invoice:connect_bookkeeping");
    if (!owner && !(await hasAccess(tx, ctx.tenantId, ctx.actor, "invoice:export"))) deny("FORBIDDEN");
    if (!(await resolveScope(tx, ctx.actor)).all) deny("FORBIDDEN");
    const live = await liveConnection(tx, ctx.tenantId);
    // None, or another deployment's (S2): nothing to ask from here.
    if (!live || !isOurs(live)) return fail("FORTNOX_NOT_CONNECTED");
    const settings = await readBookkeepingSettings(tx, ctx.tenantId);
    const today = todayIn((await readPreferences(tx, ctx.tenantId)).timezone, now);
    return { tenantId: live.externalTenantId, settings, today };
  });
  if (!(await allowStrict("fortnox.check", ctx.tenantId))) fail("FORTNOX_TOO_MANY");

  const deadline = Date.now() + CHECK_BUDGET_MS;
  const items: FortnoxCheckItem[] = [];
  /** The check ends here: the consent's line says why (it REPLACES a "reachable" line — the code review's 4). */
  const stop = (e: unknown): FortnoxCheck => {
    if (!isFortnoxError(e)) throw e;
    const kept: FortnoxCheckItem[] = items.filter((i) => i.key !== "consent");
    if (e.kind === "auth") kept.unshift({ key: "consent", ok: false, problem: "gone" });
    else if (e.kind === "licence") kept.unshift({ key: "consent", ok: false, problem: "licence" });
    else if (e.kind === "refused") kept.push({ key: "refused", ok: false, code: e.code, detail: e.detail });
    else kept.unshift({ key: "consent", ok: false, problem: "unreachable" });
    return { ok: false, items: kept };
  };
  let token: string;
  try {
    token = await transport.tenantToken(facts.tenantId, deadline, { fresh: true });
  } catch (e) {
    return stop(e);
  }
  items.push({ key: "consent", ok: true });
  try {
    const year = await transport.financialYearOn(token, facts.today, deadline);
    items.push({ key: "year", ok: year !== null, day: facts.today });
    if (year === null) return { ok: false, items };
    const ours = methodOf(facts.settings);
    const methodOk = ours === null || year.method === null || (ours === "CASH") === (year.method === "CASH");
    items.push({ key: "method", ok: methodOk, fortnox: year.method, ours });
    const series = await transport.voucherSeries(token, facts.settings.series, year.id, deadline);
    items.push(
      series === null
        ? { key: "series", ok: false, series: facts.settings.series, problem: "missing" }
        : series.manual
          ? { key: "series", ok: true, series: facts.settings.series }
          : { key: "series", ok: false, series: facts.settings.series, problem: "notManual" },
    );
    // In sequence: each is one call under the company's rate limit.
    for (const role of ACCOUNT_ROLES) {
      const number = facts.settings[role];
      const account = await transport.account(token, number, year.id, deadline);
      items.push(
        account === null
          ? { key: "account", ok: false, role, account: number, problem: "missing" }
          : account.active
            ? { key: "account", ok: true, role, account: number }
            : { key: "account", ok: false, role, account: number, problem: "inactive" },
      );
    }
  } catch (e) {
    return stop(e);
  }
  return { ok: items.every((i) => i.ok), items };
}
