import { FileQuestionIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { EmptyState, Page } from "@/components/semantic";
import { Button } from "@/components/ui/button";

/** 404 (never 403) inside the member plane — UI.md §7.3. */
export default async function AuthedNotFound() {
  const t = await getTranslations("shell.notFound");
  return (
    // This state IS the page, so it is centred in what is left of the
    // viewport under the header: the top-left corner of an otherwise
    // empty canvas reads as a page that failed to load rather than as a
    // deliberate answer.
    <Page
      width="form"
      className="flex min-h-[calc(100svh-var(--header-h))] flex-col justify-center"
    >
      <EmptyState
        variant="filtered"
        icon={FileQuestionIcon}
        title={t("title")}
        titleAs="h1"
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
