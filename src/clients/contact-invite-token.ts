import { portalAuth } from "@/auth/portal";
import { withPlatform } from "@/db";
import { fail } from "@/lib/domain-error";

import { hashToken } from "./contact-invite-secret";

/**
 * THE TWO HALVES OF A PORTAL INVITATION THAT HAVE NO TENANT YET — and
 * this file exists to be the ONLY thing in the contact-invite feature
 * that is allowed to say `withPlatform`.
 *
 * **WHY IT IS A FILE OF ITS OWN.** `withPlatform` is platform-plane only
 * (ARC-16, enforced by ESLint and pinned again by
 * `src/db/import-boundary.test.ts`), with a short grandfathered list
 * whose stated reason is exactly this shape: *"invitation acceptance and
 * tenant provisioning are cross-tenant by construction (a user without a
 * membership yet)"*. A contact presenting a token has no session, no
 * tenant and no client — there is no tenant to open `withTenant` for,
 * because the token is what resolves it.
 *
 * So this file joins that list, and the rest of the feature does NOT.
 * `contact-access.ts` holds the member-driven half — issuing an
 * invitation, pausing, resuming, removing — and stays fully subject to
 * the seam rule, under `withTenant` with a real member principal. The
 * alternative was one file holding both, which would have put four
 * tenant-plane writers inside a platform-plane exemption they do not
 * need. **A narrower exemption is worth an extra file.**
 *
 * NOTHING HERE AUTHORIZES, because there is nobody to authorize. The
 * token IS the credential: 32 random bytes, sha256-hashed before it
 * touches the database, single-use, superseded on re-invite and expired
 * after seven days. Every refusal below is the same refusal, for the
 * reason `acceptContactInvite` states.
 */

/** What the acceptance page may say before anybody has authenticated. */
export type ContactInvitePreview = {
  /** The agency's name — the one thing that makes the page trustworthy. */
  readonly tenantName: string;
  readonly contactName: string;
  readonly email: string;
  readonly status: "PENDING" | "ACCEPTED" | "EXPIRED" | "REVOKED";
  readonly expired: boolean;
};

/**
 * Token → what the acceptance page may show. Read-only, and it answers
 * `null` for an unknown token without ever distinguishing "no such
 * token" from "a token of another tenant": on this plane a difference is
 * a fact about the agency.
 */
export async function previewContactInvite(token: string): Promise<ContactInvitePreview | null> {
  if (!token) return null;
  return withPlatform(
    { type: "system", job: "contact-invite-preview" },
    "resolve a portal invitation token for the acceptance page",
    async (tx) => {
      const invite = await tx.contactInvite.findUnique({
        where: { tokenHash: hashToken(token) },
        select: {
          status: true,
          expiresAt: true,
          // The BOUND address, so this read applies the same rule the
          // acceptance does — see below.
          email: true,
          tenant: { select: { name: true } },
          contact: { select: { name: true, email: true } },
        },
      });
      if (!invite) return null;
      // **THE EMAIL BINDING IS CHECKED HERE TOO, and leaving it out was
      // wrong in both directions.** `acceptContactInvite` refuses an
      // invitation whose bound address no longer matches the contact's
      // (SECURITY.md §3.4: `updateContact` may change the address while a
      // link is in flight). This read did not, which meant the
      // acceptance page would draw the whole password form for a token
      // the action was always going to reject — and, worse, would draw
      // the contact's CURRENT name and address, so whoever still held the
      // link mailed to the OLD address learned the new one. A preview
      // that shows more than the acceptance will accept is a disclosure.
      //
      // `null`, not a distinct answer: on this plane every dead token
      // looks the same (founder decision, 2026-09-23). NULL `email`
      // means a row written before `20260923030000` and is treated as
      // unbound, exactly as the acceptance treats it.
      //
      // Found by this slice's security review.
      if (invite.email !== null && invite.email !== invite.contact.email) return null;
      return {
        tenantName: invite.tenant.name,
        contactName: invite.contact.name,
        email: invite.contact.email,
        status: invite.status,
        expired: invite.expiresAt.getTime() < Date.now(),
      };
    },
  );
}

/**
 * ACCEPTANCE: the contact sets a password and becomes ACTIVE.
 *
 * **THE CREDENTIAL IS WRITTEN DIRECTLY, never through a signup
 * endpoint**, because the portal instance has none and must never get
 * one (§3: invite-only forever, no contact self-signup).
 *
 * `contact_account_requires_invite` admits INVITED **or** ACTIVE, and by
 * the time the insert runs this function has already flipped the row to
 * ACTIVE — so the trigger sees ACTIVE, not INVITED. Both are admitted
 * and the order is deliberate (consume, flip, then write), but the
 * trigger is **BEFORE INSERT only**: the upsert's UPDATE path, reachable
 * whenever a row already exists, is not covered by it. What keeps that
 * safe is `accountId = contactId` at every writer in the repo against
 * the `(providerId, accountId)` unique, not the trigger. Both
 * corrections are a fresh security review's.
 *
 * ORDER IS DELIBERATE: consume the invitation, flip the status, THEN
 * write the credential. A crash anywhere leaves a contact who cannot
 * sign in rather than one who can sign in against a token that is still
 * live.
 *
 * **ONE REFUSAL FOR EVERY BAD TOKEN.** A contact told "expired" versus
 * "already used" versus "no such invitation" learns something about rows
 * they cannot see, and can do nothing differently with the distinction —
 * the page tells them to ask their agency for a new link either way. The
 * `detail` string is for the server log and never crosses the boundary.
 */
export async function acceptContactInvite(input: {
  token: string;
  password: string;
}): Promise<{ tenantId: string; contactId: string }> {
  if (!input.token) fail("INVALID_INPUT", "no token");
  const authCtx = await portalAuth.$context;
  // **THE PASSWORD POLICY IS APPLIED HERE OR NOWHERE.** Better Auth puts
  // `minPasswordLength`/`maxPasswordLength` in `password.config`, BESIDE
  // `password.hash`, and only its own route handlers consult them — so
  // `hash("")` returns a perfectly valid digest. This function writes
  // `contact_account` directly, which is correct and deliberate (the
  // portal has no signup endpoint and must never get one), and that is
  // exactly what steps around the only place the policy was enforced.
  //
  // It is not one path among several: `disableSignUp` is true,
  // `sendResetPassword` declines a non-ACTIVE contact, and
  // `contact_account_requires_invite` refuses everything else. **This is
  // the sole path that ever sets a portal password for the first time**,
  // and a one-character password behind it opens the whole CLIENT
  // company's shared list, because `portal_gate` is client-scoped.
  // Found by a fresh security review.
  //
  // Read from the instance's own config rather than a literal, so the
  // service cannot drift from the plane it guards. The maximum matters
  // too: without it an unauthenticated caller hands scrypt a megabyte.
  const { minPasswordLength, maxPasswordLength } = authCtx.password.config;
  if (input.password.length < minPasswordLength || input.password.length > maxPasswordLength) {
    fail("INVALID_INPUT", "password length");
  }
  // Hashed OUTSIDE the transaction: scrypt is deliberately slow (better
  // auth's default, and what `ContactAccount.password`'s own schema
  // comment names), and holding a transaction open across it would hold
  // its locks too.
  const passwordHash = await authCtx.password.hash(input.password);

  return withPlatform(
    { type: "system", job: "contact-invite-acceptance" },
    "accept a client portal invitation",
    async (tx) => {
      const invite = await tx.contactInvite.findUnique({
        where: { tokenHash: hashToken(input.token) },
        select: {
          id: true,
          tenantId: true,
          contactId: true,
          status: true,
          expiresAt: true,
          email: true,
          contact: { select: { email: true } },
        },
      });
      if (!invite) fail("INVALID_INPUT", "no such invitation");
      if (invite!.status !== "PENDING") fail("INVALID_INPUT", `invitation is ${invite!.status}`);
      // **NO "MARK IT EXPIRED" WRITE HERE, and its absence is the
      // point.** The obvious shape — stamp `status: EXPIRED`, then
      // refuse — cannot work: the refusal THROWS, the transaction rolls
      // back, and the stamp goes with it. A write that can only ever be
      // undone is dead code that reads like a fix, which is worse than
      // no write at all. (`src/members/invites.ts` has the same shape
      // for member invitations; its stamp does not persist either.)
      //
      // `expires_at` is the authority and always was. Every reader
      // derives expiry from it — `previewContactInvite` returns
      // `expired` computed that way — so the column never needs to be
      // corrected for a surface to tell the truth. The `status` column
      // records the decisions somebody MADE: accepted, or superseded by
      // a re-invite.
      if (invite!.expiresAt.getTime() < Date.now()) fail("INVALID_INPUT", "invitation expired");

      // **BOUND TO THE ADDRESS IT WAS SENT TO** (SECURITY.md §3.4). The
      // invitation names a row, and `updateContact` may change that
      // row's email while the link is in flight — so without this the
      // mail sent to one address would activate a contact who is now
      // somebody else, and the stamp below would assert an address
      // nobody proved control of. NULL means a row written before
      // `20260923030000`, which is treated as unbound rather than
      // refused: there is nothing to compare, and refusing would strand
      // invitations that were legitimately issued.
      if (invite!.email !== null && invite!.email !== invite!.contact.email) {
        fail("INVALID_INPUT", "invitation was issued to a different address");
      }

      // **A GUARDED CONSUME, not a blind update.** The status was read
      // by `findUnique` above; two requests bearing the same token both
      // see PENDING, and an `update` keyed on the primary key lets the
      // second proceed after the first releases the row lock — both run
      // to completion and the LAST one's password wins. Keying the write
      // on the status makes the consume itself the exclusion, and zero
      // rows is the same single refusal every other bad token gets.
      const consumed = await tx.contactInvite.updateMany({
        where: { id: invite!.id, status: "PENDING" },
        data: { status: "ACCEPTED", acceptedAt: new Date() },
      });
      if (consumed.count !== 1) fail("INVALID_INPUT", "invitation already consumed");
      await tx.contact.update({
        where: { tenantId_id: { tenantId: invite!.tenantId, id: invite!.contactId } },
        data: {
          portalStatus: "ACTIVE",
          activatedAt: new Date(),
          // Proven by the fact that they opened a link only that mailbox
          // received.
          emailVerified: true,
        },
      });
      // UPSERT, not create: a contact who was removed and invited again
      // may still carry a row from a previous acceptance. The unique is
      // `(providerId, accountId)` — `contactId` alone is only an index —
      // and `accountId` is the contact's own id, the shape the harness
      // and `portal.dbtest.ts` already write.
      await tx.contactAccount.upsert({
        where: {
          providerId_accountId: { providerId: "credential", accountId: invite!.contactId },
        },
        create: {
          contactId: invite!.contactId,
          accountId: invite!.contactId,
          providerId: "credential",
          password: passwordHash,
        },
        update: { password: passwordHash },
      });

      // Written directly rather than through `record()`, which derives
      // its actor from the transaction's principal — and this one is
      // `system`. The CONTACT acted: they opened the link and chose the
      // password, and this is one of the few events in the product whose
      // actor is not an employee.
      await tx.auditEvent.create({
        data: {
          tenantId: invite!.tenantId,
          actorType: "CONTACT",
          actorId: invite!.contactId,
          action: "contact.activated",
          targetType: "Contact",
          targetId: invite!.contactId,
          metadata: { inviteId: invite!.id },
          visibility: "TENANT",
        },
      });

      return { tenantId: invite!.tenantId, contactId: invite!.contactId };
    },
    // **A WRITE, SO IT MUST SAY SO.** `withPlatform` is read-only by
    // default and a write additionally puts its own audited row — with
    // the mandatory reason above — in the SAME transaction as the
    // mutation (TENANCY.md §12).
    //
    // NO `targetTenantId` IS PASSED, and it cannot be: the option is
    // read before the callback runs, and it is the TOKEN that resolves
    // the tenant. So that row lands with `tenant_id = NULL` and
    // `visibility = PLATFORM` — the platform's own trail of a
    // cross-tenant entry point. What puts the event in the AGENCY's log
    // is the hand-written `contact.activated` row below, which is the
    // one a tenant reads. `acceptInvite` has the same shape for the same
    // reason. (An earlier version of this comment claimed the tenant was
    // named on the platform row; a fresh security review caught it.)
    { readOnly: false },
  );
}
