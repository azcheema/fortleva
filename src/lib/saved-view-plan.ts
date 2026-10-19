import { PRIORITIES } from "@/lib/enum-map";
import { singleLineName } from "@/lib/single-line-name";
import { TASK_DUE_FILTERS, TASK_GROUPS, TASKS_PROJECT_KEY_RE } from "@/lib/task-list-plan";
import { GROUP_BYS, UNASSIGNED, WITH_CLIENT } from "@/lib/work-view/model";

/**
 * SAVED VIEWS' PURE HALF (slice 136; founder decision C113 — design
 * docs/research/2026-10-19-slice-136-saved-views-design.md). No database, no
 * clock: what a saved view STORES (its list's filters as one canonical query
 * string), the address that opens it, and the name rule. Shared by the
 * service (which decides with it), the two pages and the left menu (which
 * compare with it); pinned by `saved-view-plan.test.ts`.
 *
 * A view is a member's OWN (C113 (a)) and is of one of two lists (C113 (b)):
 * the Tasks page, or ONE project's backlog. What it keeps is exactly what
 * that list's filter bar sets — nothing that changes what the SERVER loads
 * (`archived`), nothing about a moment (`item`, `error`), and never itself
 * (`view`).
 *
 * THE CANONICAL FORM is what makes "has this view changed?" (C113 (d)) a
 * string comparison: a fixed key order, defaults written as no key, a list's
 * values de-duplicated and sorted (a list filter is an OR, so its order means
 * nothing), ids lower-cased. Its alphabet is `[A-Za-z0-9=&,_-]` — nothing in
 * it needs encoding — and the database holds the same outline (CHECK
 * `saved_view_query_ok`).
 */

export const SAVED_VIEW_KINDS = ["TASKS", "BACKLOG"] as const;
export type SavedViewKind = (typeof SAVED_VIEW_KINDS)[number];

/** A member keeps at most this many (the service counts under a lock). */
export const SAVED_VIEW_MAX = 30;
/** A name's length in code points (the CHECK's `char_length`). */
export const SAVED_VIEW_NAME_MAX = 60;
/** Values a backlog list filter may hold — far past any real stage or team list. */
export const SAVED_VIEW_LIST_MAX = 50;
/** The canonical query's length bound (the CHECK's): five keys, two lists of 50 ids. */
export const SAVED_VIEW_QUERY_MAX = 4000;

/**
 * A view's name as it is stored: one line, at most `SAVED_VIEW_NAME_MAX`, no
 * control or invisible character (the stage and label rule). Unique per
 * member IGNORING CASE — Postgres's `lower()` decides (`VIEW_NAME_TAKEN`).
 */
export const savedViewName = (raw: string) => singleLineName(raw, SAVED_VIEW_NAME_MAX);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isViewId = (v: string | null | undefined): v is string => typeof v === "string" && UUID.test(v);

type Raw = URLSearchParams | Readonly<Record<string, string | string[] | undefined>>;

/** One value of a key, as the pages read one: the first, or none. */
function one(raw: Raw, key: string): string | undefined {
  if (raw instanceof URLSearchParams) return raw.get(key) ?? undefined;
  const v = raw[key];
  return typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined;
}

const isOneOf = <T extends string>(list: readonly T[], v: string | undefined): v is T =>
  v !== undefined && (list as readonly string[]).includes(v);

/**
 * The open view a URL names (`?view=`), or null — read strictly: only a uuid,
 * lower-cased. Whether it is the reader's, and of this list, is the server's
 * question (RLS decides the first).
 */
export const viewParamOf = (raw: Raw): string | null => {
  const v = one(raw, "view");
  return isViewId(v) ? v.toLowerCase() : null;
};

export type CanonicalResult = { readonly ok: true; readonly query: string } | { readonly ok: false };

const join = (pairs: readonly (readonly [string, string | null])[]): string =>
  pairs
    .filter((p): p is readonly [string, string] => p[1] !== null)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

/**
 * THE TASKS PAGE'S filters, canonical: `due`, `person`, `project`, `group`, in
 * that order. Read as `parseTaskListParams` reads them — a value the page
 * would ignore is no filter here either — with TWO differences: the reader's
 * own id is written `me` (`withSelfAsMe`), so "Mine" is one value however it
 * was chosen; and a repeated key reads as its first value where the page
 * reads none (the page's own links never repeat one).
 */
export function canonicalTasksQuery(raw: Raw, selfId: string): string {
  const due = one(raw, "due");
  const group = one(raw, "group");
  const project = one(raw, "project");
  const personRaw = one(raw, "person");
  let person: string | null = null;
  if (personRaw === "me" || personRaw === "none") person = personRaw;
  else if (isViewId(personRaw)) person = personRaw.toLowerCase() === selfId.toLowerCase() ? "me" : personRaw.toLowerCase();
  return join([
    ["due", isOneOf(TASK_DUE_FILTERS, due) ? due : null],
    ["person", person],
    ["project", project !== undefined && TASKS_PROJECT_KEY_RE.test(project) ? project : null],
    ["group", isOneOf(TASK_GROUPS, group) ? group : null],
  ]);
}

/** A comma list as nuqs writes one: empty entries dropped. */
const listOf = (v: string | undefined): string[] =>
  v === undefined ? [] : v.split(",").filter((s) => s !== "");

const sortedUnique = (list: readonly string[]): string[] => [...new Set(list)].sort();

/**
 * A PROJECT BACKLOG'S filters, canonical: `state`, `assignee`, `priority`,
 * `hideDone`, `group`, in that order (the filter bar's `workViewParsers`).
 * STRICTER than the page, on purpose: the page lets any string through a
 * list (it then matches nothing), and a view that saved one would open a
 * list emptier than it looks — so a stage or person that is not an id, a
 * priority that is not one, or a list past `SAVED_VIEW_LIST_MAX` refuses the
 * save. A single value the page would read as its default (`group`,
 * `hideDone`) is the default here too.
 */
export function canonicalBacklogQuery(raw: Raw): CanonicalResult {
  const states = listOf(one(raw, "state"));
  const assignees = listOf(one(raw, "assignee"));
  const priorities = listOf(one(raw, "priority"));
  if (states.length > SAVED_VIEW_LIST_MAX || assignees.length > SAVED_VIEW_LIST_MAX) return { ok: false };
  if (!states.every((s) => isViewId(s))) return { ok: false };
  if (!assignees.every((a) => a === UNASSIGNED || a === WITH_CLIENT || isViewId(a))) return { ok: false };
  if (!priorities.every((p) => isOneOf(PRIORITIES, p))) return { ok: false };
  const group = one(raw, "group");
  const query = join([
    ["state", states.length > 0 ? sortedUnique(states.map((s) => s.toLowerCase())).join(",") : null],
    ["assignee", assignees.length > 0 ? sortedUnique(assignees.map((a) => a.toLowerCase())).join(",") : null],
    ["priority", priorities.length > 0 ? PRIORITIES.filter((p) => priorities.includes(p)).join(",") : null],
    ["hideDone", one(raw, "hideDone") === "true" ? "true" : null],
    ["group", isOneOf(GROUP_BYS, group) && group !== "none" ? group : null],
  ]);
  return { ok: true, query };
}

/**
 * The backlog's filters ON SCREEN (the filter bar's nuqs state) as a view
 * would keep them: canonical when they can be kept, else as the URL spells
 * them — which the service then refuses (`VIEW_FILTERS_INVALID`), so "Save"
 * says why rather than keeping something else.
 */
export function backlogScreenQuery(p: {
  readonly state: readonly string[];
  readonly assignee: readonly string[];
  readonly priority: readonly string[];
  readonly hideDone: boolean;
  readonly group: string;
}): string {
  const raw = new URLSearchParams();
  if (p.state.length > 0) raw.set("state", p.state.join(","));
  if (p.assignee.length > 0) raw.set("assignee", p.assignee.join(","));
  if (p.priority.length > 0) raw.set("priority", p.priority.join(","));
  if (p.hideDone) raw.set("hideDone", "true");
  if (p.group !== "none") raw.set("group", p.group);
  const canonical = canonicalBacklogQuery(raw);
  return canonical.ok ? canonical.query : raw.toString();
}

/** Either list's canonical query; the service's one entry. */
export function canonicalViewQuery(kind: SavedViewKind, raw: Raw, selfId: string): CanonicalResult {
  if (kind === "TASKS") return { ok: true, query: canonicalTasksQuery(raw, selfId) };
  return canonicalBacklogQuery(raw);
}

/** A query string as a page holds its URL's (`?a=b…`, or without the `?`). */
export const searchOf = (query: string): URLSearchParams =>
  new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);

/** A view as the left menu draws it (`listSavedViewLinks`). */
export type SavedViewLink = {
  readonly id: string;
  readonly name: string;
  readonly kind: SavedViewKind;
  /** A backlog's project key, shown beside the name; null for the Tasks page — and for a backlog the member no longer reaches. */
  readonly projectKey: string | null;
  /** Null for a backlog view whose project the member no longer reaches: listed, greyed, to rename or delete. */
  readonly href: string | null;
};

/** The list a view opens, without its query. */
export const viewBasePath = (kind: SavedViewKind, projectKey: string | null): string =>
  kind === "TASKS" ? "/tasks" : `/projects/${projectKey}/backlog`;

/**
 * The address that OPENS a view: its list, its filters, and `view=<id>` last —
 * so the page knows which view is open and offers "Update view" when the
 * filters no longer match (C113 (d)).
 */
export function savedViewHref(kind: SavedViewKind, projectKey: string | null, query: string, id: string): string {
  const base = viewBasePath(kind, projectKey);
  return query === "" ? `${base}?view=${id}` : `${base}?${query}&view=${id}`;
}
