import { record } from "@/audit/record";
import { withTenant } from "@/db";

import type { AuthAuditSink } from "./audit-hooks";

/**
 * THE PORTAL PLANE'S AUTH AUDIT SINK — the obligation AUTHZ §8 gated on
 * this slice, and the one it named in as many words:
 *
 * > the portal instance carries none, so `auth.login_succeeded` /
 * > `auth.login_failed` do not fire for a contact. **That is safe only
 * > because no contact can sign in today, and it must land with — or
 * > before — the first path that can activate one.**
 *
 * The invite flow is that path, so this lands with it (founder decision,
 * 2026-09-23, after two independent reviews raised it). Without it a
 * client's portal password could be phished, used, and brute-forced, and
 * the tenant's own log would show none of it.
 *
 * **IT NEEDS NO DATABASE LOOKUP AND THEREFORE NO SEAM EXEMPTION**, which
 * is the thing that makes it small. The member sink fans a user out to
 * every ACTIVE membership, because one `User` may belong to many
 * tenants; a `Contact` belongs to exactly ONE client of ONE tenant, and
 * `CONTACT_ADDITIONAL_FIELDS` already carries `tenantId` on the portal
 * instance's user object. So the tenant arrives with the event and this
 * file stays on `withTenant` like ordinary tenant-plane code.
 *
 * **THE ACTOR IS THE CONTACT ON SUCCESS AND THE SYSTEM ON FAILURE**, the
 * same distinction the member sink draws and for the same reason: a
 * failed sign-in is nobody authenticating, so attributing it to the
 * person whose address was typed would be asserting they did it.
 * `brokeredForContactId` is what makes the success row say CONTACT —
 * `record()` derives the actor from the transaction's principal, and a
 * portal write's principal is `system` (slice 6a's finding).
 *
 * **NOTHING HERE NAMES AN ADDRESS.** The target is the contact's id; the
 * metadata carries a method and a reason code. SECURITY.md §7's
 * minimisation applies to this table above all others, and an audit log
 * that records which email addresses were tried is a list worth stealing.
 */

/** A contact's own row, under the system principal, attributed to them. */
const recordForContact = async (
  user: Readonly<Record<string, unknown>> | undefined,
  contactId: string,
  action: "auth.login_succeeded" | "auth.login_failed" | "auth.password_changed",
  opts: { metadata?: Record<string, string>; asContact: boolean },
): Promise<void> => {
  const tenantId = user?.["tenantId"];
  // **NO TENANT, NO ROW — and silence is the right failure here.** The
  // id comes from Better Auth's own adapter, so this can only be a shape
  // change in a future version; writing to a guessed tenant would be
  // worse than writing nothing, and the whole sink is already wrapped by
  // `guarded()` so an auth flow never breaks on an audit problem.
  if (typeof tenantId !== "string" || tenantId === "") return;
  await withTenant(tenantId, { type: "system" }, (tx) =>
    record(tx, {
      action,
      targetType: "Contact",
      targetId: contactId,
      ...(opts.asContact ? { brokeredForContactId: contactId } : {}),
      metadata: opts.metadata,
    }),
  );
};

export const portalAuditSink: AuthAuditSink = {
  loginSucceeded: (contactId, method, user) =>
    recordForContact(user, contactId, "auth.login_succeeded", {
      metadata: { method },
      asContact: true,
    }),

  loginFailed: (contactId, reason, user) =>
    recordForContact(user, contactId, "auth.login_failed", {
      metadata: { reason },
      // NOBODY AUTHENTICATED: the actor is the system, and the contact is
      // the TARGET. The member sink draws the same line.
      asContact: false,
    }),

  passwordChanged: (contactId, via, user) =>
    recordForContact(user, contactId, "auth.password_changed", {
      metadata: { via },
      asContact: true,
    }),

  // **THE THREE BELOW CANNOT FIRE ON THIS PLANE, and they are no-ops
  // rather than throws.** Contact MFA is v2 (`DATA_MODEL.md` P5,
  // `SECURITY.md` §3.5) and no `ContactTwoFactor` model exists, so the
  // portal instance registers no `twoFactor()` plugin and neither MFA
  // hook has an endpoint to match. `emailChanged` is the member plane's:
  // a contact's address is changed by a MEMBER through `updateContact`,
  // which audits `contact.updated` in the tenant's own log.
  //
  // They are present because `AuthAuditSink` is one interface for both
  // planes — and a no-op that says why is better than an interface split
  // that would let a future hook silently find no implementation.
  mfaVerificationFailed: async () => undefined,
  mfaChanged: async () => undefined,
  emailChanged: async () => undefined,
};
