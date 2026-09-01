import { parseAsArrayOf, parseAsBoolean, parseAsString, parseAsStringLiteral } from "nuqs/server";

import { PRIORITIES } from "@/lib/enum-map";

import { GROUP_BYS, NO_FILTERS, type GroupBy, type WorkFilters } from "./model";

/**
 * The work view's URL contract (UI.md rule 6 / §5.3: "URL state via
 * nuqs … so every view is a link"). One parser map, imported by the
 * client hook that writes it and by anything that has to read it back.
 *
 * IMPORTED FROM `nuqs/server`, NEVER FROM `nuqs` — the package's main
 * entry carries a "use client" directive, so a parser pulled from there
 * into a server component becomes a throwing client reference (the
 * standing trap: "a `use client` module's exported constant
 * interpolated into a server component becomes a throwing client
 * reference"). `nuqs/server` is directive-free and exports exactly the
 * parsers, the loader and the serializer. This module therefore carries
 * NO directive of its own and is safe on both sides.
 *
 * WHICH PARAMS LIVE HERE, AND WHY ONLY THESE. `listItems` returns every
 * item of the project in one read, so state / assignee / priority /
 * hide-done / group-by are answered ENTIRELY on the client: they are
 * `shallow` (the nuqs default), which means no server round trip and no
 * refetch — the sub-50 ms reflow the plan's complaint corpus asks for.
 *
 * `archived` and `item` are deliberately NOT in this map. Both change
 * what the SERVER must load (`includeArchived` widens the query; a peek
 * needs its documents), so both stay ordinary links that navigate, and
 * both are preserved through `workViewHref` below rather than parsed.
 */

/** `clearOnDefault` is nuqs's default in v2 and is what keeps a view at
 * rest addressable as its bare path — `e2e/attachments.spec.ts` asserts
 * exactly that, and `params.test.ts` pins it as a unit so a regression
 * costs seconds rather than a browser run. */
export const workViewParsers = {
  group: parseAsStringLiteral(GROUP_BYS).withDefault("none"),
  state: parseAsArrayOf(parseAsString, ",").withDefault([]),
  assignee: parseAsArrayOf(parseAsString, ",").withDefault([]),
  priority: parseAsArrayOf(parseAsStringLiteral(PRIORITIES), ",").withDefault([]),
  hideDone: parseAsBoolean.withDefault(false),
};

export type WorkViewParams = {
  group: GroupBy;
  state: string[];
  assignee: string[];
  priority: (typeof PRIORITIES)[number][];
  hideDone: boolean;
};

/** The parsed params as the model's filter shape. */
export const filtersOf = (p: WorkViewParams): WorkFilters => ({
  ...NO_FILTERS,
  stateIds: p.state,
  assigneeIds: p.assignee,
  priorities: p.priority,
  hideDone: p.hideDone,
});

// ── hrefs the server builds ──────────────────────────────────────────

/**
 * Either shape a caller already holds: the page's `searchParams` prop on
 * the server, or `useSearchParams()`'s read-only `URLSearchParams` on
 * the client. Both are accepted so a peek link is built the same way on
 * both sides — and so a CLIENT can build one from the LIVE URL, which is
 * the only correct source once a shallow filter has changed it without
 * telling the server (standing trap: a prop carrying server state goes
 * stale).
 */
export type RawSearchParams =
  | Record<string, string | string[] | undefined>
  | URLSearchParams;

const toSearchParams = (raw: RawSearchParams): URLSearchParams => {
  if (raw instanceof URLSearchParams) return new URLSearchParams(raw);
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) out.append(key, v);
    else out.append(key, value);
  }
  return out;
};

/**
 * `base` plus the current query, with `patch` applied — `null` deletes.
 *
 * THIS EXISTS TO KILL A BUG CLASS, not to save typing. Both work pages
 * used to build the peek's return link as
 * `${listHref}${includeArchived ? "&" : "?"}item=…`: correct while
 * exactly one other param could exist, and silently wrong — a second
 * `?` in the middle of the URL — the moment a filter joined it. Every
 * href on these surfaces now goes through here, so the separator is
 * never a hand-written conditional again.
 */
export function workViewHref(
  base: string,
  raw: RawSearchParams,
  patch: Record<string, string | null> = {},
): string {
  const params = toSearchParams(raw);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) params.delete(key);
    else params.set(key, value);
  }
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

/** The surface's own URL — the peek's return target: everything the
 * member had chosen, minus the peek itself and any stale error token. */
export const listHrefOf = (base: string, raw: RawSearchParams): string =>
  workViewHref(base, raw, { item: null, error: null });

/** The link that OPENS an item's peek over the current view. */
export const peekHrefOf = (base: string, raw: RawSearchParams, itemKey: string): string =>
  workViewHref(base, raw, { item: itemKey, error: null });
