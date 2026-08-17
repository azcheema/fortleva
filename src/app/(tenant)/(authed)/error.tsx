"use client";

import { OctagonAlertIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect } from "react";

import { EmptyState, Page } from "@/components/semantic";
import { Button } from "@/components/ui/button";

/** Error boundary for the member plane; the digest is the log correlation key. */
export default function AuthedError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("shell.error");
  useEffect(() => {
    console.error(error);
  }, [error]);

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
        variant="forbidden"
        icon={OctagonAlertIcon}
        title={t("title")}
        titleAs="h1"
        body={
          <>
            {t("description")}
            {error.digest ? (
              <span className="num mt-2 block font-mono text-xs text-muted-foreground">
                {t("reference", { digest: error.digest })}
              </span>
            ) : null}
          </>
        }
        action={<Button onClick={reset}>{t("retry")}</Button>}
        secondary={
          <Button asChild variant="outline">
            <Link href="/home">{t("home")}</Link>
          </Button>
        }
      />
    </Page>
  );
}
