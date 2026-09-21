import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { AuthShell } from "@/app/(tenant)/login/auth-shell";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.portal");
  return { title: t("title") };
}

/**
 * `/portal/login` — the portal's sign-in surface, still a LOCKED SHELL:
 * there is no form here yet, because there is no invite flow yet
 * (PLAN §0). What it is not is a 404.
 *
 * It moved here from `/portal` on 2026-09-21 (memo slice 3), when
 * `/portal` became a real page behind `requirePortalContext()`. That
 * guard redirects to this path, `src/proxy.ts` redirects to it for any
 * `/portal/...` request with no portal cookie, and it has been in
 * `PUBLIC_PATHS` since day one — so before this file existed, every one
 * of those redirects landed on a route Next had nothing for. The lockup
 * was already written and already the right words; it was simply behind
 * the wrong path.
 */
export default async function PortalLogin() {
  const t = await getTranslations("auth.portal");
  return <AuthShell plane="portal" eyebrow={t("eyebrow")} title={t("title")} description={t("closed")} />;
}
