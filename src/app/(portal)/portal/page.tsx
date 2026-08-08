/**
 * Portal plane — LOCKED SHELL until Phase 3 (PLAN.md). The route group,
 * cookie namespace (__Host-flv.portal) and proxy gating exist from
 * day 1 so the plane separation is structural, not retrofitted.
 */
export default function PortalShell() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-6 text-center">
      <h1 className="text-xl font-semibold">Client portal</h1>
      <p className="mt-2 text-sm text-neutral-600">
        The portal is not open yet. Your agency will send you an invitation
        when it is.
      </p>
    </main>
  );
}
