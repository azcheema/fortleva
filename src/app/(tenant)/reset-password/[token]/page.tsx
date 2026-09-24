import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { memberResetHolder } from "@/auth/member-recovery";
import { memberPasswordPolicy } from "@/auth/member-screens";
import { MEMBER_RESET_TTL_SECONDS } from "@/auth/recovery-policy";

import { ResetUnavailable } from "../reset-unavailable";

import { NewPasswordForm } from "./new-password-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.memberReset");
  // NO `referrer` OVERRIDE — the portal's new-password page records why.
  // The harm one did there fell on Server Actions (a native POST before
  // hydration carries `Origin: null`, which Next refuses); the good it
  // claimed was none: the token reaches the access log on the GET that
  // opens this page whatever later requests carry, and this page makes no
  // request to another origin for a Referer to leak through.
  return { title: t("newMetaTitle") };
}

/**
 * `/reset-password/[token]` — where the member reset mail lands
 * (`memberResetUrl`, src/auth/member-recovery.ts): a new password, twice,
 * over the address it is for. The portal's `/portal/reset-password/[token]`
 * on the member plane.
 *
 * **PUBLIC BY A PREFIX EXEMPTION** (`MEMBER_RESET_PREFIX`, src/proxy.ts),
 * because the token is a path segment and an exact entry could only ever
 * exempt the bare path. The page has no Server Action — the form calls the
 * member auth API from the browser — so the exemption opens a render and
 * nothing else.
 *
 * **THE LINK IS CHECKED BEFORE THE FORM IS DRAWN**, so a stale mail is met
 * with "ask for a new one" rather than with two password boxes whose
 * contents the service is certain to refuse. The check is
 * `memberResetHolder`, which checks the expiry the library's own lookup
 * does not, and refuses a console principal's link — which the instance
 * refuses independently at redemption (`refuseResetOfConsolePrincipal`).
 *
 * **IT IS NOT METERED**, and that is a decision rather than an oversight:
 * the portal meters its invitation page because that read appends an
 * audit row on every call, and this one writes nothing an attacker can
 * grow — two reads, of a hashed identifier and of a user row. Guessing a
 * live link through it is guessing 24 random alphanumerics.
 *
 * **THE ADDRESS IS SHOWN** because it answers the first question anybody
 * asks on this page — which account am I changing? — and because a
 * password manager needs it to file the new password under the right
 * name. Whoever holds the link was mailed it at that address: the delivery
 * re-reads the account and declines a request that raced a change of
 * address (`deliverMemberReset`).
 *
 * **WHETHER A SECOND FACTOR WILL BE ASKED FOR** is read here too, because
 * it decides what the form does after the save: a member with one cannot
 * finish signing in on this screen, so the form sends them to `/login`
 * rather than half-way through a sign-in it cannot complete.
 */
export default async function MemberResetPassword({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const minutes = Math.round(MEMBER_RESET_TTL_SECONDS / 60);
  const holder = await memberResetHolder(token);
  if (!holder) return <ResetUnavailable minutes={minutes} />;

  const { min, max } = await memberPasswordPolicy();
  return (
    <NewPasswordForm
      token={token}
      email={holder.email}
      twoFactor={holder.twoFactor}
      minLength={min}
      maxLength={max}
      minutes={minutes}
    />
  );
}
