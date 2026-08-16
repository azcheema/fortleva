import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { AuthShell } from "@/app/(tenant)/login/auth-shell";
import { Button } from "@/components/ui/button";

/** Root 404 (outside the member shell): the unauthenticated lockup. */
export default async function RootNotFound() {
  const t = await getTranslations("shell.notFound");
  return (
    <AuthShell title={t("title")} description={t("description")}>
      <div>
        <Button asChild size="lg">
          <Link href="/">{t("home")}</Link>
        </Button>
      </div>
    </AuthShell>
  );
}
