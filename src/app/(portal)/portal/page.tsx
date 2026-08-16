import { getTranslations } from "next-intl/server";

import { AuthShell } from "@/app/(tenant)/login/auth-shell";

/**
 * Portal plane — LOCKED SHELL until Phase 3 (PLAN.md). The route group,
 * cookie namespace (__Host-flv.portal) and proxy gating exist from
 * day 1 so the plane separation is structural, not retrofitted.
 */
export default async function PortalShell() {
  const t = await getTranslations("auth.portal");
  return <AuthShell plane="portal" eyebrow={t("eyebrow")} title={t("title")} description={t("closed")} />;
}
