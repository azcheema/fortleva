import { requireMemberSession } from "@/auth/session";

import { ChangePasswordForm } from "./change-password-form";
import { TotpEnrollment } from "./totp-enrollment";

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>;
}) {
  const session = await requireMemberSession();
  const twoFactorEnabled =
    (session.user as { twoFactorEnabled?: boolean }).twoFactorEnabled ?? false;
  const notice = (await searchParams).notice;

  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold">Account security</h1>
      <p className="mt-1 text-sm text-neutral-600">{session.user.email}</p>
      {notice === "mfa_required" && !twoFactorEnabled ? (
        <p className="mt-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm">
          The action you tried requires two-factor authentication. Enrol below, then
          try again.
        </p>
      ) : null}

      <section className="mt-8 max-w-md">
        <h2 className="text-lg font-medium">Change password</h2>
        <ChangePasswordForm />
      </section>

      <section className="mt-10 max-w-md">
        <h2 className="text-lg font-medium">Two-factor authentication</h2>
        <p className="mt-1 text-sm text-neutral-600">
          {twoFactorEnabled
            ? "Enabled. Codes from your authenticator app are required at sign-in."
            : "Not enrolled. Your role holds sensitive permissions — TOTP is mandatory before they can be used."}
        </p>
        <TotpEnrollment enabled={twoFactorEnabled} />
      </section>
    </main>
  );
}
