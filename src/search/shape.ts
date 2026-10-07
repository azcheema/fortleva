/**
 * The search vocabulary, free of any database import.
 *
 * `query.ts` reaches `@/db`, so anything a CLIENT component needs from
 * search has to live here instead: importing a VALUE from the service
 * pulls the Prisma client into the browser bundle and the build fails
 * on `Can't resolve 'dns'`. A type-only import is erased and would have
 * been fine — which is exactly why the split has to be by module rather
 * than by discipline, since the difference is invisible at the call
 * site. Same shape as `notify/weekly-reminder.ts` beside its job.
 */

/** The entity types the feed writes today. `project_update` and
 * `client_asset` are named in DATA_MODEL §6.19 but have no feed, so
 * nothing is indexed under them. `CREDENTIAL_ITEM` (slice 97, C65) is
 * fed by migration 20261007120000 and read only through the vault's
 * door (`query.ts`). */
export const SEARCH_ENTITY_TYPES = [
  "WORK_ITEM",
  "COMMENT",
  "DOCUMENT",
  "PROJECT",
  "CLIENT",
  "CONTACT",
  "CREDENTIAL_ITEM",
] as const;

export type SearchEntityType = (typeof SEARCH_ENTITY_TYPES)[number];

export const isSearchEntityType = (v: string): v is SearchEntityType =>
  (SEARCH_ENTITY_TYPES as readonly string[]).includes(v);

/** Per type, so one noisy type cannot crowd out the rest (§6.19's
 * "per-type capped UNION"). */
export const PER_TYPE_LIMIT = 5;
/** The whole answer, across types: every type's cap, so the total never
 * cuts a type's last rows for another's (35 since slice 97 added logins —
 * a seventh type over a total of 30 would have let rows a client named
 * push others out; its security review). */
export const TOTAL_LIMIT = PER_TYPE_LIMIT * SEARCH_ENTITY_TYPES.length;
/** Longer than this is not a query, it is a paste. */
export const MAX_QUERY_CHARS = 200;
