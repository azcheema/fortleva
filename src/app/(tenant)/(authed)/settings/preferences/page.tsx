import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { EmptyState } from "@/components/empty-state";
import { Page, PageHeader } from "@/components/page-header";
import { requireTenantContext } from "@/members/tenant-context";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("preferences") };
}

/** Placeholder: TenantPreference editing arrives with the settings pages of Phase 2. */
export default async function PreferencesPage() {
  await requireTenantContext();
  const t = await getTranslations("settings.preferences");
  return (
    <Page>
      <PageHeader title={t("title")} />
      <section className="mt-6">
        <EmptyState title={t("emptyTitle")} description={t("emptyDescription")} />
      </section>
    </Page>
  );
}
