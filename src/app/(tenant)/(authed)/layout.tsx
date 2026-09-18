import type { Metadata } from "next";

import { isAuthorized } from "@/authz/authorize";
import { requireMemberSession } from "@/auth/session";
import { AppShell } from "@/components/shell/app-shell";
import { PwaRegister } from "@/components/shell/pwa-register";
import { withTenant } from "@/db";
import { getThemePreference } from "@/lib/theme-server";
import { getActiveMembership, membershipsFor, mfaStateOf } from "@/members/tenant-context";
import { countUnreadIn } from "@/notify/inbox";

import { switchLocaleAction } from "./account/actions";
import { NAV, visibleNav, type NavEntry } from "./nav";
import { getTimerStateAction, type TimerPillState } from "./time/actions";

/**
 * PWA shell (decision 15 / ARC-25, Stage A): the member plane links the
 * manifest and the Apple install tags; the ops host never renders this
 * layout, and the manifest route 404s there anyway.
 */
export const metadata: Metadata = {
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Fortleva" },
  icons: { apple: "/icons/apple-touch-icon.png" },
};

/**
 * Member-plane chrome (UI.md §3). Nav visibility is a permission
 * question (AUTHZ.md): every gated entry is checked with isAuthorized()
 * under the member principal and HIDDEN when not held. A user with no
 * active membership (workspace picker only) gets the ungated entries.
 */
export default async function AuthedLayout({ children }: { children: React.ReactNode }) {
  const session = await requireMemberSession();
  const membership = await getActiveMembership(session);
  // The same per-request memoised list `getActiveMembership` just read —
  // no second query. The shell offers "Switch workspace" only above 1
  // (UI.md rule 8): one membership is a picker with nothing to pick.
  const workspaceCount = (await membershipsFor(session.user.id)).length;
  // The shell renders a ThemeToggle: it gets the same preference the
  // root layout rendered <html> with, so server and client never
  // disagree about which segment is active (src/lib/theme.ts).
  const theme = await getThemePreference();

  let nav: NavEntry[];
  let timer: TimerPillState | null = null;
  // The rail's unread badge (UI.md §3.1). One indexed count per render,
  // under the member principal — `principal_scope` already binds it to
  // this member's own rows, so there is nothing here to get wrong.
  let unreadInbox = 0;
  let canCreateTask = false;
  if (membership) {
    const actor = { memberId: membership.memberId, mfa: mfaStateOf(session) };
    // The nav's codes PLUS the shell's own: the global `C` is a key, not
    // a nav entry, and asking for it here costs nothing — `isAuthorized`
    // is already being run once per code in one transaction.
    const gated = [
      ...new Set([...collectPermissions(NAV), "work_item:create", "project:view"]),
    ];
    const { held, unread } = await withTenant(
      membership.tenantId,
      { type: "member", id: membership.memberId },
      async (tx) => {
        const [results, unread] = await Promise.all([
          Promise.all(gated.map((code) => isAuthorized(tx, actor, code))),
          countUnreadIn(tx, { tenantId: membership.tenantId, actor }),
        ]);
        return { held: new Set(gated.filter((_, i) => results[i])), unread };
      },
    );
    nav = visibleNav(NAV, (code) => held.has(code));
    unreadInbox = unread;
    // The global `C` rides on the SAME batched permission read the nav
    // does — two more codes in the `gated` set, no second query. It is
    // not a nav entry, so it is read off `held` here rather than through
    // `visibleNav`.
    //
    // BOTH codes, which a review caught: the dialog's first act is to
    // read the project list, and that read is gated on `project:view`.
    // A custom role holding only `work_item:create` would have got a key
    // that opens a dialog and closes it again on a FORBIDDEN toast — an
    // offer the product cannot keep.
    canCreateTask = held.has("work_item:create") && held.has("project:view");
    // The pill's initial snapshot (2T): only for members who may track time.
    if (held.has("time:track")) timer = await getTimerStateAction();
  } else {
    nav = visibleNav(NAV, () => false);
  }

  return (
    <AppShell
      nav={nav}
      tenantName={membership?.tenantName ?? null}
      activeTenantId={membership?.tenantId ?? null}
      // The stale-tab fence orders tabs by WHEN each one was told which
      // workspace it is in, and this is that moment: one clock, the
      // server's, for every tab of every session (src/lib/workspace-watch.ts).
      activeTenantAt={new Date().toISOString()}
      user={{ name: session.user.name, email: session.user.email }}
      theme={theme}
      onSwitchLocale={switchLocaleAction}
      timer={timer}
      unreadInbox={unreadInbox}
      canCreateTask={canCreateTask}
      workspaceCount={workspaceCount}
    >
      <PwaRegister />
      {children}
    </AppShell>
  );
}

const collectPermissions = (entries: readonly NavEntry[]): string[] =>
  entries.flatMap((e) => [
    ...(e.permission ? [e.permission] : []),
    ...(e.children ? collectPermissions(e.children) : []),
  ]);
