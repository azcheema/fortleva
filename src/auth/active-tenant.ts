/* eslint-disable no-restricted-imports -- sanctioned auth-layer consumer
   of the raw client (TENANCY.md §6.3): Session is an AUTH-class row, the
   same reason ./step-up.ts writes Session.mfaVerifiedAt through it. */
import { runtimeClient } from "@/db/client";
import { listMembershipsForUser } from "@/members/service";

/**
 * Switch which workspace a session is looking at (UI.md rule 8).
 *
 * `Session.activeTenantId` is a UX POINTER ONLY — authorization is never
 * derived from it (DATA_MODEL §6.1; the schema says so at the column).
 * `getActiveMembership` re-derives membership from the database on every
 * request and ignores a pointer that does not name an ACTIVE membership,
 * so a stale or stolen pointer grants nothing. What it decides is which
 * of the memberships the caller ALREADY HOLDS the UI opens in.
 *
 * Until 2026-09-18 nothing in the product ever wrote it: the field was
 * declared `input: false` and read in one place, and every row of the
 * workspace picker linked to a bare `/home`, so a member of two active
 * tenants always fell back to `active[0]` — the earliest `joinedAt` —
 * and the picker could not pick. This is the writer.
 *
 * **The membership check lives HERE, not at the call site**, so the
 * pointer cannot be written for a tenant the user is not an ACTIVE
 * member of even by a future caller that forgets. `listMembershipsForUser`
 * runs under `withUser`, whose `member_self_select` policy scopes the
 * read to the caller's OWN rows in the database — so the id arriving
 * from a form is never trusted, only matched against what RLS returns.
 *
 * No audit event, deliberately, and this is the same call `./step-up.ts`
 * makes for `mfaVerifiedAt`: an auth-plane write to the caller's own
 * session row is not a tenant mutation, it grants no access, and the
 * member could reach the identical state by signing in again — which
 * `auth.login_succeeded` already records.
 */
export type SwitchActiveTenantResult = "ok" | "not_active_member";

export async function switchActiveTenant(input: {
  sessionId: string;
  userId: string;
  tenantId: string;
}): Promise<SwitchActiveTenantResult> {
  const memberships = await listMembershipsForUser(input.userId);
  const target = memberships.find((m) => m.tenantId === input.tenantId);
  // SUSPENDED is a denial, not a miss: `getActiveMembership` filters to
  // ACTIVE before it reads the pointer, so writing one for a suspended
  // membership would be a silent no-op the member could not explain.
  if (!target || target.status !== "ACTIVE") return "not_active_member";

  // `userId` in the WHERE, though the only caller reads both off one
  // session: the doc above claims the check lives here so a future
  // caller cannot get it wrong, and a session id alone would let one
  // move SOMEBODY ELSE'S pointer. Extra non-unique filters are allowed
  // on `update`; a miss raises P2025, which IS this denial.
  //
  // Only P2025. A bare `catch` here would report a pool timeout or a
  // dropped connection as "that workspace is no longer available to
  // you" — a claim the code has not established, told to a member who
  // is still an ACTIVE member of it, with the real error swallowed and
  // logged nowhere. A 500 must read as a 500.
  try {
    await runtimeClient.session.update({
      where: { id: input.sessionId, userId: input.userId },
      data: { activeTenantId: input.tenantId },
    });
  } catch (e) {
    // Duck-typed on the code, like `isUniqueViolation` in
    // `@/lib/domain-error` — the one-seam rule means no runtime import
    // of the generated client just to name an error class.
    if (typeof e === "object" && e !== null && (e as { code?: unknown }).code === "P2025") {
      return "not_active_member";
    }
    throw e;
  }
  return "ok";
}
