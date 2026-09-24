import Link from "next/link";
import { useTranslations } from "next-intl";

import { AuthShell, authLinkClass } from "@/app/(tenant)/login/auth-shell";
import { Button } from "@/components/ui/button";

/**
 * THE ADDRESS IS CONFIRMED, AND THE PERSON STILL HAS TO SIGN IN — two ways of
 * arriving here, one state: the link was for an address confirmed already
 * (the page, before any button), or this press confirmed it but the sign-in
 * after it did not go through (the form). Either way the next step is
 * `/login`, carrying `next`.
 *
 * The footer offers "Forgot your password?" for the plain case: somebody who
 * confirmed long ago, followed an old link here, and no longer remembers the
 * password `/login` is about to ask for. (The owner of an address a stranger
 * signed up first never reaches this state — their password is refused on
 * the form, which points them at the same reset.)
 *
 * No `"use client"`, for `ConfirmUnavailable`'s reason: the server page
 * renders it without shipping it, and the client form imports it without a
 * second copy. `description` is a node so the page can pass rich text.
 */
export function ConfirmedState({
  title,
  description,
  next,
}: {
  title: string;
  description: React.ReactNode;
  next: string;
}) {
  const t = useTranslations("auth");
  return (
    <AuthShell
      title={title}
      description={description}
      footer={
        <>
          {t("login.forgot")}{" "}
          <Link className={authLinkClass} href="/reset-password">
            {t("login.reset")}
          </Link>
        </>
      }
    >
      <Button asChild size="lg" className="w-full">
        <Link href={`/login?next=${encodeURIComponent(next)}`}>{t("confirmEmail.signIn")}</Link>
      </Button>
    </AuthShell>
  );
}
