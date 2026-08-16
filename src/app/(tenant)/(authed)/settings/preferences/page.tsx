import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { effectivePermissions } from "@/authz/authorize";
import { AuthzError } from "@/authz/errors";
import { Callout, Page, PageHeader, SectionCard } from "@/components/semantic";
import { withTenant } from "@/db";
import { parseEntitlements } from "@/entitlements/resolver";
import { requireTenantContext } from "@/members/tenant-context";
import { getPreferences, type TenantPreferences } from "@/preferences/service";

import { GeneralPreferencesForm, ModuleToggles } from "./preference-forms";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("preferences") };
}

/**
 * /settings/preferences (PLAN.md Phase 2): workspace locale, timezone,
 * week start, ISO weeks, duration style, currency (settings:edit) and
 * the tenant's own module switches (settings:manage_modules ✦).
 * settings:view sees everything read-only.
 */
export default async function PreferencesPage() {
  const { membership, actor } = await requireTenantContext();
  const t = await getTranslations("settings.preferences");

  let prefs: TenantPreferences | null = null;
  try {
    prefs = await getPreferences({ tenantId: membership.tenantId, actor });
  } catch (e) {
    if (!(e instanceof AuthzError)) throw e;
  }
  if (!prefs) {
    return (
      <Page width="form">
        <PageHeader title={t("title")} />
        <Callout tone="info" className="mt-4">
          {t("noPermission")}
        </Callout>
      </Page>
    );
  }

  const { held, entitled } = await withTenant(
    membership.tenantId,
    { type: "member", id: membership.memberId },
    async (tx) => {
      const [held, tenant] = await Promise.all([
        effectivePermissions(tx, actor.memberId),
        tx.tenant.findFirst({ where: { id: membership.tenantId }, select: { entitlements: true } }),
      ]);
      return { held, entitled: parseEntitlements(tenant?.entitlements).modules };
    },
  );

  return (
    <Page width="form">
      <PageHeader title={t("title")} description={t("description")} />
      <div className="mt-6 grid gap-4">
        <SectionCard title={t("general")} description={t("generalDescription")}>
          <GeneralPreferencesForm prefs={prefs} editable={held.has("settings:edit")} />
        </SectionCard>
        <SectionCard title={t("modulesTitle")} description={t("modulesDescription")}>
          {/* ✦ code: shown to holders; a stale factor becomes step-up on the first flip. */}
          <ModuleToggles
            prefs={prefs}
            entitled={entitled}
            canManage={held.has("settings:manage_modules")}
          />
        </SectionCard>
      </div>
    </Page>
  );
}
