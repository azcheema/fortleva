import { randomUUID } from "node:crypto";

import { record } from "@/audit/record";
import { secretsEqual } from "@/crypto/field-encryption";
import { withTenant, type TenantDb } from "@/db";
import { DomainError } from "@/lib/domain-error";
import { send } from "@/mailer";
import { authorizePortal, withPortalRead, type PortalPrincipal } from "@/portal";
import { lockContactBudget } from "@/portal/contact-budget-lock";
import { readPreferences } from "@/preferences/service";
import { allow, allowStrict } from "@/ratelimit";

import { doorClock, doorOpenUntil, doorWaitingForCode, lockPendingDoor } from "./client-door";
import { boundedVaultWrite } from "./ctx";
import { contactStanding } from "./contact-standing";
import { raiseDoorAlarm } from "./door-alarm";
import { sealedNeedsDoor } from "./sealed-door";
import { readSecret } from "./secret-store";
import {
  hashShareCode,
  newShareCode,
  normalizeShareCode,
  SHARE_CODE_SPACING_MS,
  SHARE_CODE_TTL_MS,
  SHARE_MAX_CODE_ATTEMPTS,
  SHARE_MAX_CODES,
} from "./share-token";

/**
 * THE LOGINS A CLIENT IS SHOWN — THE PORTAL'S VAULT BROKER (Phase 3V slice
 * 91; founder decisions C52 (d) and (k), C59; AUTHZ.md §8's brokered shape).
 *
 * The agency marks a login "client can see" (`visibility.ts`); while the
 * workspace has client logins switched on, the client's MAIN contacts see
 * it on `/portal/logins` (`portal.ts`, under their own principal, where the
 * database decides: `portal_gate` and `portal_vault_switch`). Opening the
 * page is THE CLIENT'S DOOR — C52 (k): their portal password AND a
 * six-digit code mailed to them, each time — and it stays open for the
 * vault's step-up window (`vault.stepUpMinutes`, the staff window, C59 (c))
 * in the portal SESSION it was opened in. Inside, each secret field is one
 * look at a time, audited to the CONTACT, on their own hourly budget. No
 * one-time (authenticator) codes for clients (C59 (d)).
 *
 * WHY HERE, AND AS `system`: the door's rows (`contact_vault_unlock`) and
 * the secret's own table are class A — a contact's own transaction reads
 * zero rows of either, which is the non-negotiable for the secret and
 * simply right for the door. So each export below first proves, in the
 * contact's OWN transaction (`withPortalRead` + `authorizePortal`), that
 * this contact may hold `portal.credential.view` — the profile (PRIMARY
 * only), ACTIVE and invited, the `portal` and `vault` module gates — and,
 * for a look, that the login is one their own transaction can read
 * (`portal_gate` + `portal_vault_switch`); only then does it open a SYSTEM
 * transaction, which RESTATES what it relies on because RLS no longer does
 * (`contactStanding`: both modules, and the contact still a main, active,
 * invited contact of this client — the security review's low: a demotion
 * between the two transactions must not buy one more look; for a look,
 * `openForContacts` adds the switch, and the login still this client's,
 * CLIENT_VISIBLE, live). THE DOOR ITSELF (slice 93) opens when there is
 * something behind it (`doorHasPurpose`): logins shown with the switch on,
 * OR the client's SEALED logins open, OR an ask waiting for the client's
 * confirmation — the sealed layer does not hang on the switch (C61 (d));
 * what the door then opens onto for the sealed layer is the sealed broker's
 * (`sealed-portal-writes.ts`). The
 * switch and the vault module are measured on their own
 * (`portal-logins.dbtest.ts` runs them with the contact's stale open
 * gates); the contact's standing cannot be separated from the contact's own
 * proof just before it — the gap is a race — so that term is reviewed, not
 * measured.
 * `src/portal/brokered-writes.test.ts` pins the order; `readPortalLoginsDoor`
 * is its one brokered READ (no audit row: nothing happened).
 *
 * THE BUDGETS ARE POSTGRES COUNTS of the contact's own audit rows, under a
 * per-contact advisory lock (`lockContactBudget`) — the download's shape,
 * fail-closed with or without Upstash:
 *   - `portal.logins_unlock_started` — written BEFORE the password is
 *     checked, so concurrent guesses cannot all slip under the count:
 *     `LOGINS_UNLOCKS_PER_HOUR`, and `LOGINS_UNLOCKS_PER_DAY` over 24 hours
 *     (the security review: an hourly bound alone renews forever). The
 *     portal answers Better Auth's own password checks only to the server
 *     (`src/auth/closed-endpoints.ts`), so a session thief has no side door
 *     around this count;
 *   - `portal.logins_code_sent` — `LOGINS_CODES_PER_HOUR` mails, and the
 *     share links' per-address bucket (`vault.share_code_to`) in front;
 *   - a door's own row: five codes and five checks, the database's CHECKs
 *     (slice 90's bound, reused: five guesses at six digits per opening);
 *     with the daily cap, at most `LOGINS_UNLOCKS_PER_DAY × 5` code guesses
 *     a day for someone who already holds the password, each opening mailing
 *     the contact;
 *   - a look: `vault.revealBudgetPerHour` per contact, counting their
 *     `credential.revealed | copied` rows.
 *
 * THE CODE MACHINERY IS SLICE 90'S (`share-token.ts`): the same six digits,
 * the same keyed HMAC bound to the ROW's id (`hashShareCode(<door id>,
 * code)` — a door's id is never a link's), the same ten-minute life and
 * half-minute spacing.
 *
 * NEVER UNDER VIEW-AS: every export takes the portal SESSION's id, which
 * only `requirePortalContext()` has; a member looking through a contact
 * (`synthesise.ts`) has none, and `vault-boundary.test.ts` pins this file's
 * callers to the portal's logins route.
 *
 * A REFUSAL THAT SPENT SOMETHING COMMITS: a wrong code, a wrong password
 * and a spent budget are returned out of their transaction, never thrown
 * inside it, so their count and their audit row land (`reveal.ts`'s rule).
 * AFTER a wrong password or a wrong code has committed, the door's ALARM
 * is checked in a transaction of its own (slice 99, C67 (b)–(e);
 * `door-alarm.ts`): five wrong passwords in a day, or five wrong codes in a
 * day, tell the owners and the contact — never inside the refusal's
 * transaction, whose count must not wait on anything new.
 * Nothing here logs, and no answer carries a value except one look's.
 */

/** Password checks at the door, per contact, per rolling hour. */
export const LOGINS_UNLOCKS_PER_HOUR = 10;
/** …and per rolling day: the hourly bound alone renews forever. */
export const LOGINS_UNLOCKS_PER_DAY = 20;
/** Codes mailed for the door, per contact, per rolling hour. */
export const LOGINS_CODES_PER_HOUR = 10;

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const SYSTEM_GUARD = "vault: the client's door needs the portal session it is opened in";

/** Who is at the door: the contact, and the portal session it is bound to. */
export type PortalLoginsCtx = { readonly principal: PortalPrincipal; readonly sessionId: string };

/** The words of the code's mail, in the contact's language — the page composes them. */
export type LoginsCodeMail = (args: {
  readonly code: string;
  readonly tenantName: string;
  readonly minutes: number;
}) => { readonly subject: string; readonly text: string };

/** The password check, made by the caller against the contact's own session (`src/auth/portal-password.ts`). */
/**
 * `unavailable` (slice 99): the check failed for a reason that says nothing
 * about the password — it records no refusal and raises no alarm, and the
 * door answers `busy` ("try again").
 */
export type PasswordCheck = () => Promise<"ok" | "wrong" | "limited" | "unavailable">;

export type DoorStartOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /**
       * wrong_password: counted. limited: the hour's or the day's checks or
       * codes are spent, or the sign-in limiter refused. address_busy: this
       * address has had many codes lately. mail_failed: the mailer threw —
       * the door and its code are stored, so a new code can be asked for.
       * off: no logins are shown here now. busy: lock waits spent.
       */
      readonly reason: "wrong_password" | "limited" | "address_busy" | "mail_failed" | "off" | "busy";
    };

export type DoorResendOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** start_again: no door waiting for a code in this session (or it is spent) — the password again. */
      readonly reason: "start_again" | "wait" | "limited" | "address_busy" | "mail_failed" | "off" | "busy";
    };

export type DoorOpenOutcome =
  | { readonly ok: true; readonly openUntil: Date }
  | {
      readonly ok: false;
      /** malformed: not six digits (counts nothing). no_code: the code expired (counts nothing). wrong_code: counted. */
      readonly reason: "malformed" | "no_code" | "wrong_code" | "start_again" | "off" | "busy";
      /** On `wrong_code`: how many checks this door has left. */
      readonly attemptsLeft?: number;
    };

declare const OPEN_DOOR: unique symbol;
/**
 * The proof `listPortalLogins` asks for: only `readPortalLoginsDoor` makes
 * one, and only for a door open in this session. A speed bump, not a
 * mechanism (a brand does not survive a cast, and it is not bound to the
 * principal it was read for) — the page is the one caller.
 */
export type OpenPortalDoor = { readonly openUntil: Date; readonly [OPEN_DOOR]: true };

/**
 * Where this session's door stands: open (until when), waiting for a code
 * that was mailed (so a reload returns to the code step rather than asking
 * the password again — the code review's low), or closed.
 */
export type PortalDoorState =
  | { readonly state: "open"; readonly door: OpenPortalDoor }
  | { readonly state: "waiting" }
  | { readonly state: "closed" };

export type PortalLookOutcome =
  | { readonly ok: true; readonly value: string }
  | {
      readonly ok: false;
      /** locked: the door is not open in this session. not_found: not a login this contact may open. */
      readonly reason: "locked" | "not_found" | "budget" | "invalid" | "busy";
    };

const isBusy = (e: unknown): boolean => e instanceof DomainError && e.code === "VAULT_BUSY";

const validSession = (sessionId: unknown): boolean =>
  typeof sessionId === "string" && sessionId.length > 0 && sessionId.length <= 64;

/**
 * THE RESTATEMENT for a look at a SHOWN login: client logins switched on,
 * and the contact's standing.
 */
async function openForContacts(tx: TenantDb, principal: PortalPrincipal): Promise<boolean> {
  const prefs = await readPreferences(tx, principal.tenantId);
  if (!prefs.vault.allowPortalCredentials) return false;
  return contactStanding(tx, principal);
}

/**
 * THE DOOR'S RESTATEMENT (slice 93): the contact's standing, and something
 * behind the door — logins shown (client logins switched on), OR this
 * client's SEALED logins open right now, OR an ask of theirs waiting for
 * the client's confirmation, which is made through this door (C52 (f): the
 * password AND a mailed code). The sealed layer does not hang on the
 * client-logins switch (C61 (d)). Nothing is mailed, checked or opened for
 * a door that would open onto nothing.
 */
async function doorHasPurpose(tx: TenantDb, principal: PortalPrincipal): Promise<boolean> {
  if (!(await contactStanding(tx, principal))) return false;
  const prefs = await readPreferences(tx, principal.tenantId);
  if (prefs.vault.allowPortalCredentials) return true;
  return sealedNeedsDoor(tx, principal.tenantId, principal.clientId);
}

/**
 * OPEN THE DOOR, STEP ONE — the password, then the first code by mail. The
 * check is counted BEFORE it is made (its own committed transaction), the
 * password is checked outside any transaction (it is Better Auth's own
 * call), and only a right password makes a door: a row bound to this
 * session, carrying the first code's keyed hash. The code leaves the
 * transaction only to be mailed, after it commits.
 */
export async function startPortalLoginsDoor(
  ctx: PortalLoginsCtx,
  checkPassword: PasswordCheck,
  compose: LoginsCodeMail,
): Promise<DoorStartOutcome> {
  const { principal, sessionId } = ctx;
  if (!validSession(sessionId)) throw new Error(SYSTEM_GUARD);
  await withPortalRead(principal, (tx) => authorizePortal(tx, principal, "portal.credential.view"));

  type Counted = "ok" | "limited" | "off";
  let counted: Counted;
  try {
    counted = await boundedVaultWrite((opts) =>
      withTenant(
        principal.tenantId,
        { type: "system" },
        async (tx): Promise<Counted> => {
          if (!(await doorHasPurpose(tx, principal))) return "off";
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
            metadata: {},
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
  if (verdict === "unavailable") return { ok: false, reason: "busy" };
  if (verdict !== "ok") {
    await withTenant(principal.tenantId, { type: "system" }, (tx) =>
      record(tx, {
        action: "portal.logins_password_refused",
        targetType: "Contact",
        targetId: principal.contactId,
        brokeredForContactId: principal.contactId,
        metadata: {},
      }),
    );
    // The refusal is committed; whether it calls for the alarm is decided
    // from what is stored, in a transaction of its own (`door-alarm.ts`).
    await raiseDoorAlarm(principal);
    return { ok: false, reason: "wrong_password" };
  }

  type Made =
    | { readonly ok: true; readonly to: string; readonly code: string; readonly tenantName: string }
    | { readonly ok: false; readonly reason: "limited" | "address_busy" | "off" };
  let made: Made;
  try {
    made = await boundedVaultWrite((opts) =>
      withTenant(
        principal.tenantId,
        { type: "system" },
        async (tx): Promise<Made> => {
          if (!(await doorHasPurpose(tx, principal))) return { ok: false, reason: "off" };
          const now = await lockContactBudget(tx, "portal_logins", principal.contactId);
          const sent = await tx.auditEvent.count({
            where: {
              tenantId: principal.tenantId,
              actorType: "CONTACT",
              actorId: principal.contactId,
              action: "portal.logins_code_sent",
              createdAt: { gte: new Date(now.getTime() - HOUR_MS) },
            },
          });
          if (sent >= LOGINS_CODES_PER_HOUR) return { ok: false, reason: "limited" };
          // The address on the contact's own row — never one from the
          // request — and the agency's name for the mail.
          const contact = await tx.contact.findFirst({
            where: { tenantId: principal.tenantId, id: principal.contactId, clientId: principal.clientId },
            select: { email: true },
          });
          const tenant = await tx.tenant.findFirst({ where: { id: principal.tenantId }, select: { name: true } });
          if (!contact || !tenant) return { ok: false, reason: "off" };
          if (!(await allowStrict("vault.share_code_to", contact.email.toLowerCase()))) {
            return { ok: false, reason: "address_busy" };
          }
          const id = randomUUID();
          const code = newShareCode();
          await tx.contactVaultUnlock.create({
            data: {
              id,
              tenantId: principal.tenantId,
              contactId: principal.contactId,
              sessionId,
              codeHash: hashShareCode(id, code),
              codeExpiresAt: new Date(now.getTime() + SHARE_CODE_TTL_MS),
              codeSentAt: now,
              codesSent: 1,
              createdAt: now,
            },
            select: { id: true },
          });
          await record(tx, {
            action: "portal.logins_code_sent",
            targetType: "ContactVaultUnlock",
            targetId: id,
            brokeredForContactId: principal.contactId,
            metadata: { sent: 1 },
          });
          return { ok: true, to: contact.email, code, tenantName: tenant.name };
        },
        opts,
      ),
    );
  } catch (e) {
    if (isBusy(e)) return { ok: false, reason: "busy" };
    throw e;
  }
  if (!made.ok) return made;
  const words = compose({ code: made.code, tenantName: made.tenantName, minutes: SHARE_CODE_TTL_MS / 60_000 });
  try {
    await send({ to: made.to, subject: words.subject, text: words.text });
  } catch {
    return { ok: false, reason: "mail_failed" };
  }
  return { ok: true };
}

/**
 * Mail a fresh code for this session's waiting door — at most five per
 * door, half a minute apart, inside the contact's hourly count of codes.
 * The previous code dies with the new one.
 */
export async function resendPortalLoginsCode(ctx: PortalLoginsCtx, compose: LoginsCodeMail): Promise<DoorResendOutcome> {
  const { principal, sessionId } = ctx;
  if (!validSession(sessionId)) throw new Error(SYSTEM_GUARD);
  await withPortalRead(principal, (tx) => authorizePortal(tx, principal, "portal.credential.view"));

  type Sent =
    | { readonly ok: true; readonly to: string; readonly code: string; readonly tenantName: string }
    | Exclude<DoorResendOutcome, { ok: true }>;
  let sent: Sent;
  try {
    sent = await boundedVaultWrite((opts) =>
      withTenant(
        principal.tenantId,
        { type: "system" },
        async (tx): Promise<Sent> => {
          // Nothing is mailed for a door that would open onto nothing.
          if (!(await doorHasPurpose(tx, principal))) return { ok: false, reason: "off" };
          // The budget's lock BEFORE the door's row lock, always (the
          // order `contact-budget-lock.ts` records).
          const now = await lockContactBudget(tx, "portal_logins", principal.contactId);
          const doorId = await lockPendingDoor(tx, principal.tenantId, principal.contactId, sessionId);
          if (doorId === null) return { ok: false, reason: "start_again" };
          const door = await tx.contactVaultUnlock.findFirst({
            where: { tenantId: principal.tenantId, id: doorId },
            select: { id: true, codesSent: true, codeAttempts: true, codeSentAt: true },
          });
          if (!door || door.codesSent >= SHARE_MAX_CODES || door.codeAttempts >= SHARE_MAX_CODE_ATTEMPTS) {
            return { ok: false, reason: "start_again" };
          }
          if (now.getTime() - door.codeSentAt.getTime() < SHARE_CODE_SPACING_MS) return { ok: false, reason: "wait" };
          const used = await tx.auditEvent.count({
            where: {
              tenantId: principal.tenantId,
              actorType: "CONTACT",
              actorId: principal.contactId,
              action: "portal.logins_code_sent",
              createdAt: { gte: new Date(now.getTime() - HOUR_MS) },
            },
          });
          if (used >= LOGINS_CODES_PER_HOUR) return { ok: false, reason: "limited" };
          const contact = await tx.contact.findFirst({
            where: { tenantId: principal.tenantId, id: principal.contactId, clientId: principal.clientId },
            select: { email: true },
          });
          const tenant = await tx.tenant.findFirst({ where: { id: principal.tenantId }, select: { name: true } });
          if (!contact || !tenant) return { ok: false, reason: "start_again" };
          if (!(await allowStrict("vault.share_code_to", contact.email.toLowerCase()))) {
            return { ok: false, reason: "address_busy" };
          }
          const code = newShareCode();
          await tx.contactVaultUnlock.update({
            where: { id: door.id, tenantId: principal.tenantId },
            data: {
              codeHash: hashShareCode(door.id, code),
              codeExpiresAt: new Date(now.getTime() + SHARE_CODE_TTL_MS),
              codeSentAt: now,
              codesSent: { increment: 1 },
            },
            select: { id: true },
          });
          await record(tx, {
            action: "portal.logins_code_sent",
            targetType: "ContactVaultUnlock",
            targetId: door.id,
            brokeredForContactId: principal.contactId,
            metadata: { sent: door.codesSent + 1 },
          });
          return { ok: true, to: contact.email, code, tenantName: tenant.name };
        },
        opts,
      ),
    );
  } catch (e) {
    if (isBusy(e)) return { ok: false, reason: "busy" };
    throw e;
  }
  if (!sent.ok) return sent;
  const words = compose({ code: sent.code, tenantName: sent.tenantName, minutes: SHARE_CODE_TTL_MS / 60_000 });
  try {
    await send({ to: sent.to, subject: words.subject, text: words.text });
  } catch {
    return { ok: false, reason: "mail_failed" };
  }
  return { ok: true };
}

/**
 * OPEN THE DOOR, STEP TWO — check the mailed code against this session's
 * waiting door. Every check of a live code counts; the fifth wrong one
 * spends the door (the password again). The right one opens the door for
 * the vault's step-up window.
 */
export async function openPortalLoginsDoor(ctx: PortalLoginsCtx, rawCode: unknown): Promise<DoorOpenOutcome> {
  const { principal, sessionId } = ctx;
  if (!validSession(sessionId)) throw new Error(SYSTEM_GUARD);
  // FREE, so it may be specific: a typo spends nothing.
  const code = normalizeShareCode(rawCode);
  if (code === null) return { ok: false, reason: "malformed" };
  await withPortalRead(principal, (tx) => authorizePortal(tx, principal, "portal.credential.view"));

  // Set when THIS attempt counted a wrong code (reset per attempt: the
  // bounded write may run the callback again). Internal only — the answer
  // keeps `start_again` as ambiguous as it is meant to be.
  let refused = false;
  let outcome: DoorOpenOutcome;
  try {
    outcome = await boundedVaultWrite((opts) =>
      withTenant(
        principal.tenantId,
        { type: "system" },
        async (tx): Promise<DoorOpenOutcome> => {
          refused = false;
          // Nothing opens onto nothing: a door left waiting when client logins
          // were switched off (and nothing sealed needs it) stays shut, and
          // its checks are not spent.
          if (!(await doorHasPurpose(tx, principal))) return { ok: false, reason: "off" };
          const doorId = await lockPendingDoor(tx, principal.tenantId, principal.contactId, sessionId);
          if (doorId === null) return { ok: false, reason: "start_again" };
          // Read AFTER the lock: a second check that waited must see the first's count.
          const door = await tx.contactVaultUnlock.findFirst({
            where: { tenantId: principal.tenantId, id: doorId },
            select: { id: true, codeHash: true, codeExpiresAt: true, codeAttempts: true },
          });
          if (!door || door.codeAttempts >= SHARE_MAX_CODE_ATTEMPTS) return { ok: false, reason: "start_again" };
          const now = await doorClock(tx);
          if (door.codeHash === null || door.codeExpiresAt === null || door.codeExpiresAt.getTime() <= now.getTime()) {
            return { ok: false, reason: "no_code" };
          }
          const attempt = door.codeAttempts + 1;
          if (!secretsEqual(hashShareCode(door.id, code), door.codeHash)) {
            await tx.contactVaultUnlock.update({
              where: { id: door.id, tenantId: principal.tenantId },
              data: { codeAttempts: attempt },
              select: { id: true },
            });
            await record(tx, {
              action: "portal.logins_code_refused",
              targetType: "ContactVaultUnlock",
              targetId: door.id,
              brokeredForContactId: principal.contactId,
              metadata: { attempt },
            });
            refused = true;
            const attemptsLeft = SHARE_MAX_CODE_ATTEMPTS - attempt;
            return attemptsLeft > 0 ? { ok: false, reason: "wrong_code", attemptsLeft } : { ok: false, reason: "start_again" };
          }
          // The staff window (C59 (c)), read now: an agency that shortens it
          // shortens the next opening.
          const prefs = await readPreferences(tx, principal.tenantId);
          const openUntil = new Date(now.getTime() + prefs.vault.stepUpMinutes * 60_000);
          await tx.contactVaultUnlock.update({
            where: { id: door.id, tenantId: principal.tenantId },
            data: { codeAttempts: attempt, openedAt: now, openUntil, codeHash: null, codeExpiresAt: null },
            select: { id: true },
          });
          await record(tx, {
            action: "portal.logins_opened",
            targetType: "ContactVaultUnlock",
            targetId: door.id,
            brokeredForContactId: principal.contactId,
            metadata: { minutes: prefs.vault.stepUpMinutes },
          });
          return { ok: true, openUntil };
        },
        opts,
      ),
    );
  } catch (e) {
    if (isBusy(e)) return { ok: false, reason: "busy" };
    throw e;
  }
  // A wrong code is committed; whether it calls for the alarm — the day's
  // fifth wrong code, or an earlier refusal's check could not run — is
  // decided from what is stored, in a transaction of its own that never
  // fails this answer (`door-alarm.ts`).
  if (refused) await raiseDoorAlarm(principal);
  return outcome;
}

/**
 * THE BROKERED READ — where this contact's door stands in THIS session:
 * open (until when), waiting for a code it was mailed, or closed — closed,
 * too, when nothing would be behind it (the switch off, a module closed,
 * the contact no longer a main one). Writes nothing: asking is not opening.
 */
export async function readPortalLoginsDoor(ctx: PortalLoginsCtx): Promise<PortalDoorState> {
  const { principal, sessionId } = ctx;
  if (!validSession(sessionId)) throw new Error(SYSTEM_GUARD);
  await withPortalRead(principal, (tx) => authorizePortal(tx, principal, "portal.credential.view"));
  return withTenant(principal.tenantId, { type: "system" }, async (tx): Promise<PortalDoorState> => {
    if (!(await doorHasPurpose(tx, principal))) return { state: "closed" };
    const openUntil = await doorOpenUntil(tx, principal.tenantId, principal.contactId, sessionId);
    if (openUntil !== null) return { state: "open", door: { openUntil } as OpenPortalDoor };
    return (await doorWaitingForCode(tx, principal.tenantId, principal.contactId, sessionId))
      ? { state: "waiting" }
      : { state: "closed" };
  });
}

/**
 * ONE LOOK at one secret field of one shown login — `reveal` for the eye,
 * `copy` for the clipboard, two audited acts as on the staff side — while
 * the door is open in this session.
 *
 * Proved first in the contact's own transaction: the capability and the
 * login itself, which their transaction reads only if it is their client's,
 * CLIENT_VISIBLE, live and the switch is on. Then, as `system`, restated —
 * the door open in THIS session, `openForContacts`, the login still shown
 * to this client, live and unarchived, the field set — the budget, the
 * decrypt and the audit row in one transaction.
 */
export async function lookAtPortalLogin(
  ctx: PortalLoginsCtx,
  credentialId: string,
  field: string,
  kind: "reveal" | "copy",
): Promise<PortalLookOutcome> {
  const { principal, sessionId } = ctx;
  if (!validSession(sessionId)) throw new Error(SYSTEM_GUARD);
  // The belt every broker carries: Prisma drops an `undefined` filter, so a
  // blank id reaching a `where` would match SOME login rather than none.
  if (typeof credentialId !== "string" || credentialId.length === 0 || credentialId.length > 64) {
    return { ok: false, reason: "invalid" };
  }
  if (typeof field !== "string" || field.length === 0 || field.length > 64) return { ok: false, reason: "invalid" };
  if (kind !== "reveal" && kind !== "copy") return { ok: false, reason: "invalid" };
  // The cheap filter in front of the count below (a no-op without Upstash).
  if (!(await allow("vault.reveal", `contact:${principal.contactId}`))) return { ok: false, reason: "budget" };

  const visible = await withPortalRead(principal, async (tx) => {
    await authorizePortal(tx, principal, "portal.credential.view");
    return tx.credentialItem.findFirst({
      where: { id: credentialId, deletedAt: null, archivedAt: null },
      select: { id: true },
    });
  });
  if (!visible) return { ok: false, reason: "not_found" };

  try {
    return await boundedVaultWrite((opts) =>
      withTenant(
        principal.tenantId,
        { type: "system" },
        async (tx): Promise<PortalLookOutcome> => {
          const openUntil = await doorOpenUntil(tx, principal.tenantId, principal.contactId, sessionId);
          if (openUntil === null) return { ok: false, reason: "locked" };
          if (!(await openForContacts(tx, principal))) return { ok: false, reason: "not_found" };
          // The gate's terms, restated: as `system` nothing else applies them.
          const item = await tx.credentialItem.findFirst({
            where: {
              tenantId: principal.tenantId,
              id: credentialId,
              clientId: principal.clientId,
              visibility: "CLIENT_VISIBLE",
              deletedAt: null,
              archivedAt: null,
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
              metadata: { used, budget },
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
            metadata: { field },
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
