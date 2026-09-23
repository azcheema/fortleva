import { MailXIcon } from "lucide-react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { AuthShell, authLinkClass } from "@/app/(tenant)/login/auth-shell";
import { portalPasswordPolicy } from "@/auth/portal";
import { previewContactInvite } from "@/clients/contact-invite-token";
import { PageState } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { allowStrict, clientIp } from "@/ratelimit";

import { AcceptInviteForm } from "./accept-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.portalInvite");
  return { title: t("metaTitle") };
}

/**
 * `/portal/invite/[token]` — THE PORTAL'S FIRST DOOR, and the only
 * surface in this product that takes input from somebody with no
 * session. `portalInviteUrl` has built this address since the server
 * half shipped and the invitation mail has linked to it, so the route
 * was owed before anything was allowed to send one.
 *
 * **IT IS PUBLIC BY AN EXPLICIT PROXY EXEMPTION** (`PORTAL_INVITE_PREFIX`,
 * src/proxy.ts): `/portal/*` is otherwise gated on the portal session
 * cookie, and an invitee has none by construction. That exemption opens
 * this page's SERVER ACTION too, because an action POSTs to its own
 * pathname — which is why both halves spend from the same budget.
 *
 * **THE READ IS METERED TOO, AND ON ITS OWN BUCKET.**
 * `previewContactInvite` runs under `withPlatform`, and `withPlatform`
 * audits every invocation including its read-only ones — so an unmetered
 * loop over random tokens appends `platform.system_job` rows to an
 * append-only table with no pruning job before Phase 8. Guessing the
 * token itself is not the threat (32 random bytes); the table is, and
 * `portal.invite_preview` is sized for that harm while the action's
 * `portal.invite_accept` is sized for a write. Both spend through
 * `allowStrict` rather than `allow`, because on this path the bucket is
 * the ONLY control — a Next route has no Better Auth limiter under it
 * and there is no row to count for a visitor who has presented nothing
 * but a token — and `allow` is a no-op until Upstash is provisioned.
 *
 * **EVERY REFUSAL IS THE SAME REFUSAL** (founder decision, 2026-09-23):
 * expired, already consumed, superseded by a newer invitation, never
 * existed, another tenant's — and now "you have spent your budget" — all
 * render the state below, word for word. `previewContactInvite` already
 * guarantees its half by answering `null` without distinguishing them,
 * and the temptation this page must resist is the helpful one: it HOLDS
 * `preview.status` and `preview.expired` and could write "this
 * invitation has expired". It must not. Nobody learns whether a link was
 * ever real.
 *
 * **THE AGENCY'S NAME IS THE POINT OF THE HEADER.** Somebody who has
 * just clicked a link in an email is being asked to choose a password;
 * the one thing that makes that reasonable is seeing who is asking, over
 * their own name and the address it was sent to.
 */
export default async function PortalInvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const t = await getTranslations("auth.portalInvite");

  const within = await allowStrict("portal.invite_preview", clientIp(await headers()));
  const preview = within ? await previewContactInvite(token) : null;

  if (!preview || preview.status !== "PENDING" || preview.expired) {
    // A dead end is not a state (UI.md §5.8): `PageState` requires a way
    // forward, and on this plane there is exactly one — the portal's own
    // sign-in form, which is where somebody whose invitation has already
    // been accepted actually needs to go.
    return (
      <AuthShell plane="portal">
        <PageState
          chrome="bare"
          variant="filtered"
          icon={MailXIcon}
          title={t("unavailableTitle")}
          body={t("unavailable")}
          primary={
            <Button asChild size="lg" className="w-full">
              <Link href="/portal/login">{t("signIn")}</Link>
            </Button>
          }
        />
      </AuthShell>
    );
  }

  const { min, max } = await portalPasswordPolicy();
  return (
    <AuthShell
      plane="portal"
      eyebrow={t("eyebrow")}
      title={t("title", { tenant: preview.tenantName })}
      description={t.rich("subtitle", {
        name: preview.contactName,
        email: preview.email,
        strong: (chunks) => <strong className="font-medium text-foreground">{chunks}</strong>,
      })}
      // **THE FORM NEEDS AN EXIT TOO, and it had none.** The dead-end
      // state above offers a way forward because `PageState` requires
      // one, and a review pointed out the asymmetry: a visitor whose
      // invitation is refused INLINE — a link already accepted, then
      // reloaded and submitted — read "ask your agency for a new link"
      // with no control on the page at all, while the very same refusal
      // reached one segment earlier offers Sign in. It is the same
      // person, needing the same door.
      //
      // It sits in the shell's footer rather than beside the submit
      // button because an auth page is allowed exactly ONE --primary
      // element, and that is the button.
      footer={
        <>
          {t("already")}{" "}
          <Link className={authLinkClass} href="/portal/login">
            {t("signIn")}
          </Link>
        </>
      }
    >
      <AcceptInviteForm token={token} minLength={min} maxLength={max} />
    </AuthShell>
  );
}
