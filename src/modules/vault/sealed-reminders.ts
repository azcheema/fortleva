import { record } from "@/audit/record";
import { withTenant } from "@/db";
import { moduleOpenUnderSystem } from "@/entitlements/resolver";
import { askWaitState, remindersDue } from "@/lib/ask-and-wait";
import { DomainError } from "@/lib/domain-error";
import { SEALED_MEMBER_MAIL } from "@/notify/sealed-mail-keys";

import { boundedVaultWrite } from "./ctx";
import { ASK_STAMPS, lockAsk, sealedClock } from "./sealed-door";
import { answerersOf, clientPeopleOf, enqueueSealedMail } from "./sealed-mail";
import { SEALED_RULES, SEALED_UNSCHEDULED_HORIZON_DAYS } from "./sealed-rules";

/**
 * THE SEALED ASKS' MAIL, ONE TENANT (Phase 3V slice 93; founder decisions
 * C52 (f) and (h)). Run by the daily job (`src/jobs/sealed-requests.ts`),
 * which found the tenant under the audited platform seam; everything here
 * runs under THIS tenant's SYSTEM principal, RLS live.
 *
 * IT ONLY MAILS. Nothing here opens, closes or decides anything: an ask's
 * state is derived from its stamps at read time (`@/lib/ask-and-wait`),
 * so a run that is late, missed or doubled changes when a mail goes out —
 * never when the logins open or for how long.
 *   - A REMINDER to every answerer while the ask is unsettled — waiting,
 *     confirmable, or confirmed and opening — on day 3 and 6 and then
 *     daily (day 0 went with the ask itself). A run that was missed for
 *     days sends ONE mail and records every reminder it has passed
 *     (`remindersDue`), never a burst.
 *   - "IT HAS OPENED" — to every answerer, with the reminder to change
 *     those passwords once it has locked again (C52 (h)), and the client's
 *     main contacts — once, for an ask the 48 hours opened (an approval
 *     tells everyone itself and stamps `openedNoticeAt`).
 * ONE TRANSACTION PER ASK, its row locked first: the mail, the stamp and
 * `credential.open_request_reminded` commit together or not at all, and
 * two runs racing send each mail once (the second re-reads what the first
 * recorded; the outbox's idempotency key besides). With the vault module
 * closed nothing is sent — nobody could act on the mail; the asks' clocks
 * run on regardless, as they do for everything else here.
 */

const SYSTEM = { type: "system" } as const;

/** The asks the job may still owe a mail: unended, and either unscheduled and not long lapsed, or scheduled and not yet announced. */
export const owedMailWhere = (now: Date) => ({
  deniedAt: null,
  withdrawnAt: null,
  OR: [
    { opensAt: null, askedAt: { gt: new Date(now.getTime() - SEALED_UNSCHEDULED_HORIZON_DAYS * 86_400_000) } },
    { opensAt: { not: null }, openedNoticeAt: null },
  ],
});

export type SealedMailRun = {
  /** Reminder mails sent (one per ask per run at most). */
  readonly reminders: number;
  /** "It has opened" notices sent. */
  readonly opened: number;
};

/** Today's sealed-ask mail for one tenant. Idempotent — run it twice, or twice at once, and each mail goes out once. */
export async function sendSealedAskMail(tenantId: string): Promise<SealedMailRun> {
  if (typeof tenantId !== "string" || tenantId.length === 0) throw new TypeError("vault: tenantId must be a non-empty string");
  const ids = await withTenant(tenantId, SYSTEM, async (tx) => {
    if (!(await moduleOpenUnderSystem(tx, tenantId, "vault"))) return [];
    // Unended, and either not yet scheduled (still waiting for an answer
    // or a confirmation, and not long lapsed) or not yet announced as open.
    const rows = await tx.sealedOpenRequest.findMany({
      where: { tenantId, ...owedMailWhere(new Date()) },
      orderBy: { id: "asc" }, // one lock order for every run
      select: { id: true },
    });
    return rows.map((r) => r.id);
  });

  const out = { reminders: 0, opened: 0 };
  for (const id of ids) {
    // A bounded wait for the ask's row (an answer or a look may hold it): a
    // busy ask is left for the next run, never a pooled connection parked.
    let sent: "reminder" | "opened" | null;
    try {
      sent = await boundedVaultWrite((opts) =>
        withTenant(
          tenantId,
          SYSTEM,
          async (tx) => {
            if (!(await lockAsk(tx, tenantId, id))) return null;
            const row = await tx.sealedOpenRequest.findFirst({
              where: { tenantId, id },
              select: { id: true, clientId: true, remindersSent: true, openedNoticeAt: true, ...ASK_STAMPS },
            });
            if (!row) return null;
            const now = await sealedClock(tx);
            const kind = askWaitState(row, SEALED_RULES, now).kind;

            if (kind === "waiting" || kind === "confirmable" || kind === "opening") {
              const due = remindersDue(row.askedAt, now);
              if (due <= row.remindersSent) return null;
              const answerers = await answerersOf(tx, tenantId, row.clientId);
              // The words for where it stands (the code review's low): while the
              // wait runs, after it, and in the 48 hours after a confirmation.
              const template =
                kind === "waiting"
                  ? SEALED_MEMBER_MAIL.reminder
                  : kind === "confirmable"
                    ? SEALED_MEMBER_MAIL.confirmable
                    : SEALED_MEMBER_MAIL.opening;
              await enqueueSealedMail(tx, tenantId, row.id, `reminder-${due}`, answerers, template);
              await tx.sealedOpenRequest.update({
                where: { id: row.id, tenantId },
                data: { remindersSent: due, lastRemindedAt: now },
                select: { id: true },
              });
              await record(tx, {
                action: "credential.open_request_reminded",
                targetType: "SealedOpenRequest",
                targetId: row.id,
                metadata: { clientId: row.clientId, kind: "reminder", reminder: due, receivers: answerers.length },
              });
              return "reminder" as const;
            }

            // Opened by the 48 hours (or opened and closed again while no run
            // came): tell the agency and the client once.
            if ((kind === "open" || kind === "closed") && row.openedNoticeAt === null) {
              const answerers = await answerersOf(tx, tenantId, row.clientId);
              const people = await clientPeopleOf(tx, tenantId, row.clientId);
              await enqueueSealedMail(tx, tenantId, row.id, "opened", answerers, SEALED_MEMBER_MAIL.opened);
              await enqueueSealedMail(tx, tenantId, row.id, "opened", people);
              await tx.sealedOpenRequest.update({
                where: { id: row.id, tenantId },
                data: { openedNoticeAt: now },
                select: { id: true },
              });
              await record(tx, {
                action: "credential.open_request_reminded",
                targetType: "SealedOpenRequest",
                targetId: row.id,
                metadata: { clientId: row.clientId, kind: "opened", receivers: answerers.length + people.length },
              });
              return "opened" as const;
            }
            return null;
          },
          opts,
        ),
      );
    } catch (e) {
      if (e instanceof DomainError && e.code === "VAULT_BUSY") continue;
      throw e;
    }
    if (sent === "reminder") out.reminders += 1;
    if (sent === "opened") out.opened += 1;
  }
  return out;
}
