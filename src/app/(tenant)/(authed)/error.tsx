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
    <Page width="form">
      <EmptyState
        variant="forbidden"
        icon={OctagonAlertIcon}
        title={t("title")}
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
