import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { effectivePermissions } from "@/authz/authorize";
import { AuthzError } from "@/authz/errors";
import { EmptyState, Page, PageHeader, SectionCard } from "@/components/semantic";
import { withTenant } from "@/db";
import { requireTenantContext } from "@/members/tenant-context";
import { getPreferences, type TenantPreferences } from "@/preferences/service";

import { VaultSwitch } from "./vault-switch";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings.vault");
  return { title: t("title") };
}

/**
 * /settings/vault (Phase 3V slice 91) — the vault's two workspace switches:
 * share links (slice 90's switch, which had no screen until now) and logins
 * shown to clients (founder decision C52 (d): off by default; C59 (b):
 * switching it off hides every shown login for good). `settings:view`
 * reads the page; `settings:edit` switches either off; switching either on
 * also takes `settings:manage_modules` ✦ (AUTHZ.md §5) — the service checks
 * all of it, and any change asks a fresh factor.
 */
export default async function VaultSettingsPage() {
  const { membership, actor } = await requireTenantContext();
  const t = await getTranslations("settings.vault");
  const tCommon = await getTranslations("common");

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
        <div className="mt-6">
          <SectionCard>
            <EmptyState variant="forbidden" title={tCommon("forbiddenTitle")} body={t("noPermission")} />
          </SectionCard>
        </div>
      </Page>
    );
  }

  const held = await withTenant(membership.tenantId, { type: "member", id: membership.memberId }, (tx) =>
    effectivePermissions(tx, actor.memberId),
  );
  const canEdit = held.has("settings:edit");
  const canTurnOn = canEdit && held.has("settings:manage_modules");

  return (
    <Page width="form">
      <PageHeader title={t("title")} description={t("description")} />
      <div className="mt-6 flex flex-col gap-4">
        <SectionCard title={t("shareLinks.title")}>
          <VaultSwitch
            name="shareLinks"
            on={prefs.vault.allowExternalShareLinks}
            canEdit={canEdit}
            canTurnOn={canTurnOn}
          />
        </SectionCard>
        <SectionCard title={t("clientLogins.title")}>
          <VaultSwitch
            name="clientLogins"
            on={prefs.vault.allowPortalCredentials}
            canEdit={canEdit}
            canTurnOn={canTurnOn}
          />
        </SectionCard>
      </div>
    </Page>
  );
}
