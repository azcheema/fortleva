import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { portalPasswordPolicy, portalResetHolder, RESET_TTL_SECONDS } from "@/auth/portal";

import { ResetUnavailable } from "../reset-unavailable";

import { NewPasswordForm } from "./new-password-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.portalReset");
  // NO `referrer` OVERRIDE, and the first cut of this slice had one
  // (`no-referrer`, here and on the invitation page). A review traced it,
  // through the Fetch spec and Next's action handler, doing harm and no good. Harm: under `no-referrer` a browser sends
  // `Origin: null` on a POST that is not CORS-mode — a native form
  // submission before hydration — and Next refuses a Server Action whose
  // Origin does not match the host, so the invitation form would have failed
  // for anyone who pressed it before the page's script had loaded. No good: the token
  // reaches our access logs on the GET that opens this page whatever any
  // later request carries, and the browsers' own default already strips the
  // path from a Referer sent to another origin — of which this page makes
  // none.
  return { title: t("newMetaTitle") };
}

/**
 * `/portal/reset-password/[token]` — where the reset mail lands: a new
 * password, twice, over the address it is for.
 *
 * **PUBLIC BY A PREFIX EXEMPTION** (`PORTAL_RESET_PREFIX`, src/proxy.ts),
 * for the reason the invitation's is a prefix: the token is a path segment,
 * and an exact entry could only ever exempt the bare path.
 *
 * **THE LINK IS CHECKED BEFORE THE FORM IS DRAWN**, so a stale mail is met
 * with "ask for a new one" rather than with two password boxes whose
 * contents the service is certain to refuse. The check is
 * `portalResetHolder`, which also refuses a contact who may no longer sign
 * in — the page must not offer a paused contact a form that the endpoint
 * would then refuse, and it does, independently (the instance's
 * `burnResetTokenOfInactiveContact`).
 *
 * **IT IS NOT METERED**, and that is a decision rather than an oversight:
 * the invitation page meters its read because `previewContactInvite`
 * appends a `platform.system_job` audit row on every call. This read
 * writes nothing an attacker can grow, and Better Auth's own
 * `/reset-password/:token` callback already answers the same question
 * unmetered for anyone who asks it directly — so a bucket here would bound
 * nothing.
 *
 * **THE ADDRESS IS SHOWN** because it is the answer to the first question
 * anybody asks on this page — which account am I changing? — and because
 * a password manager needs it to file the new password under the right
 * name. Whoever holds the link was mailed it at that address — which is
 * true only because changing a contact's address kills every link mailed to
 * the old one (`updateContact`), AND the delivery re-reads the contact and
 * declines a request that raced the change (`deliverPortalReset`); the
 * purge alone left that race open. Before that purge, a link sent to an old
 * mailbox would have shown whoever opened it the NEW address, and signed
 * them in (review finding).
 */
export default async function PortalResetPassword({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const minutes = Math.round(RESET_TTL_SECONDS / 60);
  const holder = await portalResetHolder(token);
  if (!holder) return <ResetUnavailable minutes={minutes} />;

  const { min, max } = await portalPasswordPolicy();
  return (
    <NewPasswordForm
      token={token}
      email={holder.email}
      minLength={min}
      maxLength={max}
      minutes={minutes}
    />
  );
}
