import { isIsoDate, weekContaining, type WeekStart } from "@/lib/week";

/**
 * THE TASKS PAGE'S PURE HALF (slice 130; founder decision C107 — design
 * docs/research/2026-10-17-slice-130-all-tasks-and-lineup-design.md §3.1–§3.4).
 * No database, no clock: the page's parameters read strictly, the links built
 * from what was parsed, the days a due filter means, and the groups the list
 * is shown in. Shared by the read (`src/modules/work/all-tasks.ts`) and the
 * page; pinned by `task-list-plan.test.ts`.
 *
 * Days are `YYYY-MM-DD`. A task's due date is a `@db.Date`, so its UTC day IS
 * its day; "today" is the caller's (the member's zone).
 */

/** Tasks the list draws at most (design §3.2) — past it the page says so. */
export const TASK_LIST_CAP = 500;

export const TASK_DUE_FILTERS = ["overdue", "week"] as const;
export type TaskDueFilter = (typeof TASK_DUE_FILTERS)[number];

export const TASK_GROUPS = ["project", "person"] as const;
export type TaskGroupBy = (typeof TASK_GROUPS)[number];

/** Who the list is narrowed to: me, nobody, or one member (an id still to be found among the assignees in scope). */
export type TaskPersonFilter =
  | { readonly kind: "me" }
  | { readonly kind: "none" }
  | { readonly kind: "member"; readonly id: string };

export type TaskListParams = {
  readonly due: TaskDueFilter | null;
  readonly person: TaskPersonFilter | null;
  /** A project key to narrow to — still to be found in the member's scope. */
  readonly project: string | null;
  readonly group: TaskGroupBy | null;
  /** The peek: `KEY-N`, as the URL spells it (the key upper-cased). */
  readonly item: { readonly projectKey: string; readonly number: number } | null;
};

/**
 * A project key as the page accepts it — the projects service's own shape
 * (`PROJECT_KEY_RE`), copied because this module reaches the client bundle
 * and the service does not; `task-list-plan.test.ts` pins the copy to it.
 */
export const TASKS_PROJECT_KEY_RE = /^[A-Z][A-Z0-9]{0,7}$/;
/** The peek's `KEY-N`, case-insensitive on the key (the board's `peekItemNumber`). */
const ITEM_PARAM = /^([A-Za-z][A-Za-z0-9]{0,7})-(\d{1,9})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const one = (v: string | string[] | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const isOneOf = <T extends string>(list: readonly T[], v: string | undefined): v is T =>
  v !== undefined && (list as readonly string[]).includes(v);

function parsePerson(v: string | undefined): TaskPersonFilter | null {
  if (v === "me") return { kind: "me" };
  if (v === "none") return { kind: "none" };
  if (v !== undefined && UUID.test(v)) return { kind: "member", id: v.toLowerCase() };
  return null;
}

/** The page's search parameters, read strictly: anything unknown is the default, nothing is echoed. */
export function parseTaskListParams(params: Readonly<Record<string, string | string[] | undefined>>): TaskListParams {
  const due = one(params["due"]);
  const group = one(params["group"]);
  const project = one(params["project"]);
  const item = ITEM_PARAM.exec(one(params["item"]) ?? "");
  const number = item ? Number(item[2]) : 0;
  return {
    due: isOneOf(TASK_DUE_FILTERS, due) ? due : null,
    person: parsePerson(one(params["person"])),
    project: project !== undefined && TASKS_PROJECT_KEY_RE.test(project) ? project : null,
    group: isOneOf(TASK_GROUPS, group) ? group : null,
    item: item && number >= 1 ? { projectKey: item[1]!.toUpperCase(), number } : null,
  };
}

/**
 * The reader's own member id as a person filter is "Me" — one choice, one
 * value, so the picker (which offers "Me" and lists everyone else) shows it.
 */
export function withSelfAsMe(p: TaskListParams, selfId: string): TaskListParams {
  return p.person?.kind === "member" && p.person.id === selfId.toLowerCase() ? { ...p, person: { kind: "me" } } : p;
}

const personParam = (p: TaskPersonFilter): string => (p.kind === "member" ? p.id : p.kind);

/** `/tasks` with these parameters — the defaults written as no parameter. */
export function tasksHref(p: TaskListParams): string {
  const q = new URLSearchParams();
  if (p.due) q.set("due", p.due);
  if (p.person) q.set("person", personParam(p.person));
  if (p.project) q.set("project", p.project);
  if (p.group) q.set("group", p.group);
  if (p.item) q.set("item", `${p.item.projectKey}-${p.item.number}`);
  const s = q.toString();
  return s === "" ? "/tasks" : `/tasks?${s}`;
}

/** Whether any filter is set — the empty state then offers "Clear filters" (grouping is not a filter). */
export const hasTaskFilters = (p: TaskListParams): boolean =>
  p.due !== null || p.person !== null || p.project !== null;

/**
 * The due days a filter means (design §3.3), as the read's bounds: OVERDUE is
 * before today; DUE THIS WEEK is every day of the workspace's week containing
 * today — a passed day of it included (it is drawn overdue).
 */
export function dueBounds(
  due: TaskDueFilter,
  today: string,
  weekStart: WeekStart,
): { readonly before: string } | { readonly from: string; readonly to: string } {
  if (due === "overdue") return { before: today };
  const week = weekContaining(today, weekStart);
  return { from: week.from, to: week.to };
}

/** An open task is overdue when its due day is before the member's today. */
export const isOverdue = (dueOn: string | null, today: string): boolean =>
  dueOn !== null && isIsoDate(dueOn) && dueOn < today;

// ── grouping ─────────────────────────────────────────────────────────

/** Who a row is assigned to — a member, a client's contact, or nobody. */
export type TaskAssignee =
  | { readonly kind: "member"; readonly id: string; readonly name: string }
  | { readonly kind: "contact"; readonly id: string; readonly name: string }
  | { readonly kind: "none" };

export type TaskGroup<T> = {
  /** Stable and unique within the list: `project:KEY`, `member:<id>`, `contact:<id>`, `none`. */
  readonly key: string;
  readonly rows: readonly T[];
};

/**
 * The list in groups (design §3.4), each keeping the rows in the order they
 * arrived (the read sorts by due day). BY PROJECT: projects by name, then key.
 * BY PERSON: Nobody first — the list's reason for being — then members by
 * name, then client contacts by name. `compare` is the page's collator.
 */
export function groupTasks<T extends { readonly projectKey: string; readonly projectName: string; readonly assignee: TaskAssignee }>(
  rows: readonly T[],
  by: TaskGroupBy,
  compare: (a: string, b: string) => number,
): TaskGroup<T>[] {
  const groups = new Map<string, { sortRank: number; sortName: string; tie: string; rows: T[] }>();
  for (const row of rows) {
    let key: string;
    let sortRank: number;
    let sortName: string;
    let tie: string;
    if (by === "project") {
      key = `project:${row.projectKey}`;
      sortRank = 0;
      sortName = row.projectName;
      tie = row.projectKey;
    } else if (row.assignee.kind === "none") {
      key = "none";
      sortRank = 0;
      sortName = "";
      tie = "";
    } else {
      key = `${row.assignee.kind}:${row.assignee.id}`;
      sortRank = row.assignee.kind === "member" ? 1 : 2;
      sortName = row.assignee.name;
      tie = row.assignee.id;
    }
    const g = groups.get(key);
    if (g) g.rows.push(row);
    else groups.set(key, { sortRank, sortName, tie, rows: [row] });
  }
  return [...groups.entries()]
    .sort(([, a], [, b]) => a.sortRank - b.sortRank || compare(a.sortName, b.sortName) || (a.tie < b.tie ? -1 : a.tie > b.tie ? 1 : 0))
    .map(([key, g]) => ({ key, rows: g.rows }));
}
