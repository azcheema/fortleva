import { FileQuestionIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { EmptyState, Page } from "@/components/semantic";
import { Button } from "@/components/ui/button";

/** 404 (never 403) inside the member plane — UI.md §7.3. */
export default async function AuthedNotFound() {
  const t = await getTranslations("shell.notFound");
  return (
    <Page width="form">
      <EmptyState
        variant="filtered"
        icon={FileQuestionIcon}
        title={t("title")}
        body={t("description")}
        action={
          <Button asChild>
            <Link href="/home">{t("home")}</Link>
          </Button>
        }
      />
    </Page>
  );
}
