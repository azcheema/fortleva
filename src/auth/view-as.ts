/* eslint-disable no-restricted-imports -- sanctioned auth-layer consumer
   of the raw client (TENANCY.md §6.3): Session is an AUTH-class row, the
   same reason ./active-tenant.ts writes Session.activeTenantId and
   ./step-up.ts writes Session.mfaVerifiedAt through it. */
import { runtimeClient } from "@/db/client";

/**
 * The View-as-Contact MODE POINTER (Phase 3 slice 5).
 *
 * `Session.viewAsContactId` names the Contact whose portal view this
 * session is currently inside, or NULL. It is a UX pointer of exactly
 * the same standing as `activeTenantId` beside it, and the schema says
 * so at the column: **authorization is never derived from it.**
 * `/view-as` re-runs `project:manage_portal`, the client-scope check
 * and the contact's own admission on EVERY render, so a stale pointer —
 * a contact suspended since the member entered, a member whose role was
 * narrowed, a plan that lost the module — renders nothing. What the
 * pointer decides is not what may be seen but THAT THE MEMBER ASKED.
 *
 * WHICH IS THE WHOLE REASON IT IS A DATABASE COLUMN AND NOT A COOKIE.
 * SECURITY.md §5.1 lists `project.viewed_as_contact` as an audited act,
 * and an audited act needs a trail that cannot be walked around. The
 * only writer of this column is the server action that records that
 * row, so being inside View-as and having no audit row is not a state
 * the product can reach. A cookie is client-held: a member who set one
 * by hand would be inside the mode with no trail. (They would still see
 * nothing they could not already see — the per-render gates hold — but
 * "the control was not bypassable" and "the log is complete" are two
 * different claims and this file is about the second.)
 *
 * AND IT IS WHY ENTRY IS A POST. Next PREFETCHES `<Link>`s in
 * production, so a GET that entered View-as would fire on hover and
 * write a row for a member who never clicked — the same reason the
 * workspace picker is a form (`dashboard/actions.ts`).
 *
 * No audit event for the WRITE itself, deliberately, and for the reason
 * `./active-tenant.ts` gives: an auth-plane write to the caller's own
 * session row is not a tenant mutation and grants no access. The act is
 * audited by its caller, inside the tenant transaction where
 * `audit.record` can stamp a MEMBER actor (`src/audit/record.ts` derives
 * `actorType` from the ambient principal, never from its input).
 */

/**
 * Point this session at a contact. The caller has ALREADY authorised the
 * member and recorded the audit row; this is the last step, and it is
 * deliberately incapable of doing any checking of its own.
 *
 * THAT IS A DEPARTURE FROM `switchActiveTenant`, WHICH VALIDATES INSIDE
 * ITSELF, so the difference is worth stating rather than letting a
 * reviewer find it. There the check is cheap, self-contained and
 * expressible in the auth layer — "is this an ACTIVE membership of this
 * user" — so putting it in the writer means no future caller can forget
 * it. Here the check is `requireAccess` + `assertInScope` + the
 * contact's portal admission, all of which need a TENANT transaction;
 * running them from `src/auth` would either import the entitlements
 * resolver into the auth layer or duplicate it. So the rule is enforced
 * one level up instead, by there being exactly one caller
 * (`src/clients/view-as.ts`) and by `/view-as` re-deriving every gate on
 * every render regardless of what this wrote.
 *
 * `userId` in the WHERE though the only caller reads both off one
 * session: a session id alone would let a future caller move SOMEBODY
 * ELSE'S pointer. Extra non-unique filters are allowed on `update`.
 */
export async function setViewAsContact(input: {
  sessionId: string;
  userId: string;
  contactId: string;
}): Promise<void> {
  await runtimeClient.session.update({
    where: { id: input.sessionId, userId: input.userId },
    data: { viewAsContactId: input.contactId },
  });
}

/**
 * Leave the mode. `updateMany`, not `update`, and the difference
 * matters: leaving must never fail. A session that has already expired,
 * been revoked from another device, or been cleared by a second tab
 * raises P2025 on `update` — and a member clicking "Exit" would meet a
 * 500 on the control whose entire job is to get them OUT of a client's
 * view. `updateMany` matching zero rows is the correct reading of "this
 * session is no longer in View-as", which is exactly what the member
 * asked for.
 */
export async function clearViewAsContact(input: {
  sessionId: string;
  userId: string;
}): Promise<void> {
  await runtimeClient.session.updateMany({
    where: { id: input.sessionId, userId: input.userId },
    data: { viewAsContactId: null },
  });
}
