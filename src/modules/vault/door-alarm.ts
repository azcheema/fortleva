import { record } from "@/audit/record";
import { withTenant, type TenantDb } from "@/db";
import { newId } from "@/lib/ids";
import { DOOR_ALARM_CONTACT_MAIL, DOOR_ALARM_MEMBER_MAIL } from "@/notify/door-alarm-mail-keys";
import { emit } from "@/notify/emit";
import type { PortalPrincipal } from "@/portal";
import { lockContactBudget } from "@/portal/contact-budget-lock";

import { boundedVaultWrite } from "./ctx";

/**
 * THE DOOR'S ALARM (Phase 3V slice 99; founder decision C67 (b)–(e)).
 *
 * A client's logins page has a door: their portal password, then a code
 * mailed to them (`portal-writes.ts`; the sealed ask asks the password
 * too, `sealed-portal-writes.ts`). Someone who keeps failing at it while
 * signed in as a client person is most likely NOT that person — a stolen
 * password guessing at the mailbox's code, or a stolen session guessing at
 * the password. So when, within `ALARM_WINDOW_HOURS`, the contact's
 * session has
 *   - typed the portal password wrong `ALARM_WRONG_PASSWORDS` times there
 *     (`portal.logins_password_refused`, the door's and the sealed ask's —
 *     one action, so both count) — the sign `passwords`; or
 *   - typed a wrong mailed code `ALARM_WRONG_CODES` times, however many
 *     openings they are spread over (`portal.logins_code_refused`) — the
 *     sign `codes`. C67 (d): the first cut counted only an opening whose
 *     five tries were ALL spent, and someone holding the password could stop
 *     at four, start again, and guess ~80 codes a day unseen (the security
 *     review's medium). Five wrong codes in a day cover a spent opening too.
 * the owners are told — an inbox row (`contact.logins_alarm`) and a
 * security mail whatever their email level, so they can pause that
 * person's access — and so is the person, by mail in their language: if
 * this wasn't you, set a new password. At most ONE alarm per SIGN per
 * contact per `ALARM_WINDOW_HOURS` (C67 (e)): wrong codes after a morning's
 * wrong passwords mean they now know the password, and that still reaches
 * the owners — so at most two a day. The `portal.logins_alarm_raised` audit
 * rows, each naming the signs it reported, are what that rule counts. A
 * sign seen while it was already reported in the window is reported again
 * by the first check after the window has moved past that report — a real
 * event, reported once a day at most (the code review's nit, intended).
 *
 * WHY ITS OWN TRANSACTION, AFTER THE REFUSAL COMMITTED (the design review):
 * the refusal's transaction is the brute-force bound — a wrong code's
 * count, a wrong password's audit row. Anything added to it that can wait
 * on a lock could, on a timeout, roll that count back and hand an attacker
 * a free guess. So the brokers call this after their own transaction, and
 * it takes nothing but its own advisory key
 * (`portal_logins_alarm`, `contact-budget-lock.ts`) before it reads.
 *
 * WHY IT RE-DERIVES EVERYTHING FROM STORED ROWS (the design review's
 * medium): the caller says only "a refusal happened". Whether an alarm is
 * due is read from what committed — so an alarm that could not be raised
 * (its lock busy, the process gone between the two transactions) is raised
 * by the next refusal within the window instead of being lost. It is
 * called after EVERY refusal for the same reason. AND IT NEVER FAILS THE
 * REFUSAL (the code and security reviews' low, re-dispositioned from "fail
 * loud"): whatever goes wrong here — its lock busy, a timeout on the link —
 * is swallowed, because the refusal it follows has committed and the
 * person must get that answer ("wrong password", "1 try left", "start
 * again"), never an error in its place; the next refusal checks again. A
 * bug here is the dbtests' to catch (`door-alarm.dbtest.ts`), not the
 * client's screen.
 *
 * SYSTEM, never the contact: the contact did not raise it, so the audit
 * row's actor is the system and it names the contact as its target. It
 * writes nothing a contact can read (the audit row, the members' inbox,
 * the outbox). Pinned in `src/portal/brokered-writes.test.ts` (`ALARMS`:
 * what it imports) and `vault-boundary.test.ts` (who calls it). It logs
 * one line, and only when its own check failed — the error's name and
 * code, never a message (the vault's one logger, pinned there by name). It
 * reads no secret.
 */

/** Wrong portal passwords at the door, per contact, within the window, that raise the alarm. */
export const ALARM_WRONG_PASSWORDS = 5;
/** Wrong mailed codes, per contact, within the window, over any number of openings (C67 (d)). */
export const ALARM_WRONG_CODES = 5;
/** The window both signs are counted over — and the one-alarm-per-sign rule's. */
export const ALARM_WINDOW_HOURS = 24;

const HOUR_MS = 60 * 60_000;

type Sign = "passwords" | "codes";
const isSign = (v: unknown): v is Sign => v === "passwords" || v === "codes";

/**
 * Check this contact's door, and raise the alarm if it is due — see the
 * file's comment. Call it after the refusal's own transaction committed.
 * Never throws.
 */
export async function raiseDoorAlarm(principal: PortalPrincipal): Promise<void> {
  try {
    await boundedVaultWrite((opts) =>
      withTenant(principal.tenantId, { type: "system" }, (tx) => alarmIfDue(tx, principal), opts),
    );
  } catch (e) {
    // Swallowed on purpose — see the file's comment: the refusal stands,
    // and the next one checks again. But never silently (the fix-pass
    // review's low): a failure that repeats would otherwise mean no alarm,
    // ever, with nothing to show it. The error's NAME and CODE only, never
    // its message — a Prisma message prints the query's arguments — the
    // jobs' own shape (`src/jobs/vault-retention.ts`).
    const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
    console.error(`vault: the door's alarm check failed: ${e instanceof Error ? e.name : typeof e}${code}`);
  }
}

async function alarmIfDue(tx: TenantDb, principal: PortalPrincipal): Promise<void> {
  const { tenantId, contactId, clientId } = principal;
  // The key first, then every read: two checks of one contact queue here,
  // and the second reads the first's alarm row (READ COMMITTED: a fresh
  // snapshot per statement, taken after the lock was granted).
  const now = await lockContactBudget(tx, "portal_logins_alarm", contactId);
  const since = new Date(now.getTime() - ALARM_WINDOW_HOURS * HOUR_MS);

  // What the window has already reported, sign by sign — from rows only the
  // SYSTEM writes (the code review's nit: a row of this action written by
  // anyone else must not silence an alarm).
  const reported = new Set<Sign>(
    (
      await tx.auditEvent.findMany({
        where: {
          tenantId,
          actorType: "SYSTEM",
          action: "portal.logins_alarm_raised",
          targetType: "Contact",
          targetId: contactId,
          createdAt: { gte: since },
        },
        select: { metadata: true },
      })
    ).flatMap((r) => {
      const signs = (r.metadata as { signs?: unknown } | null)?.signs;
      return Array.isArray(signs) ? signs.filter(isSign) : [];
    }),
  );
  if (reported.has("passwords") && reported.has("codes")) return;

  // Brokered rows carry the CONTACT as their actor (`brokeredForContactId`).
  const refusals = (action: "portal.logins_password_refused" | "portal.logins_code_refused") =>
    tx.auditEvent.count({
      where: { tenantId, actorType: "CONTACT", actorId: contactId, action, createdAt: { gte: since } },
    });
  const signs: Sign[] = [];
  if (!reported.has("passwords") && (await refusals("portal.logins_password_refused")) >= ALARM_WRONG_PASSWORDS) {
    signs.push("passwords");
  }
  if (!reported.has("codes") && (await refusals("portal.logins_code_refused")) >= ALARM_WRONG_CODES) {
    signs.push("codes");
  }
  if (signs.length === 0) return;

  const alarmId = newId();
  await record(tx, {
    action: "portal.logins_alarm_raised",
    targetType: "Contact",
    targetId: contactId,
    metadata: { clientId, alarmId, signs },
  });

  const owners = await tx.member.findMany({
    where: {
      tenantId,
      status: "ACTIVE",
      memberRoles: { some: { role: { isSystem: true, templateKey: "owner" } } },
    },
    select: { id: true, user: { select: { email: true, locale: true } } },
    orderBy: { id: "asc" },
  });
  // The inbox: one row per owner, per ALARM (the design review's low — a key
  // per contact would fold a new day's alarm into yesterday's unread row).
  await emit(tx, tenantId, {
    kind: "contact.logins_alarm",
    entity: { type: "Contact", id: contactId },
    clientId,
    memberIds: owners.map((o) => o.id),
    params: { clientId },
    dedupeKey: `logins_alarm:${alarmId}`,
  });

  const tenant = await tx.tenant.findFirst({ where: { id: tenantId }, select: { defaultLocale: true } });
  const contact = await tx.contact.findFirst({
    where: { tenantId, id: contactId },
    select: { email: true, locale: true },
  });
  const localeOf = (raw: string | null | undefined, fallback: string): "en" | "sv" =>
    (raw ?? fallback) === "sv" ? "sv" : "en";
  const mails = [
    ...owners.flatMap((o) =>
      o.user.email
        ? [
            {
              receiverType: "MEMBER" as const,
              receiverId: o.id,
              email: o.user.email.toLowerCase(),
              locale: localeOf(o.user.locale, "en"),
              kind: DOOR_ALARM_MEMBER_MAIL,
              params: { clientId },
            },
          ]
        : [],
    ),
    ...(contact
      ? [
          {
            receiverType: "CONTACT" as const,
            receiverId: contactId,
            email: contact.email.toLowerCase(),
            locale: localeOf(contact.locale, tenant?.defaultLocale ?? "en"),
            kind: DOOR_ALARM_CONTACT_MAIL,
            params: {},
          },
        ]
      : []),
  ];
  if (mails.length === 0) return;
  const suppressed = new Set(
    (
      await tx.emailSuppression.findMany({
        where: { email: { in: mails.map((m) => m.email) } },
        select: { email: true },
      })
    ).map((s) => s.email),
  );
  const data = mails
    .filter((m) => !suppressed.has(m.email))
    .map((m) => ({
      tenantId,
      idempotencyKey: `logins_alarm:${alarmId}:${m.receiverType}:${m.receiverId}`,
      receiverType: m.receiverType,
      receiverId: m.receiverId,
      toEmail: m.email,
      kind: m.kind,
      locale: m.locale,
      params: m.params,
      notificationIds: [],
    }));
  if (data.length > 0) await tx.emailOutbox.createMany({ data, skipDuplicates: true });
}
