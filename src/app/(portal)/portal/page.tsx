import { getTranslations } from "next-intl/server";

/**
 * Portal plane — LOCKED SHELL until Phase 3 (PLAN.md). The route group,
 * cookie namespace (__Host-flv.portal) and proxy gating exist from
 * day 1 so the plane separation is structural, not retrofitted.
 */
export default async function PortalShell() {
  const t = await getTranslations("auth.portal");
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-6 text-center">
      <h1 className="text-xl font-semibold">{t("title")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{t("closed")}</p>
    </main>
  );
}
