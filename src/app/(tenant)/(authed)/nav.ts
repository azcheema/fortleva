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
  | "clients"
  | "projects"
  | "files"
  | "members"
  | "settings"
  | "roles"
  | "preferences"
  | "export"
  | "account";

export type NavEntry = {
  id: string;
  /** Key under the `nav` message namespace. */
  labelKey:
    | "home"
    | "clients"
    | "projects"
    | "files"
    | "members"
    | "settings"
    | "roles"
    | "preferences"
    | "export"
    | "account";
  href: string;
  icon: NavIcon;
  /** Permission that must be held for the entry to show; none = always. */
  permission?: string;
  /** Two-key "go to" sequence shown in the ? overlay and the palette (UI.md §6). */
  goKey?: string;
  /** Shown as a bottom tab on mobile (Home / Projects / Clients / More until 2W — UI.md §3.3). */
  mobileTab?: boolean;
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
      {
        id: "export",
        labelKey: "export",
        href: "/settings/export",
        icon: "export",
        permission: "settings:view",
      },
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
  for (const e of entries) {
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
