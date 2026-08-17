import { FileQuestionIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { PageState } from "@/components/semantic";
import { Button } from "@/components/ui/button";

/**
 * 404 (never 403) inside the member plane — UI.md §7.3. One shape for
 * every whole-page state (§10.15 pattern 6): the title is the page's
 * h1 at the page-title size, on a card, at the content column's normal
 * top — the same left edge as the header and cards of every other
 * route, rather than floating in the middle of an empty canvas.
 */
export default async function AuthedNotFound() {
  const t = await getTranslations("shell.notFound");
  return (
    <PageState
      variant="filtered"
      icon={FileQuestionIcon}
      title={t("title")}
      body={t("description")}
      primary={
        <Button asChild>
          <Link href="/home">{t("home")}</Link>
        </Button>
      }
    />
  );
}
