/**
 * Member-plane navigation registry (UI.md §3.1). Fixed order, no
 * reordering; an entry is HIDDEN (not disabled) when the member lacks
 * its view permission — the layout resolves visibility with
 * isAuthorized() and hands the shell a filtered list. Modules register
 * entries here later (ARC-16 module registry); nothing here is
 * tenant-specific. Icons are names so the registry stays serialisable
 * from server to client.
 */
export type NavIcon =
  | "home"
  | "inbox"
  | "search"
  | "notifications"
  | "clients"
  | "projects"
  | "time"
  | "files"
  | "members"
  | "settings"
  | "roles"
  | "preferences"
  | "rates"
  | "timeSettings"
  | "export"
  | "design"
  | "account";

export type NavEntry = {
  id: string;
  /** Key under the `nav` message namespace. */
  labelKey:
    | "home"
    | "inbox"
    | "search"
    | "notifications"
    | "clients"
    | "projects"
    | "time"
    | "files"
    | "members"
    | "settings"
    | "roles"
    | "preferences"
    | "rates"
    | "timeSettings"
    | "export"
    | "design"
    | "account";
  href: string;
  icon: NavIcon;
  /** Permission that must be held for the entry to show; none = always. */
  permission?: string;
  /** Two-key "go to" sequence shown in the ? overlay and the palette (UI.md §6). */
  goKey?: string;
  /** Renders the unread badge (UI.md §3.1 "Inbox — core; unread badge").
   * Exactly one entry carries it; the shell reads the count off its own
   * required prop rather than guessing from the href. */
  badge?: "inboxUnread";
  /** Shown as a bottom tab on mobile (Home / Projects / Clients / More until 2W — UI.md §3.3). */
  mobileTab?: boolean;
  /** Development-only entry (the design preview): dropped in production. */
  devOnly?: boolean;
  children?: NavEntry[];
};

export const NAV: readonly NavEntry[] = [
  { id: "home", labelKey: "home", href: "/home", icon: "home", goKey: "H", mobileTab: true },
  {
    id: "clients",
    labelKey: "clients",
    href: "/clients",
    icon: "clients",
    permission: "client:view",
    goKey: "C",
    mobileTab: true,
  },
  {
    id: "projects",
    labelKey: "projects",
    href: "/projects",
    icon: "projects",
    permission: "project:view",
    goKey: "P",
    mobileTab: true,
  },
  // 2T (UI.md §3.1 "Time"; §3.3 the mobile Timer tab): hidden without time:track.
  {
    id: "time",
    labelKey: "time",
    href: "/time",
    icon: "time",
    permission: "time:track",
    goKey: "T",
    mobileTab: true,
  },
  // 2W search (UI.md §3.1). No permission gate on the ENTRY: the page
  // itself gates every result type through `requireAccess`, so a member
  // who may read nothing simply gets nothing — and hiding the entry
  // would be the one case where the rail lies about what exists.
  { id: "search", labelKey: "search", href: "/search", icon: "search", goKey: "S" },
  // 2W notifications core (UI.md §3.1, between Time and Files): NEVER
  // permission-gated — "notifications core, never entitlement-gated"
  // (DATA_MODEL.md §6.18), and the only rows an inbox can hold are the
  // member's own. Not a mobile tab: §3.3's target bar is Home / Board /
  // Timer / Inbox / More, and adding a fifth tab to today's four would
  // reshape the phone bar rather than fill a slot in it — on a phone
  // Inbox lives in `More`, badge and all, until that bar is rebuilt.
  { id: "inbox", labelKey: "inbox", href: "/inbox", icon: "inbox", goKey: "I", badge: "inboxUnread" },
  {
    id: "files",
    labelKey: "files",
    href: "/files",
    icon: "files",
    permission: "document:view",
    goKey: "F",
  },
  {
    id: "members",
    labelKey: "members",
    href: "/members",
    icon: "members",
    permission: "member:view",
    goKey: "M",
  },
  {
    id: "settings",
    labelKey: "settings",
    href: "/settings/roles",
    icon: "settings",
    children: [
      { id: "roles", labelKey: "roles", href: "/settings/roles", icon: "roles", permission: "role:view" },
      {
        id: "preferences",
        labelKey: "preferences",
        href: "/settings/preferences",
        icon: "preferences",
        permission: "settings:view",
      },
      // 2T (UI.md §3.1 "Settings"): bill-rate cards need rate:view_bill;
      // the time-tracking page (staff notice, work types) is a settings page.
      {
        id: "rates",
        labelKey: "rates",
        href: "/settings/rates",
        icon: "rates",
        permission: "rate:view_bill",
      },
      {
        id: "timeSettings",
        labelKey: "timeSettings",
        href: "/settings/time",
        icon: "timeSettings",
        permission: "settings:view",
      },
      // No permission: every other Settings page administers the
      // WORKSPACE and is hidden without its code; this one administers
      // one person's own mail, and no seat in this product decides on
      // someone else's behalf whether they are emailed (UI.md §3.1
      // lists `notifications` among the settings pages).
      {
        id: "notifications",
        labelKey: "notifications",
        href: "/settings/notifications",
        icon: "notifications",
      },
      {
        id: "export",
        labelKey: "export",
        href: "/settings/export",
        icon: "export",
        permission: "settings:view",
      },
      // The design system preview: every member may open it, and it
      // 404s in production (src/app/(tenant)/(authed)/settings/design).
      { id: "design", labelKey: "design", href: "/settings/design", icon: "design", devOnly: true },
    ],
  },
  { id: "account", labelKey: "account", href: "/account", icon: "account", goKey: "A" },
];

/**
 * Filter the registry by a "may see" predicate. A parent with children
 * survives only if at least one child survives; its href becomes the
 * first visible child's.
 */
export function visibleNav(
  entries: readonly NavEntry[],
  allowed: (permission: string) => boolean,
): NavEntry[] {
  const out: NavEntry[] = [];
  const isProduction = process.env.NODE_ENV === "production";
  for (const e of entries) {
    if (e.devOnly && isProduction) continue;
    if (e.permission && !allowed(e.permission)) continue;
    if (e.children) {
      const children = visibleNav(e.children, allowed);
      if (children.length === 0) continue;
      out.push({ ...e, href: children[0]!.href, children });
    } else {
      out.push(e);
    }
  }
  return out;
}
