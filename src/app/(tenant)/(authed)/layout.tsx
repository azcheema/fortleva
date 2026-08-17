import { isAuthorized } from "@/authz/authorize";
import { requireMemberSession } from "@/auth/session";
import { AppShell } from "@/components/shell/app-shell";
import { withTenant } from "@/db";
import { getThemePreference } from "@/lib/theme-server";
import { getActiveMembership, mfaStateOf } from "@/members/tenant-context";

import { switchLocaleAction } from "./account/actions";
import { NAV, visibleNav, type NavEntry } from "./nav";

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
    >
      {children}
    </AppShell>
  );
}

const collectPermissions = (entries: readonly NavEntry[]): string[] =>
  entries.flatMap((e) => [
    ...(e.permission ? [e.permission] : []),
    ...(e.children ? collectPermissions(e.children) : []),
  ]);
