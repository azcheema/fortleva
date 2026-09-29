/**
 * The pure half of the Contacts tab's "Last signed in …" line — no
 * database, so the rule that turns a read into one of four states is
 * unit-tested on its own (`sign-in-window.test.ts`). The read is
 * `contact-sign-ins.ts`.
 *
 * **THE ANSWER COVERS A WINDOW, AND SAYS SO.** SECURITY.md §7 keeps
 * auth events for twelve months. The read is bounded to that window
 * whether or not the retention job has run yet, so the tab says the same
 * true thing before and after the job starts deleting — PROVIDED the
 * job's cutoff is never later than `signInWindowStart(now)` (SECURITY.md
 * §7 states that invariant beside the schedule).
 */

/**
 * SECURITY.md §7: auth/session/download events are kept 12 months. The
 * copy says "for a year" / "på ett år", so a change here is a change to
 * `clients.contacts.signIn.notWithinYear` in both catalogues.
 */
export const SIGN_IN_WINDOW_MONTHS = 12;

/** `now` minus the window, in calendar months (UTC). */
export const signInWindowStart = (now: Date): Date => {
  const since = new Date(now);
  since.setUTCMonth(since.getUTCMonth() - SIGN_IN_WINDOW_MONTHS);
  return since;
};

export type SignInState =
  | { readonly kind: "at"; readonly at: Date }
  | { readonly kind: "never" }
  | { readonly kind: "notWithin" }
  /** Never given access: the status chip already says so. */
  | { readonly kind: "none" };

/**
 * With no sign-in inside the window, "Never" needs evidence, and there
 * are two kinds:
 *
 *  · **`activatedAt` is null** — nobody has ever accepted an invitation
 *    as this contact, and a portal session can only be created for an
 *    ACTIVE contact, which only an acceptance makes (RESUME returns a
 *    SUSPENDED contact to ACTIVE, and SUSPENDED is reachable only from
 *    ACTIVE). Proof at any age: a contact added years ago and invited
 *    last week has never signed in.
 *  · **the contact was created inside the window** — every sign-in they
 *    could have made is in the rows read. This one is only as good as the
 *    audit trail: the sink writes each row inside `guarded()`
 *    (`src/auth/audit-hooks.ts`), which swallows a failed write so a
 *    sign-in never breaks on an audit problem — and a dropped row would
 *    read here as "Never signed in".
 *
 * `activatedAt` alone is not enough the other way: an acceptance stamps
 * it afresh, so after an end-of-access and a re-invite it is the LATER
 * acceptance, and sign-ins from the first spell predate it. Hence the
 * window is measured against `createdAt`, and otherwise the answer is
 * "not for a year" — never "Never", which the log can no longer prove.
 */
export function signInState(
  contact: { readonly createdAt: Date; readonly activatedAt: Date | null; readonly portalStatus: string },
  last: Date | undefined,
  since: Date,
): SignInState {
  // A row wins over every status: what the log holds is what happened.
  if (last !== undefined) return { kind: "at", at: last };
  if (contact.portalStatus === "NO_ACCESS") return { kind: "none" };
  if (contact.activatedAt === null || contact.createdAt >= since) return { kind: "never" };
  return { kind: "notWithin" };
}
