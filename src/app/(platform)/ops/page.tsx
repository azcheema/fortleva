import { ShieldIcon } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { requirePlatformAdmin } from "@/auth/session";
import { Page, PageHeader, SectionCard } from "@/components/semantic";
import { Badge } from "@/components/ui/badge";

/**
 * The platform console shell. Minimal by design (the console UI lands
 * in Phase 7) but on the same tokens, and always wearing the "Platform"
 * eyebrow so the plane is unmistakable.
 */
export default async function OpsHome() {
  const session = await requirePlatformAdmin();
  const t = await getTranslations("auth.ops");

  return (
    <Page width="form">
      <PageHeader
        title={t("title")}
        badges={
          <Badge variant="brand">
            <ShieldIcon aria-hidden="true" />
            {t("eyebrow")}
          </Badge>
        }
      />
      <div className="mt-6">
        <SectionCard title={t("session")}>
          <p className="text-sm text-muted-foreground">
            {t("signedInAs", { email: session.user.email })}
          </p>
        </SectionCard>
      </div>
    </Page>
  );
}
