/**
 * WHICH surface asked for an item property change — the backlog table,
 * a peek over the board or the backlog, or the item's own page.
 *
 * It exists for the MFA step-up return address — and `/home`'s queue
 * builds its row links with `itemReturnTo("backlog-peek", …)`, the same
 * address the inbox links a task by (slice 23). `runAction`
 * hands its first argument to `handleAuthzRedirect`, which sends the
 * member back there after a step-up, and a hardcoded backlog path sent a
 * member working in a board peek or on the item page somewhere else.
 *
 * The address is built ONLY from values a server action has already
 * validated — this enum, a project key matching `PROJECT_KEY_RE` and a
 * bounded integer — never from caller text, which would make it an
 * open-redirect surface. Accepted, recorded cost: a step-up drops
 * `?group=` and any filter chips.
 *
 * No directive: a client island needs `panelSurfaceOf`, a server action
 * needs `ITEM_SURFACES`, and a `"use server"` module may export neither.
 */
export const ITEM_SURFACES = ["backlog", "board-peek", "backlog-peek", "page"] as const;
export type ItemSurface = (typeof ITEM_SURFACES)[number];

/** The item panel's own `surface` prop, as the surface the actions take. */
export const panelSurfaceOf = (surface: "board" | "backlog" | "page"): ItemSurface =>
  surface === "page" ? "page" : surface === "board" ? "board-peek" : "backlog-peek";

/** MFA step-up return address, built ONLY from validated values (open-redirect surface). */
export function itemReturnTo(surface: ItemSurface, projectKey: string, itemNumber: number): string {
  switch (surface) {
    case "backlog":
      return `/projects/${projectKey}/backlog`;
    case "board-peek":
      return `/projects/${projectKey}/board?item=${projectKey}-${itemNumber}`;
    case "backlog-peek":
      return `/projects/${projectKey}/backlog?item=${projectKey}-${itemNumber}`;
    case "page":
      return `/projects/${projectKey}/items/${itemNumber}`;
  }
}
