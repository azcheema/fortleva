import { getTranslations } from "next-intl/server";

import { requirePlatformAdmin } from "@/auth/session";

export default async function OpsHome() {
  const session = await requirePlatformAdmin();
  const t = await getTranslations("auth.ops");

  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {t("signedInAs", { email: session.user.email })}
      </p>
    </main>
  );
}
