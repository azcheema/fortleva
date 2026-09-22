/**
 * THE TRIAGE VERBS AND THEIR TWO CAPS — A LEAF THAT IMPORTS NOTHING.
 *
 * This file exists for one reason and it is a build failure this repo
 * has now paid for three times: **a `"use client"` module must reach no
 * barrel that reaches `@/db`.** The triage lane's decline dialog (this
 * slice's second commit) needs `TRIAGE_REASON_MAX` for a textarea's
 * `maxLength` and `TRIAGE_VERBS` for its menu — and importing either
 * from `./triage` would drag that file's graph (`@/db` → the Prisma
 * client → `pg` → Node builtins) into the browser bundle.
 *
 * The two previous instances, because the pattern is what matters:
 * slice 48's `@/config` import shipped the env schema and a
 * `crypto-browserify` polyfill into a 444 KB chunk and the build
 * SUCCEEDED — silent; slice 6a's `@/modules/work` import made
 * `pnpm build` die on `util/types` — loud. `request-limits.ts` next
 * door is the same shape for the same reason, and `src/config/view-as.ts`
 * is the third. A code review of the first cut of this slice pointed
 * out that the constants were sitting in `triage.ts` waiting to repeat
 * it; moving them before the dialog exists is cheaper than moving them
 * after.
 *
 * `src/db/client-graph.test.ts` walks every `"use client"` module's
 * transitive graph and would catch the mistake — but only once the
 * import is written. This is the arrangement that means it never is.
 *
 * Re-exported from `./triage` so a SERVER caller still has one import
 * site and does not have to know this file exists.
 */

/** The four verbs, as the member's UI and its server action spell them. */
export const TRIAGE_VERBS = ["ACCEPT", "DECLINE", "DUPLICATE", "SNOOZE"] as const;
export type TriageVerb = (typeof TRIAGE_VERBS)[number];

/**
 * The longest reason a member may write, matched to
 * `work_item.triage_reason`'s `VARCHAR(500)`. A cap the PARSER applies
 * so the member is told plainly, the FORM applies so they are stopped
 * before they type past it, and the COLUMN applies so no other caller
 * can get past it at all.
 */
export const TRIAGE_REASON_MAX = 500;

/**
 * How far ahead a snooze may reach. A year is not a business rule so
 * much as a guard against a fat-fingered year field parking a client's
 * request past everyone's memory: a snooze is "not this week", and a
 * request nobody will look at for longer than this should be declined
 * with a reason instead — which is exactly the verb next door.
 */
export const TRIAGE_SNOOZE_MAX_DAYS = 366;
