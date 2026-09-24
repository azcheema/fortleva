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
 * a user?" through a constant body. Two callers today: the portal's reset
 * mail (`deliverPortalReset`, slice 57) and the member plane's verification
 * mail (slice 58), whose sign-up branch for a new address was the one that
 * waited.
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
 *   - the member plane's verification mail: they CANNOT ask again — there is
 *     no re-send on that plane since slice 58 (`src/auth/index.ts` says why),
 *     so a lost link is an operator's job, RUNBOOK §8, until the re-send owed
 *     with OPEN_QUESTIONS C30 exists. Before this slice the send was awaited,
 *     so no freeze could cut it off — but a FAILED send was swallowed and
 *     logged by the library just the same, and the person saw "check your
 *     email" either way.
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
