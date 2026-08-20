import type { Metadata } from "next";

import { isAuthorized } from "@/authz/authorize";
import { requireMemberSession } from "@/auth/session";
import { AppShell } from "@/components/shell/app-shell";
import { PwaRegister } from "@/components/shell/pwa-register";
import { withTenant } from "@/db";
import { getThemePreference } from "@/lib/theme-server";
import { getActiveMembership, mfaStateOf } from "@/members/tenant-context";

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
  // The shell renders a ThemeToggle: it gets the same preference the
  // root layout rendered <html> with, so server and client never
  // disagree about which segment is active (src/lib/theme.ts).
  const theme = await getThemePreference();

  let nav: NavEntry[];
  let timer: TimerPillState | null = null;
  if (membership) {
    const actor = { memberId: membership.memberId, mfa: mfaStateOf(session) };
    const gated = [...new Set(collectPermissions(NAV))];
    const held = await withTenant(
      membership.tenantId,
      { type: "member", id: membership.memberId },
      async (tx) => {
        const results = await Promise.all(gated.map((code) => isAuthorized(tx, actor, code)));
        return new Set(gated.filter((_, i) => results[i]));
      },
    );
    nav = visibleNav(NAV, (code) => held.has(code));
    // The pill's initial snapshot (2T): only for members who may track time.
    if (held.has("time:track")) timer = await getTimerStateAction();
  } else {
    nav = visibleNav(NAV, () => false);
  }

  return (
    <AppShell
      nav={nav}
      tenantName={membership?.tenantName ?? null}
      user={{ name: session.user.name, email: session.user.email }}
      theme={theme}
      onSwitchLocale={switchLocaleAction}
      timer={timer}
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
