"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

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
    <div className="mx-auto w-full max-w-md px-4 py-16">
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {error.digest ? (
            <p className="font-mono text-xs text-muted-foreground">
              {t("reference", { digest: error.digest })}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button onClick={reset}>{t("retry")}</Button>
            <Button asChild variant="outline">
              <Link href="/home">{t("home")}</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
