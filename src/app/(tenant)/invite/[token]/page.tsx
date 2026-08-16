import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { getMemberSession } from "@/auth/session";
import { AuthzError } from "@/authz/errors";
import { Button } from "@/components/ui/button";
import { acceptInvite, previewInvite } from "@/members/invites";

/**
 * Invitation acceptance. The link carries the raw token exactly once;
 * the page previews the invite, and a signed-in user whose email
 * matches accepts it. Not signed in → sign up first, come back.
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
    return (
      <Shell>
        <h1 className="text-xl font-semibold">{t("unavailableTitle")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("unavailable")}</p>
      </Shell>
    );
  }

  const session = await getMemberSession();
  if (!session) {
    return (
      <Shell>
        <h1 className="text-xl font-semibold">{t("joinTitle", { tenant: preview.tenantName })}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t.rich("signInFirst", {
            email: preview.email,
            strong: (chunks) => <strong className="text-foreground">{chunks}</strong>,
          })}
        </p>
        <Button asChild className="mt-4 self-start">
          <Link href={`/signup?next=/invite/${token}`}>{t("createOrSignIn")}</Link>
        </Button>
      </Shell>
    );
  }

  async function accept() {
    "use server";
    const current = await getMemberSession();
    if (!current) redirect(`/login?next=/invite/${token}`);
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
    <Shell>
      <h1 className="text-xl font-semibold">{t("joinTitle", { tenant: preview.tenantName })}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {t("signedInAs", { email: session.user.email })}
        {mismatch ? ` ${t("mismatch", { email: preview.email })}` : null}
      </p>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {t("failed")}
        </p>
      ) : null}
      <form action={accept}>
        <Button type="submit" className="mt-4">
          {t("accept")}
        </Button>
      </form>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-6">
      {children}
    </main>
  );
}
