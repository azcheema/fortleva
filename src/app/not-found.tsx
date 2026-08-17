import { FileQuestionIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { AuthShell } from "@/app/(tenant)/login/auth-shell";
import { PageState } from "@/components/semantic";
import { Button } from "@/components/ui/button";

/**
 * Root 404 (outside the member shell): the unauthenticated lockup as
 * chrome, and the SAME whole-page state every other dead end renders —
 * one 22px h1, on a card, with an action (UI.md §10.15 pattern 6).
 *
 * The action is "Sign in", not "Go to Home": every non-public route is
 * redirected to /login by the proxy (§7.3), so a Home button bounced an
 * anonymous visitor through a redirect to reach the page it should have
 * offered in the first place.
 */
export default async function RootNotFound() {
  const t = await getTranslations("shell.notFound");
  return (
    <AuthShell>
      <PageState
        chrome="bare"
        variant="filtered"
        icon={FileQuestionIcon}
        title={t("title")}
        body={t("description")}
        primary={
          <Button asChild size="lg" className="w-full">
            <Link href="/login">{t("signIn")}</Link>
          </Button>
        }
      />
    </AuthShell>
  );
}
