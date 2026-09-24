import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { AUTH_MAILS_PER_HOUR, MEMBER_RESET_TTL_SECONDS } from "@/auth/recovery-policy";

import { ForgotPasswordForm } from "./forgot-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.memberReset");
  return { title: t("metaTitle") };
}

/**
 * `/reset-password` — the first half of the member plane's password
 * reset (OPEN_QUESTIONS C30 (a)): an address, and a promise that a link is
 * on its way if it belongs to anybody. The portal's
 * `/portal/reset-password` is the model, and this differs from it only
 * where the member plane does.
 *
 * **WHY IT EXISTS.** Until C30 a member who forgot their password had no
 * way back on their own — not by any screen, and since slice 58 not by
 * curl either, because the endpoint was refused while it had no screen in
 * front of it. It is also the way out of the pre-account takeover: the
 * owner of an address a stranger signed up first CANNOT confirm it — the
 * confirmation page wants the account's password, which is the stranger's —
 * so that page sends them here, and a completed reset replaces the
 * stranger's password and confirms the address
 * (`afterMemberPasswordReset`, src/auth/member-recovery.ts). The stranger
 * never held a session to lose: an unconfirmed account cannot sign in.
 *
 * **PUBLIC, BY AN EXACT PROXY ENTRY** (`MEMBER_RESET`, src/proxy.ts):
 * somebody who has forgotten their password has no session by definition.
 * The page has no Server Action — the form calls the member auth API from
 * the browser, where Better Auth's own limiter and ours both sit — so the
 * exemption opens a render and nothing else.
 *
 * Everything that decides whether a mail is actually SENT lives on the
 * instance (`deliverMemberReset`), because the endpoint answers anyone with
 * curl whether or not this page exists. The two numbers the page quotes
 * come from `src/auth/recovery-policy.ts`, the module that instance reads.
 */
export default function MemberResetRequest() {
  return (
    <ForgotPasswordForm
      minutes={Math.round(MEMBER_RESET_TTL_SECONDS / 60)}
      cap={AUTH_MAILS_PER_HOUR}
    />
  );
}
