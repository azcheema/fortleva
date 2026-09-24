import { MailXIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { AuthShell } from "@/app/(tenant)/login/auth-shell";
import { PageState } from "@/components/semantic";
import { Button } from "@/components/ui/button";

/**
 * THE ONE STATE FOR A CONFIRMATION LINK THAT CANNOT BE USED — forged,
 * expired, a change-of-address link (refused on this plane), an account
 * that no longer exists, a console principal's. `confirmEmailHolder`
 * answers the same null for all of them, and this renders that null the
 * same way everywhere it can be met.
 *
 * **TWO CALLERS, like the reset's `ResetUnavailable`:** the page renders it
 * when the link is dead on arrival, and the form renders it when the
 * page's action refuses the link after the page was drawn — the hour ran
 * out while the tab sat open.
 *
 * **ITS WAY FORWARD IS SIGNING IN, not a "send a new link" button**,
 * because that IS how a new link is sent (C30 (b)): the right password to
 * an unconfirmed account mails a fresh one, and the sign-in screen says so.
 * There is no unauthenticated re-send — it mailed any unconfirmed account
 * on a stranger's say-so, and stays refused (`./closed-endpoints` in
 * src/auth). `next` is carried through, so the person still ends up where
 * they were going when they signed up.
 *
 * No `"use client"`: it holds no state, and `useTranslations` works on
 * either side of the boundary, so the server page renders it without
 * shipping it and the client form imports it without a second copy.
 */
export function ConfirmUnavailable({ minutes, next }: { minutes: number; next: string }) {
  const t = useTranslations("auth.confirmEmail");
  return (
    <AuthShell>
      <PageState
        chrome="bare"
        variant="filtered"
        icon={MailXIcon}
        title={t("unavailableTitle")}
        body={t("unavailable", { minutes })}
        primary={
          <Button asChild size="lg" className="w-full">
            <Link href={`/login?next=${encodeURIComponent(next)}`}>{t("signIn")}</Link>
          </Button>
        }
      />
    </AuthShell>
  );
}
