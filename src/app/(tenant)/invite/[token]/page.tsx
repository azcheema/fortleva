import Link from "next/link";
import { redirect } from "next/navigation";

import { getMemberSession } from "@/auth/session";
import { acceptInvite, previewInvite } from "@/members/invites";
import { AuthzError } from "@/authz/errors";

/**
 * Invitation acceptance. The link carries the raw token exactly once;
 * the page previews the invite, and a signed-in user whose email
 * matches accepts it. Not signed in → sign up first, come back.
 */
export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const preview = await previewInvite(token);

  if (!preview || preview.status !== "PENDING" || preview.expired) {
    return (
      <Shell>
        <h1 className="text-xl font-semibold">Invitation not available</h1>
        <p className="mt-2 text-sm text-neutral-600">
          This invitation link is invalid, expired, or already used. Ask your
          admin to send a new one.
        </p>
      </Shell>
    );
  }

  const session = await getMemberSession();
  if (!session) {
    return (
      <Shell>
        <h1 className="text-xl font-semibold">
          Join {preview.tenantName} on Fortleva
        </h1>
        <p className="mt-2 text-sm text-neutral-600">
          This invitation is for <strong>{preview.email}</strong>. Sign in with
          that address (or create your account) and open this link again.
        </p>
        <Link
          href={`/signup?next=/invite/${token}`}
          className="mt-4 inline-block rounded bg-neutral-900 px-4 py-2 text-white"
        >
          Create account / sign in
        </Link>
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
    redirect("/dashboard");
  }

  return (
    <Shell>
      <h1 className="text-xl font-semibold">
        Join {preview.tenantName} on Fortleva
      </h1>
      <p className="mt-2 text-sm text-neutral-600">
        Signed in as {session.user.email}.
        {session.user.email !== preview.email
          ? ` This invitation was issued to ${preview.email} — accepting will fail unless the addresses match.`
          : ""}
      </p>
      <form action={accept}>
        <button
          type="submit"
          className="mt-4 rounded bg-neutral-900 px-4 py-2 text-white"
        >
          Accept invitation
        </button>
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
