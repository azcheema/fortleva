import { runtimeClient } from "./client";

/**
 * IS FORTLEVA BLOCKED FROM MAILING THIS ADDRESS? (Phase 5 slice 103, founder
 * decision C71 (e)) — the question `src/mailer`'s `send()` asks before every
 * message, so that EVERY mail stops for a blocked address, the ones sent
 * straight from a request included: a password reset, a sign-in code, an
 * invitation, a share link's code. The outbox and the fan-outs already ask
 * inside their own transactions; these do not run in one.
 *
 * **WHY IT IS HERE, AND WHY IT IS ALLOWED TO BE.** `email_suppression` is a
 * GLOBAL table (no tenant column, `MODEL_CLASSES.global`), so the where-
 * injection leaves it alone and its row-level security is the whole gate:
 * `allow_runtime` admits every `app_runtime` read, and `portal_deny` refuses
 * only a transaction running as a contact — here there is no transaction and
 * no principal, so `app.principal` is unset and the read is admitted. It is
 * ONE read of one primary key, it writes nothing, and it lives in `src/db`
 * because the mailer runs with no tenant, no user and no platform principal
 * to open a seam for — and `withPlatform` would audit every mail. The only
 * writer of the table is the platform (`src/jobs/mail-feedback.ts`, and
 * support's RUNBOOK step); `app_runtime` holds SELECT alone on it.
 */
export async function isAddressSuppressed(email: string): Promise<boolean> {
  const row = await runtimeClient.emailSuppression.findUnique({
    where: { email: email.trim().toLowerCase() },
    select: { email: true },
  });
  return row !== null;
}
