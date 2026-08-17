"use client";

import { OctagonAlertIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect } from "react";

import { PageState } from "@/components/semantic";
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
    <PageState
      variant="forbidden"
      icon={OctagonAlertIcon}
      title={t("title")}
      body={
        // The promise and the thing promised live in the SAME guard: the
        // copy said "note the reference below" unconditionally while the
        // digest block rendered only when Next had one to give.
        [
          t("description"),
          ...(error.digest
            ? [t("referenceHint"), t("reference", { digest: error.digest })]
            : []),
        ].join(" ")
      }
      primary={<Button onClick={reset}>{t("retry")}</Button>}
      secondary={
        <Button asChild variant="outline">
          <Link href="/home">{t("home")}</Link>
        </Button>
      }
    />
  );
}
