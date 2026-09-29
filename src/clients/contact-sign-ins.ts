import { assertInScope } from "@/authz/authorize";
import { withTenant } from "@/db";
import { hasAccess } from "@/entitlements/resolver";

import type { ClientCtx } from "./service";
import { signInState, signInWindowStart, type SignInState } from "./sign-in-window";

/**
 * WHEN EACH OF A CLIENT'S CONTACTS LAST SIGNED IN TO THE PORTAL — the
 * Contacts tab's "Last signed in …" line under each address (PLAN
 * Phase 3's Portal-tab line, slice 77).
 *
 * **WHO MAY READ IT IS A FOUNDER DECISION** (OPEN_QUESTIONS C46,
 * 2026-09-29): the people who can invite, pause and remove this client's
 * portal access — `client:manage_contacts` on all four gates, the same
 * `requireAccess` the verbs in `contact-access.ts` pass — and nobody
 * else. It is a fact about a client's employee that serves those verbs
 * (chase an invite, pause someone who never comes), so an employee who
 * only works on the client's projects sees the contact list without it.
 * `getClient`'s `caps.manageContacts` is NOT that gate: it is the bare
 * permission, blind to the portal module being switched off.
 *
 * **THE SOURCE IS THE AUDIT TRAIL, NOT THE SESSION TABLE.** Every
 * successful portal sign-in writes `auth.login_succeeded` with
 * `actorType = CONTACT` and `actorId = <contactId>` (`src/auth/portal-
 * audit.ts`), and `audit_event`'s `(actor_type, actor_id, created_at
 * DESC)` index answers "newest per contact" directly. `contact_session`
 * forgets: sign-out and expiry delete its rows. A member's View-as never
 * passes the portal's Better Auth instance, so it writes no such row and
 * cannot fake a sign-in; a failed sign-in is `auth.login_failed` with a
 * SYSTEM actor and is not counted either.
 *
 * **THE ANSWER COVERS A WINDOW** — twelve months, SECURITY.md §7's
 * retention for auth events — for the reason `sign-in-window.ts` gives.
 */

/**
 * contactId → what the Contacts tab says about their sign-ins, for every
 * contact of the client. `null` when the actor may not see sign-ins
 * (C46) — the page then draws no line at all, rather than an empty one.
 *
 * It returns the STATE, not the inputs: `activatedAt` (when they first
 * accepted) is itself a portal-usage fact, so it is read here, behind the
 * gate, and never added to the `ContactRow` every `client:view` holder
 * receives.
 */
export async function readContactSignIns(
  ctx: ClientCtx,
  clientId: string,
  now: Date = new Date(),
): Promise<ReadonlyMap<string, SignInState> | null> {
  return withTenant(ctx.tenantId, { type: "member", id: ctx.actor.memberId }, async (tx) => {
    if (!(await hasAccess(tx, ctx.tenantId, ctx.actor, "client:manage_contacts"))) return null;
    // The verbs' own scope: the client, lifted from a project assignment.
    await assertInScope(tx, ctx.actor, { clientId, lifted: true });

    const since = signInWindowStart(now);
    // In sequence, never a `Promise.all` leg on this one connection
    // (AGENTS.md): the contacts first, then one grouped read for all of them.
    const contacts = await tx.contact.findMany({
      where: { tenantId: ctx.tenantId, clientId },
      select: { id: true, createdAt: true, activatedAt: true, portalStatus: true },
    });
    if (contacts.length === 0) return new Map();

    const rows = await tx.auditEvent.groupBy({
      by: ["actorId"],
      where: {
        tenantId: ctx.tenantId,
        // `actor_type` leads the index; a MEMBER's own sign-in carries a
        // member id and could never match a contact id anyway.
        actorType: "CONTACT",
        action: "auth.login_succeeded",
        actorId: { in: contacts.map((c) => c.id) },
        createdAt: { gte: since },
      },
      _max: { createdAt: true },
    });
    const last = new Map<string, Date>();
    for (const r of rows) {
      if (r.actorId !== null && r._max.createdAt !== null) last.set(r.actorId, r._max.createdAt);
    }
    return new Map(contacts.map((c) => [c.id, signInState(c, last.get(c.id), since)]));
  });
}
