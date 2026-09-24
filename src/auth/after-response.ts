import { after } from "next/server";

/**
 * Run `task` once the response has been sent — through Next's `after()`,
 * which on Vercel hands the promise to `waitUntil` so the function is kept
 * alive until it settles, and on a long-lived Node server simply runs it.
 *
 * WHY AUTH MAIL GOES THIS WAY. Better Auth AWAITS the mail callbacks it is
 * given (`runInBackgroundOrAwait` with no `advanced.backgroundTasks`), so a
 * send inside one puts a mail-transport round trip on the response exactly
 * when the address belongs to somebody — a stopwatch that answers "is this
 * a user?" through a constant body. Three callers today: the portal's reset
 * mail (`deliverPortalReset`, slice 57), the member plane's confirmation
 * mail (slice 58; sign-up's branch for a new address was the one that
 * waited, and since C30 an unconfirmed sign-in sends it too) and the member
 * plane's reset mail (`deliverMemberReset`, C30).
 *
 * **NOT A BARE `void promise`**, which is what the first cut of slice 57 did
 * and what a fresh review caught: ARC-21 rejects "fire-and-forget from the
 * request" by name, because Vercel may freeze the function the moment the
 * response goes out, and the mail would then happen late or never, with
 * nothing logged. `after()` is not durable either (ARC-21 says so too), and
 * the durable path, the `EmailOutbox`, would keep the raw token or link in
 * `email_outbox.params` until the drain ran. What makes a lost mail
 * acceptable differs by caller, and for one of them it is not a comfort:
 *   - the portal's reset: the person simply asks again (and a failed send
 *     removes its row, so the cap does not count it);
 *   - the member plane's reset and confirmation mails (C30): the same — ask
 *     for another reset, or sign in again for another confirmation link — and
 *     a failed send gives its slot in the per-recipient ledger back
 *     (`./mail-budget`), so lost mails cannot use up the hour. (Between slice
 *     58 and C30 a lost confirmation mail was a dead end with only an
 *     operator's remedy.) A task cut off mid-flight — the non-durability
 *     accepted here — keeps its slot; that is the residual.
 *
 * `after()` throws synchronously outside a request scope (a dbtest, a
 * script), and there the task is simply started; nothing in those contexts
 * freezes a process.
 *
 * `label` is logged if the task fails. Name a principal by id only — never
 * an address, a token or a link: this line reaches CI logs, which are
 * world-readable.
 */
export function afterResponse(label: string, task: () => Promise<unknown>): void {
  const run = async (): Promise<void> => {
    try {
      await task();
    } catch (error) {
      console.error(label, error);
    }
  };
  try {
    after(run);
  } catch (error) {
    // Outside a request scope is the expected case (dbtests, scripts). Any
    // OTHER refusal means this is running as exactly the detached promise
    // ARC-21 rejects — so it says so, rather than degrading silently.
    if (!String(error).includes("outside a request scope")) {
      console.warn("[auth] after() refused a task; running it detached", error);
    }
    void run();
  }
}
