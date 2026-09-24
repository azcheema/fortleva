import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { RESET_MAILS_PER_HOUR, RESET_TTL_SECONDS } from "@/auth/portal";

import { ForgotPasswordForm } from "./forgot-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.portalReset");
  return { title: t("metaTitle") };
}

/**
 * `/portal/reset-password` — the first half of the portal's password reset:
 * an address, and a promise that a link is on its way if it belongs to
 * anybody.
 *
 * **WHY IT EXISTS NOW.** Until this page the portal's sign-in form was the
 * only door back in, and a contact who forgot their password had no way
 * through it short of losing their access first — a member ending it and
 * inviting them afresh (C28). The endpoint behind this form has been
 * mounted since the portal shipped; what was missing was a screen, and a
 * link to it from the sign-in form.
 *
 * **PUBLIC, BY AN EXACT PROXY ENTRY** (`PORTAL_RESET`, src/proxy.ts):
 * somebody who has forgotten their password has no session by definition.
 * The page has no Server Action — the form calls the portal auth API from
 * the browser, where Better Auth's own limiter and ours both sit — so the
 * exemption opens a render and nothing else.
 *
 * Everything that decides whether a mail is actually SENT lives on the
 * instance (`deliverPortalReset`, src/auth/portal.ts), because the endpoint
 * answers anyone with curl whether or not this page exists.
 */
export default function PortalResetRequest() {
  return (
    <ForgotPasswordForm minutes={Math.round(RESET_TTL_SECONDS / 60)} cap={RESET_MAILS_PER_HOUR} />
  );
}
