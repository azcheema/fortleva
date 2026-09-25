import type { Metadata } from "next";

import { requireMemberSession } from "@/auth/session";
import { AppShell } from "@/components/shell/app-shell";
import { PwaRegister } from "@/components/shell/pwa-register";
import { withTenant } from "@/db";
import { accessibleCodes } from "@/entitlements/resolver";
import { getThemePreference } from "@/lib/theme-server";
import { getActiveMembership, membershipsFor, mfaStateOf } from "@/members/tenant-context";
import { countUnreadIn } from "@/notify/inbox";

import { switchLocaleAction } from "./account/actions";
import { NAV, RAIL_CODES, visibleNav, type NavEntry } from "./nav";
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
 * Member-plane chrome (UI.md §3). Nav visibility is an access question
 * (AUTHZ.md §5): every gated entry is checked under the member principal
 * on all four gates — `accessibleCodes`, which answers each code exactly
 * as `hasAccess` would — and HIDDEN when not held. A user with no active
 * membership (workspace picker only) gets the ungated entries.
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
    const { held, unread } = await withTenant(
      membership.tenantId,
      { type: "member", id: membership.memberId },
      async (tx) => {
        // IN SEQUENCE, and this was ten reads at once on every authed
        // render: one `isAuthorized` per gated code — each resolving the
        // same member's roles with reads of its own — plus the count, all
        // legs of one `Promise.all` on this interactive transaction's one
        // connection. That is AGENTS.md's worst standing trap: Prisma over
        // the `pg` adapter does not serialise those legs, and a loser can
        // resolve `undefined` in code nobody touched. One connection runs
        // one statement at a time anyway, so the batch bought no speed.
        // `authz-batches.test.ts` keeps the fan-out from coming back.
        //
        // ALL FOUR GATES, not the permission alone (UI.md §3.1: a
        // module-gated item is HIDDEN when the entitlement or preference
        // is off). `authorizedCodes` answered the permission gate only,
        // so a tenant that switched Time or Files off still had the entry,
        // and one that switched Work off still had the `C` key, over a
        // page — or a dialog — that then refused. (The timer
        // pill was already safe: `getTimerStateAction` answers null with
        // the module off. Its read is now simply skipped.) `accessibleCodes`
        // is `hasAccess` per code: one read of the roles and up to three
        // of the module gates.
        const held = await accessibleCodes(tx, membership.tenantId, actor, RAIL_CODES);
        const unread = await countUnreadIn(tx, { tenantId: membership.tenantId, actor });
        return { held, unread };
      },
    );
    nav = visibleNav(NAV, (code) => held.has(code));
    unreadInbox = unread;
    // The global `C` rides on the SAME read the nav does — one more code
    // in `RAIL_CODES` (`project:view` is a nav code already), no second
    // query. It is not a nav entry, so it is read off `held` here rather
    // than through `visibleNav`. With the work module switched off it is
    // gone too: its dialog could only fail.
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
