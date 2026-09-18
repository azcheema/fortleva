/**
 * THE STALE-TAB FENCE (PLAN §0, after slice 26).
 *
 * `Session.activeTenantId` became mutable mid-session when the workspace
 * picker learned to pick. A session is one cookie jar, so every tab of
 * that browser shares it: switch workspace in one tab and every OTHER
 * tab is showing workspace X while `requireTenantContext()` now resolves
 * Y for anything it posts. An action carrying an entity id fails safe —
 * the id is not in Y, RLS finds nothing, `assertInScope` refuses — but a
 * CREATE-SHAPED one (a client, a role, a work type, a tenant setting)
 * has no such id and lands in Y, where the member never meant to be.
 *
 * WHY THE FIX IS IN THE BROWSER AND NOT AT THE SEAM. Nothing the server
 * reads from a stale tab's request distinguishes it from a fresh one:
 * cookies are per-ORIGIN, not per-tab, so the tab has to say which
 * workspace it was rendered under, and a server action carries only what
 * its caller passes it. A fence at `requireTenantContext()` would
 * therefore mean an argument on all 118 actions. But the hazard needs a
 * SHARED SESSION, a shared session means one browser profile, and one
 * browser profile means a `BroadcastChannel` reaches every tab that has
 * the problem — so the browser is not a weaker place to stand here, it
 * is the only place that can see the fact at all.
 *
 * The protocol is two messages and lives here, apart from the DOM, so
 * the rule about which tab is stale is a pure function with a test
 * rather than something to re-derive from a component:
 *
 *   • `who` — "anyone there?", posted on mount and by a tab waking from
 *     the back/forward cache, which was frozen while messages went by.
 *   • `here` — "I am in {tenantId}, as of {at}", posted on mount and in
 *     answer to a `who`.
 *
 * `at` is when that tab last learned its workspace FROM THE SERVER, and
 * the newest answer wins: a tab is stale when another names a different
 * workspace more recently than it learned its own. That makes the two
 * mount messages safe in either order — a tab that mounts second is the
 * newer truth and says so, while the older tabs' answers to its `who`
 * are older by construction and it ignores them.
 *
 * Nothing is stored. `localStorage` would survive the tab and would be a
 * tenant-scoped value at rest for a shell whose rule is to cache none
 * (ARC-25), and it throws in a private window; the `who` round-trip buys
 * the same recovery with neither.
 */

/** The one channel name. A constant, because two spellings is no channel at all. */
export const WORKSPACE_CHANNEL = "fortleva.workspace";

/** "I am in this workspace, and this is when the server last told me so." */
export type WorkspaceHere = { kind: "here"; tenantId: string; at: number };
/** "Anyone there? Say where you are." */
export type WorkspaceWho = { kind: "who" };
export type WorkspaceMessage = WorkspaceHere | WorkspaceWho;

/** What this tab knows about itself. */
export type TabWorkspace = { tenantId: string; at: number };

/**
 * A message off the channel is DATA, not a value we sent: another tab
 * may be running an older deploy, and `postMessage` will carry anything
 * structured-cloneable. Both guards are total, so an unknown shape is
 * simply not a message rather than a thrown handler.
 */
export function isWho(m: unknown): m is WorkspaceWho {
  return typeof m === "object" && m !== null && (m as { kind?: unknown }).kind === "who";
}

export function isHere(m: unknown): m is WorkspaceHere {
  if (typeof m !== "object" || m === null) return false;
  const x = m as { kind?: unknown; tenantId?: unknown; at?: unknown };
  return (
    x.kind === "here" &&
    typeof x.tenantId === "string" &&
    x.tenantId !== "" &&
    typeof x.at === "number" &&
    Number.isFinite(x.at)
  );
}

/**
 * Is `own` now stale, given what `other` just said?
 *
 * Both halves matter. A DIFFERENT workspace alone is not staleness —
 * that is exactly what an older tab answers a `who` with, and acting on
 * it would make the tab that just rendered the truth mark itself wrong.
 * A NEWER `at` alone is not staleness either: two tabs in the same
 * workspace are both correct, however they are ordered.
 *
 * Strictly newer, so two tabs that mount inside the same millisecond
 * leave each other alone rather than both going dark.
 */
export function isStale(own: TabWorkspace, other: WorkspaceHere): boolean {
  return other.tenantId !== own.tenantId && other.at > own.at;
}
