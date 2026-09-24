import { Link2OffIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { AuthShell } from "@/app/(tenant)/login/auth-shell";
import { PageState } from "@/components/semantic";
import { Button } from "@/components/ui/button";

/**
 * THE ONE STATE FOR A MEMBER RESET LINK THAT CANNOT BE USED — unknown,
 * expired, already used, superseded by a newer reset, or belonging to a
 * console principal (whose password is the operator script's, never a
 * mailbox's). `memberResetHolder` answers the same null for all of them,
 * and this renders that null the same way everywhere it can be met. The
 * portal's `reset-unavailable.tsx` on the member plane.
 *
 * **IT HAS TWO CALLERS, AND THAT IS WHY IT IS A COMPONENT OF ITS OWN.** The
 * new-password page renders it when the link is dead on arrival; the form
 * renders it when the link dies WHILE the person is typing — the hour runs
 * out, or they used a newer mail in another tab — and the POST comes back
 * `INVALID_TOKEN`. Same person, same door.
 *
 * No `"use client"`: it holds no state and reads its strings through
 * `useTranslations`, which works on either side of the boundary, so the
 * server page renders it without shipping it and the client form imports
 * it without a second copy.
 *
 * A way forward is REQUIRED (`PageState`, UI.md §5.15), and here there is
 * exactly one worth offering: a new link. A member who has remembered
 * their password in the meantime is one link away on the next page.
 */
export function ResetUnavailable({ minutes }: { minutes: number }) {
  const t = useTranslations("auth.memberReset");
  return (
    <AuthShell>
      <PageState
        chrome="bare"
        variant="filtered"
        icon={Link2OffIcon}
        title={t("unavailableTitle")}
        body={t("unavailable", { minutes })}
        primary={
          <Button asChild size="lg" className="w-full">
            <Link href="/reset-password">{t("requestNew")}</Link>
          </Button>
        }
      />
    </AuthShell>
  );
}
