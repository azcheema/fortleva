import { requirePlatformAdmin } from "@/auth/session";

export default async function OpsHome() {
  const session = await requirePlatformAdmin();

  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold">Fortleva Ops</h1>
      <p className="mt-2 text-sm text-neutral-600">
        Signed in as {session.user.email} (SUPERADMIN). Console UI lands in
        Phase 7 — the machinery (impersonation, entitlement overrides,
        audit) exists behind withPlatform().
      </p>
    </main>
  );
}
