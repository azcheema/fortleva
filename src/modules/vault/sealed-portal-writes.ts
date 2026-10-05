import { AuthzError } from "@/authz/errors";
import { record } from "@/audit/record";
import { withTenant, type TenantDb } from "@/db";
import {
  askWaitState,
  confirmableAt,
  DAY_MS,
  isAnswerable,
  isLive,
  scheduledByConfirmation,
  type AskWaitState,
} from "@/lib/ask-and-wait";
import { DomainError } from "@/lib/domain-error";
import { SEALED_MEMBER_MAIL } from "@/notify/sealed-mail-keys";
import { authorizePortal, withPortalRead, type PortalPrincipal } from "@/portal";
import { lockContactBudget } from "@/portal/contact-budget-lock";
import { readPreferences } from "@/preferences/service";
import { allow } from "@/ratelimit";

import { doorOpenUntil } from "./client-door";
import { contactStanding } from "./contact-standing";
import { boundedVaultWrite } from "./ctx";
import { PORTAL_LOGIN_LIMIT, type PortalLogin } from "./portal";
import {
  LOGINS_UNLOCKS_PER_DAY,
  LOGINS_UNLOCKS_PER_HOUR,
  type OpenPortalDoor,
  type PasswordCheck,
  type PortalLoginsCtx,
} from "./portal-writes";
import {
  doorOpenedSince,
  lockAsk,
  lockClientAsks,
  newestUnendedAsk,
  openAskOf,
  openAskPeek,
  sealedClock,
  sealedGuarded,
} from "./sealed-door";
import { answerersOf, clientPeopleOf, enqueueSealedMail } from "./sealed-mail";
import { SEALED_REASON_MAX, SEALED_RULES } from "./sealed-rules";
import { readSecret } from "./secret-store";

/**
 * A CLIENT ASKS TO OPEN THE LOGINS THEIR AGENCY KEEPS SEALED FOR THEM — THE
 * PORTAL'S BROKER (Phase 3V slice 93; founder decisions C52 (f)–(j), C61;
 * AUTHZ.md §8's brokered shape).
 *
 * WHAT THE CLIENT SEES BEFORE ASKING is a COUNT (C61 (a)): "your agency
 * keeps 4 logins sealed for you" — which ones stays behind the opening, as
 * C54 kept names behind the door. Their MAIN contacts only (C61 (e),
 * `portal.credential.request_open`, PRIMARY only), and whether or not the
 * agency shows logins to clients at all (C61 (d): the escape hatch does not
 * hang on a switch the agency can turn off).
 *
 * THE FLOW, every step brokered here as SYSTEM after the contact's own proof
 * (`withPortalRead` + `authorizePortal`), each restating the contact's
 * standing (`contactStanding`: both modules open, still an ACTIVE, invited
 * MAIN contact of this client) because RLS no longer does:
 *   - ASK, with their portal password and a reason (C52 (f)). The check is
 *     counted BEFORE it is made, on the same per-contact budget as the
 *     door's (`portal.logins_unlock_started`, `purpose: "ask"`), and only a
 *     right password makes the ask — under the client's ask lock, with
 *     something sealed, nothing else in play, not within 30 days of a
 *     denial (the guard trigger holds all three as well), and at most
 *     `SEALED_ASKS_PER_DAY` asks per client a day (an ask mails every
 *     answerer; a withdraw-and-ask loop must not become a mail cannon). The
 *     wait is the agency's `vault.sealedWaitDays`, frozen on the ask; every
 *     answerer is mailed at once (day 0; the job does the rest).
 *   - WITHDRAW one that has not opened.
 *   - CONFIRM after the silent wait, with their password AND a code mailed to
 *     them — which is the client's door (`portal-writes.ts`) opened in THIS
 *     session a moment before; the database refuses a confirmation without
 *     an open door of that contact. It opens 48 hours later; the answerers
 *     and the client's main contacts are told.
 *   - Once open: the sealed logins behind the same door, listed
 *     (`listSealedPortalLogins`, a brokered READ — the logins are INTERNAL,
 *     so the contact's own transaction reads none of them) and looked at one
 *     field at a time (`lookAtSealedLogin`), every look audited to the
 *     CONTACT on their own hourly budget, `sealed: true`.
 *
 * NEVER UNDER VIEW-AS: every export but `portalHasSealedLogins` (a bit for
 * the portal's nav) takes the portal SESSION's id, which a member looking
 * through a contact does not have; `vault-boundary.test.ts` pins the
 * callers to the portal's logins route and its frame.
 *
 * A REFUSAL THAT SPENT SOMETHING COMMITS: a wrong password is returned out
 * of its transaction, never thrown inside it, so its count and audit row
 * land (`reveal.ts`'s rule). Nothing here logs.
 */

/** Asks per client per rolling day — each one mails every answerer. */
export const SEALED_ASKS_PER_DAY = 3;

const HOUR_MS = 60 * 60_000;
const SYSTEM_GUARD = "vault: the client's sealed logins need the portal session they are asked from";

const isBusy = (e: unknown): boolean => e instanceof DomainError && e.code === "VAULT_BUSY";
/** The guard refused at a deadline's instant (`sealedGuarded`). */
const isSettled = (e: unknown): boolean => e instanceof DomainError && e.code === "SEALED_REQUEST_SETTLED";
const validSession = (sessionId: unknown): boolean =>
  typeof sessionId === "string" && sessionId.length > 0 && sessionId.length <= 64;
const validId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 64;

/** The ask the client sees — its own words back, the state, and a denial's reason. */
export type SealedPortalAsk = {
  readonly id: string;
  readonly state: AskWaitState;
  readonly reason: string;
  readonly askedAt: Date;
  readonly waitDays: number;
  /** Asked by this contact. */
  readonly yours: boolean;
  /** Another main contact's name when it was theirs; null when it is yours or they have gone. */
  readonly askedBy: string | null;
  /** A denial's reason, as the answerer wrote it (or none). */
  readonly denyReason: string | null;
};

export type SealedPortalState = {
  /** How many live logins the agency keeps sealed for this client — a count, never which (C61 (a)). */
  readonly count: number;
  /** The newest ask, whatever became of it — or none ever made. */
  readonly ask: SealedPortalAsk | null;
  /** Something sealed, nothing in play, not cooling down after a denial. */
  readonly canAsk: boolean;
  /** When a new ask is possible again after a denial, while that is still ahead. */
  readonly askAgainAt: Date | null;
  /** The agency's wait today — what a new ask would wait (C52 (g)). */
  readonly waitDays: number;
  /**
   * The client's asks today are spent (`SEALED_ASKS_PER_DAY`): the form is
   * not offered, rather than spending a password check on a refusal (the
   * code review's nit).
   */
  readonly limitedToday: boolean;
  /**
   * For a confirmable ask: the door is open in THIS session AND was opened
   * after the wait ran out — what a confirmation needs (the guard's rule).
   * A door opened before stays open but cannot confirm; the page says so
   * instead of drawing a button that would refuse (both reviews' nit).
   */
  readonly confirmReady: boolean;
};

export type SealedAskOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /**
       * invalid: no reason, or a reason too long (counts nothing). wrong_password:
       * counted. limited: the password checks, or the client's asks today,
       * are spent. nothing: nothing is sealed for this client. already: an
       * ask is in play. cooling: within 30 days of a denial. off: the vault
       * or portal is closed, or the contact is no longer a main contact.
       * busy: lock waits spent.
       */
      readonly reason: "invalid" | "wrong_password" | "limited" | "nothing" | "already" | "cooling" | "off" | "busy";
    };

export type SealedActOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /**
       * locked: the client's door is not open in this session (confirming
       * needs it). not_yet: the wait is still running. settled: the ask can
       * no longer be confirmed or withdrawn. not_found: no such ask of this
       * client's.
       */
      readonly reason: "invalid" | "locked" | "not_yet" | "settled" | "not_found" | "off" | "busy";
    };

export type SealedLookOutcome =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: "locked" | "not_found" | "budget" | "invalid" | "busy" };

const LIVE_SEALED = { sealedAt: { not: null }, deletedAt: null, archivedAt: null } as const;

async function sealedCount(tx: TenantDb, principal: PortalPrincipal): Promise<number> {
  return tx.credentialItem.count({ where: { tenantId: principal.tenantId, clientId: principal.clientId, ...LIVE_SEALED } });
}

/**
 * THE BROKERED READ — where this client's sealed logins stand for the page:
 * how many, the newest ask and what became of it, whether a new one may be
 * made. Null when the contact has no standing here now. Writes nothing.
 */
export async function readSealedPortalState(ctx: PortalLoginsCtx): Promise<SealedPortalState | null> {
  const { principal, sessionId } = ctx;
  if (!validSession(sessionId)) throw new Error(SYSTEM_GUARD);
  await withPortalRead(principal, (tx) => authorizePortal(tx, principal, "portal.credential.request_open"));
  return withTenant(principal.tenantId, { type: "system" }, async (tx): Promise<SealedPortalState | null> => {
    if (!(await contactStanding(tx, principal))) return null;
    const count = await sealedCount(tx, principal);
    const newest = await tx.sealedOpenRequest.findFirst({
      where: { tenantId: principal.tenantId, clientId: principal.clientId },
      orderBy: [{ askedAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        reason: true,
        askedByContactId: true,
        denyReason: true,
        askedAt: true,
        waitDays: true,
        confirmedAt: true,
        approvedAt: true,
        deniedAt: true,
        withdrawnAt: true,
        opensAt: true,
        openUntil: true,
      },
    });
    const lastDenial = await tx.sealedOpenRequest.findFirst({
      where: { tenantId: principal.tenantId, clientId: principal.clientId, deniedAt: { not: null } },
      orderBy: { deniedAt: "desc" },
      select: { deniedAt: true },
    });
    const prefs = await readPreferences(tx, principal.tenantId);
    const now = await sealedClock(tx);
    const coolsAt = lastDenial?.deniedAt ? new Date(lastDenial.deniedAt.getTime() + SEALED_RULES.cooldownDays * DAY_MS) : null;
    const askAgainAt = coolsAt !== null && coolsAt.getTime() > now.getTime() ? coolsAt : null;
    let ask: SealedPortalAsk | null = null;
    if (newest) {
      const state = askWaitState(newest, SEALED_RULES, now);
      const yours = newest.askedByContactId === principal.contactId;
      const other = yours
        ? null
        : await tx.contact.findFirst({
            where: { tenantId: principal.tenantId, id: newest.askedByContactId, clientId: principal.clientId },
            select: { name: true },
          });
      ask = {
        id: newest.id,
        state,
        reason: newest.reason,
        askedAt: newest.askedAt,
        waitDays: newest.waitDays,
        yours,
        askedBy: other?.name ?? null,
        denyReason: state.kind === "denied" ? newest.denyReason : null,
      };
    }
    const live = ask !== null && isLive(ask.state.kind);
    const today = await tx.sealedOpenRequest.count({
      where: { tenantId: principal.tenantId, clientId: principal.clientId, askedAt: { gt: new Date(now.getTime() - DAY_MS) } },
    });
    const limitedToday = today >= SEALED_ASKS_PER_DAY;
    const confirmReady =
      ask !== null &&
      ask.state.kind === "confirmable" &&
      (await doorOpenedSince(tx, principal.tenantId, principal.contactId, sessionId, ask.state.confirmableAt));
    return {
      count,
      ask,
      canAsk: count > 0 && !live && askAgainAt === null && !limitedToday,
      askAgainAt,
      waitDays: prefs.vault.sealedWaitDays,
      limitedToday,
      confirmReady,
    };
  });
}

/**
 * THE BROKERED READ behind the portal's nav — is there anything sealed for
 * this client, or an ask still in play? False for anyone without the
 * capability (a helper, a module closed — the plane's quiet answer). Takes
 * no session: the frame draws it under View-as too, where it tells the
 * member looking — who needs `project:manage_portal`, not a vault code —
 * one bit: whether this client has sealed logins or an ask in play. The
 * same one bit slice 91's shown-logins entry tells; accepted, and nothing
 * more (no count, no name) crosses.
 */
export async function portalHasSealedLogins(principal: PortalPrincipal): Promise<boolean> {
  try {
    await withPortalRead(principal, (tx) => authorizePortal(tx, principal, "portal.credential.request_open"));
  } catch (e) {
    if (e instanceof AuthzError) return false;
    throw e;
  }
  return withTenant(principal.tenantId, { type: "system" }, async (tx) => {
    if (!(await contactStanding(tx, principal))) return false;
    if ((await sealedCount(tx, principal)) > 0) return true;
    const ask = await newestUnendedAsk(tx, principal.tenantId, principal.clientId);
    return ask !== null && isLive(askWaitState(ask, SEALED_RULES, await sealedClock(tx)).kind);
  });
}

/**
 * ASK — the portal password, then the ask itself (the file's comment). The
 * mail to every answerer is enqueued in the ask's own transaction.
 */
export async function askToOpenSealedLogins(
  ctx: PortalLoginsCtx,
  checkPassword: PasswordCheck,
  rawReason: unknown,
): Promise<SealedAskOutcome> {
  const { principal, sessionId } = ctx;
  if (!validSession(sessionId)) throw new Error(SYSTEM_GUARD);
  // FREE, so it may be specific: a reason left out spends no password check.
  const reason = typeof rawReason === "string" ? rawReason.trim() : "";
  if (reason.length === 0 || reason.length > SEALED_REASON_MAX) return { ok: false, reason: "invalid" };
  await withPortalRead(principal, (tx) => authorizePortal(tx, principal, "portal.credential.request_open"));

  // The check, COUNTED before it is made — the door's budget, shared.
  type Counted = "ok" | "limited" | "off";
  let counted: Counted;
  try {
    counted = await boundedVaultWrite((opts) =>
      withTenant(
        principal.tenantId,
        { type: "system" },
        async (tx): Promise<Counted> => {
          if (!(await contactStanding(tx, principal))) return "off";
          const now = await lockContactBudget(tx, "portal_logins", principal.contactId);
          const started = (since: number) =>
            tx.auditEvent.count({
              where: {
                tenantId: principal.tenantId,
                actorType: "CONTACT",
                actorId: principal.contactId,
                action: "portal.logins_unlock_started",
                createdAt: { gte: new Date(now.getTime() - since) },
              },
            });
          if ((await started(HOUR_MS)) >= LOGINS_UNLOCKS_PER_HOUR) return "limited";
          if ((await started(DAY_MS)) >= LOGINS_UNLOCKS_PER_DAY) return "limited";
          await record(tx, {
            action: "portal.logins_unlock_started",
            targetType: "Contact",
            targetId: principal.contactId,
            brokeredForContactId: principal.contactId,
            metadata: { purpose: "ask" },
          });
          return "ok";
        },
        opts,
      ),
    );
  } catch (e) {
    if (isBusy(e)) return { ok: false, reason: "busy" };
    throw e;
  }
  if (counted !== "ok") return { ok: false, reason: counted };

  const verdict = await checkPassword();
  if (verdict === "limited") return { ok: false, reason: "limited" };
  if (verdict !== "ok") {
    await withTenant(principal.tenantId, { type: "system" }, (tx) =>
      record(tx, {
        action: "portal.logins_password_refused",
        targetType: "Contact",
        targetId: principal.contactId,
        brokeredForContactId: principal.contactId,
        metadata: { purpose: "ask" },
      }),
    );
    return { ok: false, reason: "wrong_password" };
  }

  try {
    return await boundedVaultWrite((opts) =>
      sealedGuarded(() =>
      withTenant(
        principal.tenantId,
        { type: "system" },
        async (tx): Promise<SealedAskOutcome> => {
          if (!(await contactStanding(tx, principal))) return { ok: false, reason: "off" };
          // One client's asks are decided one at a time — the guard's own lock.
          await lockClientAsks(tx, principal.tenantId, principal.clientId);
          // A refusal after a RIGHT password is recorded with its reason
          // code (never the reason's words), so the trail does not show a
          // password check that went nowhere.
          const refuse = async (reason: "nothing" | "already" | "cooling" | "limited"): Promise<SealedAskOutcome> => {
            await record(tx, {
              action: "credential.open_request_refused",
              targetType: "Contact",
              targetId: principal.contactId,
              brokeredForContactId: principal.contactId,
              metadata: { clientId: principal.clientId, reason },
            });
            return { ok: false, reason };
          };
          if ((await sealedCount(tx, principal)) === 0) return refuse("nothing");
          const now = await sealedClock(tx);
          const newest = await newestUnendedAsk(tx, principal.tenantId, principal.clientId);
          if (newest && isLive(askWaitState(newest, SEALED_RULES, now).kind)) return refuse("already");
          const cooling = await tx.sealedOpenRequest.count({
            where: {
              tenantId: principal.tenantId,
              clientId: principal.clientId,
              deniedAt: { gt: new Date(now.getTime() - SEALED_RULES.cooldownDays * DAY_MS) },
            },
          });
          if (cooling > 0) return refuse("cooling");
          const today = await tx.sealedOpenRequest.count({
            where: { tenantId: principal.tenantId, clientId: principal.clientId, askedAt: { gt: new Date(now.getTime() - DAY_MS) } },
          });
          if (today >= SEALED_ASKS_PER_DAY) return refuse("limited");
          // The agency's wait NOW, frozen on the ask (C52 (g)).
          const prefs = await readPreferences(tx, principal.tenantId);
          const made = await tx.sealedOpenRequest.create({
            data: {
              tenantId: principal.tenantId,
              clientId: principal.clientId,
              askedByContactId: principal.contactId,
              reason,
              waitDays: prefs.vault.sealedWaitDays,
              askedAt: now,
              createdAt: now,
              // The day-0 mail, enqueued below in this transaction.
              remindersSent: 1,
              lastRemindedAt: now,
            },
            select: { id: true },
          });
          const answerers = await answerersOf(tx, principal.tenantId, principal.clientId);
          await enqueueSealedMail(tx, principal.tenantId, made.id, "asked", answerers, SEALED_MEMBER_MAIL.asked);
          await record(tx, {
            action: "credential.open_requested",
            targetType: "SealedOpenRequest",
            targetId: made.id,
            brokeredForContactId: principal.contactId,
            // Never the reason's words — the row keeps them.
            metadata: { clientId: principal.clientId, waitDays: prefs.vault.sealedWaitDays, answerers: answerers.length },
          });
          return { ok: true };
        },
        opts,
      )),
    );
  } catch (e) {
    // The guard at an instant's race (an ask, or the wait being changed, in
    // between): nothing was made — "try again" is the honest sentence.
    if (isBusy(e) || isSettled(e)) return { ok: false, reason: "busy" };
    throw e;
  }
}

/**
 * This client's ask, locked and re-read — or null when it is not theirs.
 * The client's ask lock first, then the row (the guard's order, so an ask
 * being made and an act on another ask of the client are judged in turn).
 */
async function lockedAskOfClient(tx: TenantDb, principal: PortalPrincipal, id: string) {
  // Theirs first, so nothing is locked for an id of another client's.
  const theirs = await tx.sealedOpenRequest.findFirst({
    where: { tenantId: principal.tenantId, id, clientId: principal.clientId },
    select: { id: true },
  });
  if (!theirs) return null;
  await lockClientAsks(tx, principal.tenantId, principal.clientId);
  if (!(await lockAsk(tx, principal.tenantId, id))) return null;
  return tx.sealedOpenRequest.findFirst({
    where: { tenantId: principal.tenantId, id, clientId: principal.clientId },
    select: {
      id: true,
      askedAt: true,
      waitDays: true,
      confirmedAt: true,
      approvedAt: true,
      deniedAt: true,
      withdrawnAt: true,
      opensAt: true,
      openUntil: true,
    },
  });
}

/** WITHDRAW an ask that has not opened (any main contact of the client). */
export async function withdrawSealedAsk(ctx: PortalLoginsCtx, requestId: unknown): Promise<SealedActOutcome> {
  const { principal, sessionId } = ctx;
  if (!validSession(sessionId)) throw new Error(SYSTEM_GUARD);
  if (!validId(requestId)) return { ok: false, reason: "invalid" };
  await withPortalRead(principal, (tx) => authorizePortal(tx, principal, "portal.credential.request_open"));
  try {
    return await boundedVaultWrite((opts) =>
      sealedGuarded(() =>
      withTenant(
        principal.tenantId,
        { type: "system" },
        async (tx): Promise<SealedActOutcome> => {
          if (!(await contactStanding(tx, principal))) return { ok: false, reason: "off" };
          const row = await lockedAskOfClient(tx, principal, requestId);
          if (!row) return { ok: false, reason: "not_found" };
          const now = await sealedClock(tx);
          const kind = askWaitState(row, SEALED_RULES, now).kind;
          if (kind === "withdrawn") return { ok: true }; // already — nothing to record
          if (!isAnswerable(kind)) return { ok: false, reason: "settled" };
          await tx.sealedOpenRequest.update({
            where: { id: row.id, tenantId: principal.tenantId },
            // A withdrawal clears the scheduled opening (the CHECK `sealed_open_request_scheduled_iff`).
            data: { withdrawnAt: now, withdrawnByContactId: principal.contactId, opensAt: null, openUntil: null },
            select: { id: true },
          });
          await record(tx, {
            action: "credential.open_request_withdrawn",
            targetType: "SealedOpenRequest",
            targetId: row.id,
            brokeredForContactId: principal.contactId,
            metadata: { clientId: principal.clientId, afterConfirmation: row.confirmedAt !== null },
          });
          // The client's people are told (the security review's low): a
          // withdrawal needs only a session, so a colleague — or whoever holds
          // a stolen cookie — must not cancel an ask in silence.
          await enqueueSealedMail(tx, principal.tenantId, row.id, "withdrawn", await clientPeopleOf(tx, principal.tenantId, principal.clientId));
          return { ok: true };
        },
        opts,
      )),
    );
  } catch (e) {
    if (isBusy(e)) return { ok: false, reason: "busy" };
    if (isSettled(e)) return { ok: false, reason: "settled" };
    throw e;
  }
}

/**
 * CONFIRM after the silent wait (C52 (f)) — through the client's door, open
 * in THIS session (their password and the mailed code, a moment ago). It
 * opens 48 hours later unless somebody denies it first; the answerers and
 * the client's main contacts are told.
 */
export async function confirmSealedAsk(ctx: PortalLoginsCtx, requestId: unknown): Promise<SealedActOutcome> {
  const { principal, sessionId } = ctx;
  if (!validSession(sessionId)) throw new Error(SYSTEM_GUARD);
  if (!validId(requestId)) return { ok: false, reason: "invalid" };
  await withPortalRead(principal, (tx) => authorizePortal(tx, principal, "portal.credential.request_open"));
  try {
    return await boundedVaultWrite((opts) =>
      sealedGuarded(() =>
      withTenant(
        principal.tenantId,
        { type: "system" },
        async (tx): Promise<SealedActOutcome> => {
          if (!(await contactStanding(tx, principal))) return { ok: false, reason: "off" };
          const row = await lockedAskOfClient(tx, principal, requestId);
          if (!row) return { ok: false, reason: "not_found" };
          const now = await sealedClock(tx);
          const kind = askWaitState(row, SEALED_RULES, now).kind;
          if (row.confirmedAt !== null && (kind === "opening" || kind === "open")) return { ok: true }; // already
          if (kind === "waiting") return { ok: false, reason: "not_yet" };
          if (kind !== "confirmable") return { ok: false, reason: "settled" };
          // The door, open in THIS session — and opened AFTER the wait ran
          // out, the guard's own rule: the proof of the password and the
          // mailed code postdates the silence it confirms.
          if (!(await doorOpenedSince(tx, principal.tenantId, principal.contactId, sessionId, confirmableAt(row)))) {
            return { ok: false, reason: "locked" };
          }
          const { opensAt, openUntil } = scheduledByConfirmation(now, SEALED_RULES);
          await tx.sealedOpenRequest.update({
            where: { id: row.id, tenantId: principal.tenantId },
            data: { confirmedAt: now, confirmedByContactId: principal.contactId, opensAt, openUntil },
            select: { id: true },
          });
          await record(tx, {
            action: "credential.open_request_confirmed",
            targetType: "SealedOpenRequest",
            targetId: row.id,
            brokeredForContactId: principal.contactId,
            metadata: { clientId: principal.clientId, opensAt: opensAt.toISOString() },
          });
          // Everyone is warned: "opens in 48 hours" (C52 (f)).
          await enqueueSealedMail(
            tx,
            principal.tenantId,
            row.id,
            "confirmed",
            await answerersOf(tx, principal.tenantId, principal.clientId),
            SEALED_MEMBER_MAIL.confirmed,
          );
          await enqueueSealedMail(tx, principal.tenantId, row.id, "confirmed", await clientPeopleOf(tx, principal.tenantId, principal.clientId));
          return { ok: true };
        },
        opts,
      )),
    );
  } catch (e) {
    if (isBusy(e)) return { ok: false, reason: "busy" };
    if (isSettled(e)) return { ok: false, reason: "settled" };
    throw e;
  }
}

/**
 * THE BROKERED READ of what opened — the client's sealed logins, names and
 * field NAMES only (the shown list's shape, `portal.ts`), while the door is
 * open in this session AND an ask has them open; null otherwise. The
 * logins are INTERNAL, so the contact's own transaction could read none of
 * them: this is the one way a client sees a sealed login's name. Writes
 * nothing — looking at a field is `lookAtSealedLogin`, which is audited.
 */
export async function listSealedPortalLogins(
  ctx: PortalLoginsCtx,
  door: OpenPortalDoor,
): Promise<{ readonly openUntil: Date; readonly logins: readonly PortalLogin[] } | null> {
  const { principal, sessionId } = ctx;
  if (!validSession(sessionId)) throw new Error(SYSTEM_GUARD);
  if (!door) throw new Error("vault: the client's sealed logins are listed only behind an open door");
  await withPortalRead(principal, (tx) => authorizePortal(tx, principal, "portal.credential.view"));
  return withTenant(principal.tenantId, { type: "system" }, async (tx) => {
    if (!(await contactStanding(tx, principal))) return null;
    if ((await doorOpenUntil(tx, principal.tenantId, principal.contactId, sessionId)) === null) return null;
    const open = await openAskPeek(tx, principal.tenantId, principal.clientId);
    if (!open) return null;
    // What the decision covered: the logins sealed when it was made, no later.
    const rows = await tx.credentialItem.findMany({
      where: { tenantId: principal.tenantId, clientId: principal.clientId, ...LIVE_SEALED, sealedAt: { not: null, lte: open.decidedAt } },
      select: { id: true, name: true, username: true, url: true, secretFieldKeys: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: PORTAL_LOGIN_LIMIT,
    });
    return {
      openUntil: open.openUntil,
      logins: rows.map((r) => ({ id: r.id, name: r.name, username: r.username, url: r.url, fields: r.secretFieldKeys })),
    };
  });
}

/**
 * ONE LOOK at one secret field of one sealed login — `reveal` for the eye,
 * `copy` for the clipboard — while the door is open in this session and an
 * ask has the client's sealed logins open. As SYSTEM, after the contact's
 * own proof of `portal.credential.view`: the door, the standing, the
 * opening (taken FOR SHARE, so a denial at that very moment is waited out
 * and then wins), the login still sealed for THIS client and live; then
 * the budget, the decrypt and the audit row in one transaction (C52 (h):
 * every look logged).
 */
export async function lookAtSealedLogin(
  ctx: PortalLoginsCtx,
  credentialId: unknown,
  field: unknown,
  kind: unknown,
): Promise<SealedLookOutcome> {
  const { principal, sessionId } = ctx;
  if (!validSession(sessionId)) throw new Error(SYSTEM_GUARD);
  // The belt every broker carries: Prisma drops an `undefined` filter.
  if (!validId(credentialId)) return { ok: false, reason: "invalid" };
  if (typeof field !== "string" || field.length === 0 || field.length > 64) return { ok: false, reason: "invalid" };
  if (kind !== "reveal" && kind !== "copy") return { ok: false, reason: "invalid" };
  // The cheap filter in front of the count below (a no-op without Upstash).
  if (!(await allow("vault.reveal", `contact:${principal.contactId}`))) return { ok: false, reason: "budget" };
  await withPortalRead(principal, (tx) => authorizePortal(tx, principal, "portal.credential.view"));

  try {
    return await boundedVaultWrite((opts) =>
      withTenant(
        principal.tenantId,
        { type: "system" },
        async (tx): Promise<SealedLookOutcome> => {
          if ((await doorOpenUntil(tx, principal.tenantId, principal.contactId, sessionId)) === null) {
            return { ok: false, reason: "locked" };
          }
          if (!(await contactStanding(tx, principal))) return { ok: false, reason: "not_found" };
          const open = await openAskOf(tx, principal.tenantId, principal.clientId);
          if (!open) return { ok: false, reason: "not_found" };
          // Sealed for THIS client, live — and sealed by the time the ask was
          // decided: one sealed while it is open stays shut.
          const item = await tx.credentialItem.findFirst({
            where: {
              tenantId: principal.tenantId,
              id: credentialId,
              clientId: principal.clientId,
              ...LIVE_SEALED,
              sealedAt: { not: null, lte: open.decidedAt },
            },
            select: { id: true, secretFieldKeys: true },
          });
          if (!item) return { ok: false, reason: "not_found" };
          if (!item.secretFieldKeys.includes(field)) return { ok: false, reason: "invalid" };

          const prefs = await readPreferences(tx, principal.tenantId);
          const now = await lockContactBudget(tx, "portal_logins_reveal", principal.contactId);
          const used = await tx.auditEvent.count({
            where: {
              tenantId: principal.tenantId,
              actorType: "CONTACT",
              actorId: principal.contactId,
              action: { in: ["credential.revealed", "credential.copied"] },
              createdAt: { gte: new Date(now.getTime() - HOUR_MS) },
            },
          });
          const budget = prefs.vault.revealBudgetPerHour;
          if (used >= budget) {
            await record(tx, {
              action: "vault.reveal_budget_exceeded",
              targetType: "CredentialItem",
              targetId: item.id,
              brokeredForContactId: principal.contactId,
              metadata: { used, budget, sealed: true },
            });
            return { ok: false, reason: "budget" };
          }
          const secret = await readSecret(tx, principal.tenantId, item.id);
          const value = secret?.payload.fields[field];
          if (typeof value !== "string") return { ok: false, reason: "invalid" };
          await record(tx, {
            action: kind === "reveal" ? "credential.revealed" : "credential.copied",
            targetType: "CredentialItem",
            targetId: item.id,
            brokeredForContactId: principal.contactId,
            metadata: { field, sealed: true, requestId: open.id },
          });
          return { ok: true, value };
        },
        opts,
      ),
    );
  } catch (e) {
    if (isBusy(e)) return { ok: false, reason: "busy" };
    throw e;
  }
}
