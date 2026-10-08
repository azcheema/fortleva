import { withPlatform } from "@/db";
import type { SesFeedback } from "@/mailer/sns";

/**
 * AMAZON SES'S FEEDBACK, WRITTEN DOWN (Phase 5 slice 103, founder decision
 * C71; DATA_MODEL §6.18) — the suppression list's one writer in the product.
 * `POST /api/mail-feedback` calls it with a message it has already verified
 * came from our topic (`src/mailer/sns.ts`); it blocks each address for every
 * workspace, because SES's sending reputation is shared (C71 (e): all mail,
 * password resets and sign-in codes included — `send()` asks before every
 * message).
 *
 * - **The first reason stands.** An address already on the list keeps its row
 *   as it is — a support block (MANUAL) is not rewritten by a later bounce, and
 *   a duplicate delivery of the same SNS message (SNS delivers at least once)
 *   changes nothing.
 * - **Nothing is ever removed here.** Lifting a block is support's, by hand
 *   (C71 (f); RUNBOOK §8), from this list AND from SES's own account list.
 * - **Audited as the platform's**: `withPlatform` writes one
 *   `platform.system_job` row in the same transaction (PLATFORM visibility, no
 *   tenant — the list belongs to no workspace). Its reason names the kind and
 *   the COUNT, never an address: the row on the list is the record of which.
 *
 * Returns how many addresses were newly blocked.
 */
export async function recordMailFeedback(feedback: SesFeedback): Promise<number> {
  // Lower-cased HERE as well as by the webhook (the code review's low): every
  // reader compares lower-case, so a mixed-case row would block nobody.
  const addresses = [...new Set(feedback.addresses.map((a) => a.trim().toLowerCase()).filter((a) => a.length > 0))];
  if (addresses.length === 0) return 0;
  const kind = feedback.reason === "COMPLAINT" ? "complaint" : "permanent bounce";
  return withPlatform(
    { type: "system", job: "mail-feedback" },
    `record Amazon SES feedback: ${kind} for ${addresses.length} address(es)`,
    async (tx) => {
      const { count } = await tx.emailSuppression.createMany({
        data: addresses.map((email) => ({ email, reason: feedback.reason, source: "ses-sns" })),
        skipDuplicates: true,
      });
      return count;
    },
    { readOnly: false },
  );
}
