import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { AuthShell } from "@/app/(tenant)/login/auth-shell";
import { getMemberSession } from "@/auth/session";
import { AuthzError } from "@/authz/errors";
import { Callout, EntityChip } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { acceptInvite, previewInvite } from "@/members/invites";
import { allow, clientIp } from "@/ratelimit";

/**
 * Invitation acceptance. The link carries the raw token exactly once;
 * the page previews the invite, and a signed-in user whose email
 * matches accepts it. Not signed in → sign up first, come back.
 *
 * The inviting workspace is shown as an EntityChip so the reader
 * recognises what they are about to join before they act.
 */
export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { token } = await params;
  const { error } = await searchParams;
  const t = await getTranslations("auth.invite");
  const preview = await previewInvite(token);

  if (!preview || preview.status !== "PENDING" || preview.expired) {
    return <AuthShell eyebrow={t("eyebrow")} title={t("unavailableTitle")} description={t("unavailable")} />;
  }

  // previewInvite() runs before authentication and deliberately returns
  // no tenant id; the chip derives its colour from the name, which is
  // the documented last-resort fallback.
  const workspace = (
    <EntityChip
      id={null}
      name={preview.tenantName}
      kind="client"
      size="md"
      className="font-medium"
    />
  );

  const session = await getMemberSession();
  if (!session) {
    return (
      <AuthShell
        eyebrow={t("eyebrow")}
        title={t("joinTitle", { tenant: preview.tenantName })}
        description={t.rich("signInFirst", {
          email: preview.email,
          strong: (chunks) => <strong className="font-medium text-foreground">{chunks}</strong>,
        })}
      >
        {workspace}
        <Button asChild size="lg" className="w-full">
          <Link href={`/signup?next=/invite/${token}`}>{t("createOrSignIn")}</Link>
        </Button>
      </AuthShell>
    );
  }

  async function accept() {
    "use server";
    const current = await getMemberSession();
    if (!current) redirect(`/login?next=/invite/${token}`);
    // Token guessing budget per IP (no-op until Upstash env exists).
    if (!(await allow("auth.invite_accept", clientIp(await headers())))) {
      redirect(`/invite/${token}?error=1`);
    }
    try {
      await acceptInvite({
        token,
        userId: current.user.id,
        userEmail: current.user.email,
      });
    } catch (e) {
      if (e instanceof AuthzError) redirect(`/invite/${token}?error=1`);
      throw e;
    }
    redirect("/home");
  }

  const mismatch = session.user.email !== preview.email;

  return (
    <AuthShell
      eyebrow={t("eyebrow")}
      title={t("joinTitle", { tenant: preview.tenantName })}
      description={t("signedInAs", { email: session.user.email })}
    >
      {workspace}
      {mismatch ? (
        <Callout tone="caution" role="status">
          {t("mismatch", { email: preview.email })}
        </Callout>
      ) : null}
      {error ? (
        <Callout tone="danger" role="alert">
          {t("failed")}
        </Callout>
      ) : null}
      <form action={accept}>
        <Button type="submit" size="lg" className="w-full">
          {t("accept")}
        </Button>
      </form>
    </AuthShell>
  );
}
