import { LinkIcon } from "lucide-react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { AuthShell } from "@/app/(tenant)/login/auth-shell";
import { PageState } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { previewShareLink } from "@/modules/vault";
import { allowStrict, clientIp } from "@/ratelimit";

import { ShareOpenForm } from "./share-open-form";

/**
 * Never indexed, and never a Referer: the token is in this page's URL, and
 * a link out of it (the login's own web address) must not carry it along.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.portalShare");
  return { title: t("metaTitle"), robots: { index: false, follow: false }, referrer: "no-referrer" };
}

/**
 * `/portal/share/[token]` — A VAULT SHARE LINK (Phase 3V slice 90). The
 * recipient is somebody the agency gave ONE secret to, usually outside the
 * agency and on no plane at all, so the page is public by a proxy
 * exemption (`PORTAL_SHARE_PREFIX`, src/proxy.ts) and asks for nothing but
 * a code mailed to the address the link was made for — every time (C52
 * (k): even a signed-in client is only a password).
 *
 * **LOADING IT CHANGES NOTHING.** Mail scanners and chat previews open
 * links; a link they could spend would be a link nobody could use. This
 * render only reads (`previewShareLink`, under the SYSTEM principal of the
 * token's own tenant — never `withPlatform`); a code is mailed only when
 * the visitor presses for one, and the secret shown only for the right
 * code (`actions.ts`).
 *
 * **EVERY DEAD LINK IS THE SAME PAGE** — expired, opened, revoked, out of
 * tries, never real, another tenant's, or the read budget spent (the
 * founder's rule for every bad token, 2026-09-23). What a live link says
 * before the code is the agency's name and nothing else: not the login's
 * name, not the address.
 */
export default async function PortalSharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const t = await getTranslations("auth.portalShare");

  const within = await allowStrict("vault.share_open", clientIp(await headers()));
  const preview = within ? await previewShareLink(token) : null;

  if (!preview) {
    return (
      <AuthShell plane="portal">
        <PageState
          chrome="bare"
          variant="filtered"
          icon={LinkIcon}
          title={t("deadTitle")}
          body={t("dead")}
          primary={
            <Button asChild size="lg" className="w-full">
              <Link href="/portal/login" prefetch={false}>
                {t("signIn")}
              </Link>
            </Button>
          }
        />
      </AuthShell>
    );
  }

  return (
    <AuthShell
      plane="portal"
      eyebrow={t("eyebrow")}
      title={t("title", { tenant: preview.tenantName })}
      description={t("subtitle")}
    >
      <ShareOpenForm token={token} />
    </AuthShell>
  );
}
