import { Link2OffIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { AuthShell } from "@/app/(tenant)/login/auth-shell";
import { PageState } from "@/components/semantic";
import { Button } from "@/components/ui/button";

/**
 * THE ONE STATE FOR A RESET LINK THAT CANNOT BE USED — unknown, expired,
 * already used, superseded by a successful reset, or belonging to a contact
 * whose access has since been paused or ended. `portalResetHolder` answers
 * the same null for all of them, and this renders that null the same way
 * everywhere it can be met.
 *
 * **IT HAS TWO CALLERS, AND THAT IS WHY IT IS A COMPONENT OF ITS OWN.** The
 * new-password page renders it when the link is already dead on arrival;
 * the form renders it when the link dies WHILE the person is typing — the
 * hour runs out, or they used a newer mail in another tab — and the POST
 * comes back `INVALID_TOKEN`. That is the same person needing the same
 * door, which is the asymmetry the invitation page's review caught when
 * its inline refusal offered no way forward while the whole-page one did.
 *
 * No `"use client"`: it holds no state and reads its strings through
 * `useTranslations`, which works on either side of the boundary, so the
 * server page renders it without shipping it and the client form imports
 * it without a second copy.
 *
 * A way forward is REQUIRED (`PageState`, UI.md §5.15), and here there is
 * exactly one worth offering: a new link. A contact who has remembered
 * their password in the meantime is one link away on the next page.
 */
export function ResetUnavailable({ minutes }: { minutes: number }) {
  const t = useTranslations("auth.portalReset");
  return (
    <AuthShell plane="portal">
      <PageState
        chrome="bare"
        variant="filtered"
        icon={Link2OffIcon}
        title={t("unavailableTitle")}
        body={t("unavailable", { minutes })}
        primary={
          <Button asChild size="lg" className="w-full">
            <Link href="/portal/reset-password">{t("requestNew")}</Link>
          </Button>
        }
      />
    </AuthShell>
  );
}
