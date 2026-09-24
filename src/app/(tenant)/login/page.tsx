import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Suspense } from "react";

import { AUTH_MAILS_PER_HOUR, EMAIL_CONFIRMATION_TTL_SECONDS } from "@/auth/recovery-policy";

import { LoginForm } from "./login-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.login");
  return { title: t("metaTitle") };
}

/**
 * `/login` — the member plane's sign-in, and the canonical entry point
 * every cookie-less member request is bounced to (src/proxy.ts).
 *
 * The form is a client module of its own (`login-form.tsx`) so that this
 * file can be a server component with a `generateMetadata` — the
 * convention every page in the product follows, and the portal's sign-in
 * already did. It reads `useSearchParams`, so it needs the `<Suspense>`.
 *
 * The two numbers it quotes come from `src/auth/recovery-policy.ts`, the
 * one module the instance that enforces them reads too: an unconfirmed
 * member who signs in with the right password is mailed a new
 * confirmation link (C30 (b)), and the screen says how many of those
 * there can be in an hour and how long each works. A sentence promising a
 * link over a cap somebody later lowered would be a promise nobody keeps.
 */
export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm
        cap={AUTH_MAILS_PER_HOUR}
        minutes={Math.round(EMAIL_CONFIRMATION_TTL_SECONDS / 60)}
      />
    </Suspense>
  );
}
