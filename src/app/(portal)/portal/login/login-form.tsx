"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { AUTH_CONTROL, AuthShell } from "@/app/(tenant)/login/auth-shell";
import { contactAuthClient } from "@/auth/client";
import { Field, FormMessage } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { safeNext } from "@/lib/safe-next";

/**
 * The portal's sign-in form. `page.tsx` beside it holds the reason this
 * surface stopped being a locked shell; this file holds only how it
 * behaves, so the two do not carry the same paragraph twice.
 *
 * **EVERY FAILURE IS ONE MESSAGE.** A wrong password, an unknown
 * address, an unverified one, a paused contact and an ended one are
 * already indistinguishable from outside — the instance checks admission
 * in a `session.create` hook precisely so that refusing cannot be used
 * to ask whether an address belongs to a contact (`src/auth/portal.ts`)
 * — and this form keeps it that way by rendering its OWN sentence rather
 * than the server's. On this plane a difference is a fact about the
 * agency and its client list.
 *
 * **NO SIGN-UP LINK** — `disableSignUp` is true on the instance and
 * invite-only is the invariant, so a link would advertise a door that is
 * welded shut. **NO SECOND FACTOR**: this instance registers no
 * `twoFactor` plugin, so unlike `/login` there is no TOTP stage to fall
 * through to. **NO FORGOTTEN-PASSWORD LINK YET**: the endpoint is
 * mounted and `sendResetPassword` already declines a non-ACTIVE contact,
 * but the reset SCREEN does not exist, and a link to a route that cannot
 * answer is worse than no link.
 */
export function PortalLoginForm() {
  const t = useTranslations("auth");
  const router = useRouter();
  const params = useSearchParams();
  // The proxy bounces every cookie-less `/portal/...` request here with
  // `?next=<pathname>` — a path it wrote itself. The form reads whatever
  // is in the URL, though, so the value is run through the product's one
  // redirect guard (`src/lib/safe-next.ts`), confined to this plane.
  //
  // The first version of this was `requested.startsWith("/portal")`,
  // which a review pointed out admits `/portal/../home`: the browser
  // normalises it out of the portal entirely, so the prefix check read
  // like a guard and was not one. It also admitted `/portalfoo`.
  const next = safeNext(params.get("next"), "/portal", "/portal");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: err } = await contactAuthClient.signIn.email({ email, password });
    setBusy(false);
    if (err) {
      setError(t("portal.failed"));
      return;
    }
    router.push(next);
  }

  return (
    <AuthShell plane="portal" eyebrow={t("portal.eyebrow")} title={t("portal.title")} description={t("portal.subtitle")}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label={t("email")} htmlFor="portal-email">
          <Input
            id="portal-email"
            type="email"
            required
            autoComplete="email"
            className={AUTH_CONTROL}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label={t("password")} htmlFor="portal-password">
          <Input
            id="portal-password"
            type="password"
            required
            autoComplete="current-password"
            className={AUTH_CONTROL}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Button type="submit" size="lg" className="mt-2 w-full" disabled={busy}>
          {busy ? t("portal.submitting") : t("portal.submit")}
        </Button>
      </form>
      {error ? <FormMessage state={{ ok: false, message: error }} /> : null}
    </AuthShell>
  );
}
