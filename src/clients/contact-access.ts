import { randomBytes } from "node:crypto";

import { record } from "@/audit/record";
import { assertInScope } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { withTenant } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { fail } from "@/lib/domain-error";
import { portalInviteUrl } from "@/auth";
import { send } from "@/mailer";
import { releaseContactAssignments } from "@/modules/work";

import { INVITE_TTL_HOURS, INVITE_TTL_MS, hashToken } from "./contact-invite-secret";
import type { ClientCtx } from "./service";

/** The member principal, as every other service in this folder writes it. */
const principalOf = (ctx: ClientCtx) => ({ type: "member", id: ctx.actor.memberId }) as const;

/**
 * THE CLIENT PORTAL'S INVITATION AND THE ACCESS IT GRANTS — Phase 3's
 * invite slice, and the thing every portal slice before it was dark
 * without.
 *
 * **NOTHING IN THE PRODUCT WROTE `Contact.portalStatus` UNTIL THIS
 * FILE.** Every contact on every live tenant sits at the `NO_ACCESS`
 * default, which is why no client has ever held a portal session, why
 * the request intake and the triage lane have never been reachable by a
 * real person, and why slice 6c's hand-over allowlist refused every
 * contact there is. This is the writer.
 *
 * **INVITE-ONLY IS AN INVARIANT, NOT A CONVENTION** (§3, AUTHZ §8), and
 * it is already enforced BELOW this file in two places that do not
 * depend on it being correct: the database trigger
 * `contact_account_requires_invite` refuses a credential for a contact
 * that is neither INVITED nor ACTIVE, and `portalAuth`'s `session.create`
 * hook refuses anything but the literal `ACTIVE`. This file's job is to
 * be the only path that moves a contact INTO those states — not to be
 * the thing that makes them safe.
 *
 * **RAW TOKENS NEVER TOUCH THE DATABASE**: sha256 stored, the link
 * carries the token once (`src/members/invites.ts`'s rule, followed
 * here rather than re-derived).
 *
 * **THE ACCEPTANCE HALF IS NEXT DOOR**, in `contact-invite-token.ts`,
 * and the split is the seam rule's doing rather than filing: a contact
 * presenting a token has no tenant to open `withTenant` for, so that
 * half needs the platform seam and this half must not have it. Keeping
 * them in one file would have put four tenant-plane writers inside a
 * platform-plane exemption they do not need.
 *
 * **TWO WAYS TO TAKE ACCESS AWAY** (founder decision, 2026-09-23): a
 * PAUSE that resumes in one click and keeps the person's history and
 * their work, and a REMOVAL that ends it. They differ in exactly three
 * things and the difference is written into `setContactPortalAccess`:
 * whether the credential survives, whether the tasks come back, and
 * which audit action names it.
 */

/**
 * ISSUE (or re-issue) AN INVITATION. `client:manage_contacts` (C M A),
 * scoped to the contact's own client.
 *
 * **RE-INVITING SUPERSEDES.** Any open invitation is marked REVOKED
 * before the new one is minted, so there is exactly one live token per
 * contact and an old link — which may be sitting in a forwarded email —
 * stops working the moment a new one is sent. That is the behaviour a
 * member expects from "resend" and the safe direction if the first mail
 * went astray.
 *
 * **THE MAIL GOES OUT AFTER THE TRANSACTION COMMITS**, the shape
 * `createInvite` established: a mail sent inside a transaction that then
 * rolls back is a link to an invitation that does not exist.
 */
export async function inviteContact(
  ctx: ClientCtx,
  contactId: string,
): Promise<{ inviteId: string }> {
  const token = randomBytes(32).toString("base64url");
  const { inviteId, email, tenantName, contactName } = await withTenant(
    ctx.tenantId,
    principalOf(ctx),
    async (tx) => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "client:manage_contacts");
      const contact = await tx.contact.findFirst({
        where: { tenantId: ctx.tenantId, id: contactId },
        select: {
          clientId: true,
          name: true,
          email: true,
          portalStatus: true,
          client: { select: { archivedAt: true } },
        },
      });
      if (!contact) deny("NOT_FOUND");
      await assertInScope(tx, ctx.actor, { clientId: contact!.clientId, lifted: true });
      // **AN ALLOWLIST, NEVER A DENYLIST** — the house rule
      // `assignItemToContact` states in as many words, and the first cut
      // of this line broke it by refusing `ACTIVE` alone. A fresh code
      // review traced what the other admitted states do:
      //
      // · `SUSPENDED` → INVITED would undo a PAUSE through a door that
      //   records it as `contact.invited` with no `contact.access_restored`
      //   — and then `RESUME` throws, because the contact is no longer
      //   SUSPENDED. The one-click return the founder's decision is built
      //   around would be gone, and the pre-pause credential is still live
      //   (PAUSE keeps it, and `contact_account_requires_invite` is BEFORE
      //   INSERT only, so nothing revokes it).
      // · `INVITED` → INVITED is the legitimate RESEND, and is admitted.
      //
      // So: only a contact with no access may be invited. A paused one is
      // resumed; an active one needs nothing.
      if (contact!.portalStatus !== "NO_ACCESS" && contact!.portalStatus !== "INVITED") {
        fail("INVALID_INPUT", `cannot invite a contact whose access is ${contact!.portalStatus}`);
      }
      // AN ARCHIVED CLIENT GETS NO NEW CREDENTIALS. `createContact`
      // already refuses to record a person against one, so issuing them
      // portal access must not be the easier act of the two (a fresh
      // security review's note). Existing access is untouched — that is
      // `setContactPortalAccess`'s decision to make, not a side effect
      // of archiving.
      if (contact!.client.archivedAt !== null) fail("INVALID_INPUT", "client is archived");

      // Supersede, then mint — in that order, so a crash between them
      // leaves NO live token rather than two.
      await tx.contactInvite.updateMany({
        where: { tenantId: ctx.tenantId, contactId, status: "PENDING" },
        data: { status: "REVOKED" },
      });
      const invite = await tx.contactInvite
        .create({
          data: {
            tenantId: ctx.tenantId,
            contactId,
            tokenHash: hashToken(token),
            // **THE ADDRESS THE LINK IS BEING SENT TO**, so acceptance
            // can refuse a token whose contact has been renamed to
            // somebody else since (SECURITY.md §3.4's "bound to the
            // invited email"). Recorded here rather than derived at
            // acceptance, because at acceptance the row's address is
            // exactly the thing that may have changed.
            email: contact!.email,
            invitedByMemberId: ctx.actor.memberId,
            expiresAt: new Date(Date.now() + INVITE_TTL_MS),
          },
          select: { id: true },
        })
        .catch((e: unknown) => {
          // **THE PARTIAL UNIQUE IS THE ENFORCEMENT; this is how it
          // reads.** `contact_invite_one_live_idx` forbids a second
          // PENDING row for one contact, so two overlapping re-invites
          // — the ordinary double-submit of a resend button — end with
          // one winner and one P2002 instead of two live tokens. The
          // loser refuses rather than retries: the winner's mail is
          // already on its way, and a retry would mint a THIRD token to
          // supersede the one that just went out.
          if (e && typeof e === "object" && "code" in e && e.code === "P2002") {
            fail("INVALID_INPUT", "an invitation is already being sent");
          }
          throw e;
        });

      // **BOTH STAMPS, AND BOTH ARE LOAD-BEARING.** `portalStatus`
      // INVITED is what the credential trigger admits; `invitedAt` is
      // what `authorizePortal()` requires on the row, so an activation
      // path that forgets it produces a contact who can hold a session
      // and do nothing. `invitedAt` carries the CURRENT invitation's
      // date, which is what a member reading the Contacts tab means by
      // "invited".
      await tx.contact.update({
        where: { tenantId_id: { tenantId: ctx.tenantId, id: contactId } },
        data: {
          portalStatus: "INVITED",
          invitedAt: new Date(),
          invitedById: ctx.actor.memberId,
        },
      });

      await record(tx, {
        action: "contact.invited",
        targetType: "Contact",
        targetId: contactId,
        // Ids and the invitation, never the address: SECURITY.md §7's
        // minimisation, and the email is on the row an operator can read
        // through the ordinary surface anyway.
        metadata: { inviteId: invite.id, clientId: contact!.clientId },
      });

      const tenant = await tx.tenant.findFirstOrThrow({ select: { name: true } });
      return {
        inviteId: invite.id,
        email: contact!.email,
        tenantName: tenant.name,
        contactName: contact!.name,
      };
    },
  );

  await send({
    to: email,
    subject: `${tenantName} has invited you to their client portal`,
    text:
      `Hello ${contactName},\n\n` +
      `${tenantName} has invited you to their client portal, where you can see the work they are doing for you and ask for new work.\n\n` +
      `Set your password and sign in: ${portalInviteUrl(token)}\n\n` +
      `This link expires in ${INVITE_TTL_HOURS} hours. If you were not expecting this, you can ignore it.`,
  });

  return { inviteId };
}

/** Pause, resume, or end a contact's access. */
export type PortalAccessAction = "PAUSE" | "RESUME" | "REMOVE";

/**
 * TAKE ACCESS AWAY, GIVE IT BACK, OR END IT (founder decision,
 * 2026-09-23: the product has both a pause and a removal).
 *
 * The three differ in exactly three things:
 *
 * | | credential | their tasks | audit |
 * |---|---|---|---|
 * | PAUSE | kept | kept | `contact.suspended` |
 * | RESUME | kept | kept | `contact.access_restored` |
 * | REMOVE | deleted | RELEASED | `contact.access_revoked` |
 *
 * **PAUSE KEEPS THE WORK, REMOVE RETURNS IT**, and that follows from
 * what the founder said each verb is for. A pause is "they will be
 * back" — parental leave, a contractor between phases — and it resumes
 * in one click, so taking their tasks away would make the resume a lie.
 * A removal is the end, and an assignment to somebody who can never see
 * the task again is not an assignment (`releaseContactAssignments`,
 * which is also what unblocks erasure).
 *
 * **SESSIONS DIE IMMEDIATELY ON BOTH WAYS OUT.** `portalAuth`'s
 * `session.create` hook already refuses a non-ACTIVE contact, so a live
 * cookie stops working at its next check anyway — but "anyway" is not a
 * guarantee anybody should have to reason about when the act is "cut
 * this person off now". The rows go.
 */
export async function setContactPortalAccess(
  ctx: ClientCtx,
  contactId: string,
  action: PortalAccessAction,
): Promise<{ readonly status: "ACTIVE" | "SUSPENDED" | "REVOKED"; readonly releasedTasks: number }> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "client:manage_contacts");
    const contact = await tx.contact.findFirst({
      where: { tenantId: ctx.tenantId, id: contactId },
      select: { clientId: true, portalStatus: true, email: true },
    });
    if (!contact) deny("NOT_FOUND");
    await assertInScope(tx, ctx.actor, { clientId: contact!.clientId, lifted: true });

    const from = contact!.portalStatus;
    // EVERY LEGAL MOVE IS SPELLED OUT rather than inferred, so a state
    // nobody thought about is a refusal instead of a surprise.
    if (action === "PAUSE" && from !== "ACTIVE") fail("INVALID_INPUT", "only active access can be paused");
    if (action === "RESUME" && from !== "SUSPENDED") fail("INVALID_INPUT", "only paused access can be resumed");
    if (action === "REMOVE" && (from === "NO_ACCESS" || from === "REVOKED")) {
      fail("INVALID_INPUT", "contact has no access to remove");
    }

    const status = action === "PAUSE" ? "SUSPENDED" : action === "RESUME" ? "ACTIVE" : "REVOKED";

    await tx.contact.update({
      where: { tenantId_id: { tenantId: ctx.tenantId, id: contactId } },
      data: { portalStatus: status },
    });
    // Both ways OUT, never on the way back in.
    if (action !== "RESUME") {
      await tx.contactSession.deleteMany({ where: { contactId } });
      // **AND ANY OUTSTANDING PASSWORD-RESET TOKEN**, which the first cut
      // left behind — found by a fresh code review. `sendResetPassword`
      // declines to MAIL a non-ACTIVE contact, but a token already issued
      // is redeemed at `/reset-password`, and that path is not
      // status-gated: it takes the UPDATE branch on the surviving
      // `contact_account` row, which `contact_account_requires_invite`
      // does not see (it is BEFORE INSERT only). The person would then
      // control the credential of an account the agency had deliberately
      // suspended, live the instant anyone pressed Resume.
      //
      // `contact_verification` has no FK to `contact` and is keyed by
      // `identifier` — the address — so that is what identifies the rows.
      await tx.contactVerification.deleteMany({ where: { identifier: contact!.email } });
    }

    let releasedTasks = 0;
    if (action === "REMOVE") {
      // The credential goes with the access. Re-inviting later writes a
      // new one (`acceptContactInvite` upserts), and until then the
      // trigger refuses any attempt to create one.
      await tx.contactAccount.deleteMany({ where: { contactId } });
      // Any invitation still in flight dies with the access, or a
      // forwarded link would let a removed person back in.
      await tx.contactInvite.updateMany({
        where: { tenantId: ctx.tenantId, contactId, status: "PENDING" },
        data: { status: "REVOKED" },
      });
      const { released } = await releaseContactAssignments(
        tx,
        { tenantId: ctx.tenantId, actor: ctx.actor },
        { contactId, clientId: contact!.clientId },
      );
      releasedTasks = released.length;
    }

    await record(tx, {
      action:
        action === "PAUSE"
          ? "contact.suspended"
          : action === "RESUME"
            ? "contact.access_restored"
            : "contact.access_revoked",
      targetType: "Contact",
      targetId: contactId,
      // `releasedTasks` is a COUNT, never the ids or the titles: an
      // operator reading the log needs to know work moved, and which
      // rows moved is the work surfaces' own story (SECURITY.md §7).
      metadata: { clientId: contact!.clientId, from, to: status, releasedTasks },
    });

    return { status, releasedTasks };
  });
}
