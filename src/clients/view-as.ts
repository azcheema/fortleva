import { record } from "@/audit/record";
import { assertInScope, type MemberActor } from "@/authz/authorize";
import { AuthzError, deny } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import type { ContactPortalProfile } from "@/generated/prisma/enums";
import { fail } from "@/lib/domain-error";

/**
 * VIEW-AS-CONTACT — the member plane's half (Phase 3 memo slice 5).
 *
 * A member enters a client's portal and NAVIGATES it as one named
 * contact. The pins give this four obligations (SECURITY.md §5.1 and
 * the vector table): the same projection functions as a real contact
 * request, a red banner, `project.viewed_as_contact` audited, and
 * output byte-compared to a real contact session in CI. This file owns
 * the first and the third; `src/app/(tenant)/view-as/` owns the second,
 * and the fourth is `view-as.dbtest.ts` plus `e2e/view-as.spec.ts`.
 *
 * IT SPANS THE CLIENT, NOT A PROJECT, and that is the decision the
 * whole slice turns on. UI.md §11 fixes the banner's promise — "you see
 * exactly what they see" — and what a contact sees is their PORTAL: every
 * shared task of every portal-enabled project their client has. A
 * project-narrowed view-as would be the slice-4 preview a second time,
 * and it could never be byte-identical to anything, because no contact
 * request ever produces one. The comparison IS the guard the founder's
 * session-model decision rests on (PLAN §0, 2026-09-20 decision 1), so
 * the thing compared has to be the thing a contact actually gets.
 *
 * WHICH MOVES THE WHOLE WEIGHT ONTO THE SCOPE CHECK, because
 * `project:manage_portal` is a SCOPED permission and a member can be
 * scoped to one project of a client. `listPortalTasks` says so at the
 * option that narrows it: an unnarrowed call materialises the names and
 * titles of that client's OTHER projects. So entry is gated on
 * `assertInScope(tx, actor, { clientId })` **with `lifted` left off** —
 * the arm that accepts a DIRECT client assignment or `client:view_all`
 * and refuses the project→client lift. A member who reaches only
 * project P of Acme cannot enter Acme's view at all. That is not a
 * stricter gate for its own sake: it is the exact predicate "this member
 * already reaches everything this mode will show".
 *
 * NOTHING HERE READS A ROW OF THE CLIENT'S WORK. Two tables are
 * touched and both are authorization: the CONTACT row, to decide who
 * may be looked through and to name the principal, and the PROJECT row
 * the entry came from, to refuse an audit row pairing one client's
 * project with another client's contact. Every task on the screen comes
 * back from `listPortalTasks` under the CONTACT principal, run by the
 * page. `src/authz/portal-view-as.test.ts` asserts that allow-list
 * structurally, because the moment a member-plane file grows a read of
 * its own, "what the client sees" becomes a second query that is right
 * on the day it is written and wrong after the first narrowing nobody
 * mirrors.
 */

/** From `requireTenantContext()` — never from form parameters. */
export type ViewAsCtx = {
  readonly tenantId: string;
  readonly actor: MemberActor;
};

/**
 * The contact being looked through. Deliberately thin: an `id`, the
 * `clientId` the principal needs, the `name` the banner shows and the
 * `locale` the render is pinned to.
 *
 * NO EMAIL, and that is a rule this file inherits rather than invents.
 * Slice 4's review took `Contact.email` off the Portal tab for reading
 * PII across a boundary for nothing, and the same applies here: the
 * banner names a person, it does not address them. The client's NAME is
 * likewise not read — `project:manage_portal` does not imply
 * `client:view`, and the projection already names every project on the
 * screen, so there is nothing a client name would tell the member that
 * the page does not.
 */
export type ViewAsTarget = {
  readonly contactId: string;
  readonly tenantId: string;
  readonly clientId: string;
  readonly name: string;
  readonly profile: ContactPortalProfile;
  /**
   * `Contact.locale`, or null. THE BYTE-IDENTITY TEST TURNS ON THIS
   * FIELD and PLAN §0 named it owed before the slice started: a real
   * contact request resolves its locale from this column
   * (`src/i18n/resolve.ts`), a member request resolves it from the
   * member's own, and two different locales are two different pages.
   * `src/clients/view-as-context.ts` is what pins it, and
   * `src/i18n/resolve.ts` is where it takes effect.
   */
  readonly locale: string | null;
};

/**
 * The gate, and the only place it is written.
 *
 * Both callers run it — entry AND every render — because a mode that
 * checked its permissions once would be a mode that outlives them.
 * AUTHZ §5 is explicit that entitlements are resolved per request
 * precisely so that a downgrade, a suspension or a narrowed role bites
 * immediately; a member who was allowed in an hour ago and has since
 * lost `project:manage_portal` must not still be inside a client's
 * view. The session pointer records that they asked, never that they
 * may (`src/auth/view-as.ts`).
 *
 * The order is the standing recipe — `requireAccess()` then
 * `assertInScope()` — and it is the order that decides WHICH refusal a
 * member meets: the permission is checked before the scope, so a member
 * without the permission gets FORBIDDEN on any client rather than
 * NOT_FOUND on the ones they cannot reach.
 */
async function authorizeViewAs(
  tx: TenantDb,
  ctx: ViewAsCtx,
  contactId: string,
): Promise<ViewAsTarget> {
  await requireAccess(tx, ctx.tenantId, ctx.actor, "project:manage_portal");

  const contact = await tx.contact.findFirst({
    where: { id: contactId },
    select: {
      id: true,
      tenantId: true,
      clientId: true,
      name: true,
      portalProfile: true,
      portalStatus: true,
      invitedAt: true,
      emailVerified: true,
      locale: true,
    },
  });
  // NOT_FOUND either way: a contact of another tenant (RLS returns no
  // row), one outside the member's scope (below) and one that does not
  // exist are the same answer (AUTHZ §4). `return deny(...)` rather than
  // a bare call — `deny` returns `never`, but TypeScript only narrows
  // past it in a return position.
  if (!contact) return deny("NOT_FOUND");
  // See the header: NO `lifted`. The project→client lift is exactly the
  // member this mode must refuse.
  await assertInScope(tx, ctx.actor, { clientId: contact.clientId });

  // ADMISSION, and it is the same three columns the Portal tab counts
  // its audience by — for the same reason, discovered there by review:
  // `authorizePortal()` admits ACTIVE + invited, but `portalGateDecision`
  // refuses an UNVERIFIED address before any portal page runs, so a
  // contact who has never verified cannot sign in at all. Viewing as
  // somebody who could not sign in would be a preview of a page that
  // does not exist.
  //
  // A DomainError rather than an AuthzError, and the distinction is the
  // member-side half of AUTHZ §8: on the portal plane every refusal
  // renders identically because a reason is a fact about the agency —
  // and here the reader IS the agency. "This person cannot sign in yet"
  // is their own tenant's state and the thing they must fix.
  const admitted =
    contact.portalStatus === "ACTIVE" && contact.invitedAt !== null && contact.emailVerified;
  if (!admitted) fail("CONTACT_NOT_VIEWABLE");

  return {
    contactId: contact.id,
    tenantId: contact.tenantId,
    clientId: contact.clientId,
    name: contact.name,
    profile: contact.portalProfile,
    locale: contact.locale,
  };
}

/**
 * ENTERING — authorised and audited in ONE transaction.
 *
 * `project.viewed_as_contact` is the audited act SECURITY.md §5.1 asks
 * for, and this is the only place in the product that writes it. Slice
 * 4 deliberately did not: a page RENDER is not an act, Next re-runs one
 * on prefetch, revalidation and refresh, and a row per render buries the
 * thing the name belongs to. Entry is a POST, so this fires once per
 * act — and the session pointer is what makes that claim hold, since a
 * member cannot be inside the mode without having come through here
 * (`src/auth/view-as.ts` has the argument in full).
 *
 * SAID EXACTLY, because a review asked for the precise version: the row
 * counts MODE ACTIVATIONS, not visits. `Session.viewAsContactId` has no
 * TTL and survives navigation, so a member who enters, goes elsewhere in
 * the app and returns to `/view-as` an hour later is back inside the
 * client's view on the original row. Exiting is not recorded either
 * (there is no `project.view_as_ended` — see `view-as/actions.ts`), so
 * what the log answers is "who entered a client's view, as whom, and
 * when", never "for how long". That is the fact SECURITY.md §5.1 asks
 * for, and the duration reading is deliberately not pursued: an "ended"
 * event could only fire when the member clicks Exit, while a closed tab
 * or an expired session emits nothing, so the pair would be incomplete
 * in a way that reads as "still inside" (`view-as/actions.ts` has the
 * argument; PLAN §0 carries the disposition).
 *
 * THE TARGET IS THE PROJECT THE MEMBER CAME FROM, though the mode spans
 * the client, and the mismatch is worth naming rather than smoothing
 * over. The action is called `project.viewed_as_contact` — it is named
 * in five documents and in the catalogue, and the `portal.*` audit
 * family it might otherwise have joined means CONTACT-CAUSED writes
 * (`portal.request_created`, `portal.comment_created`,
 * `portal.task_completed`), which a member's act is not. So the row
 * reads "from this project, this member entered a client's portal view
 * as this contact", which is exactly what happened: the Portal tab is
 * the one door into the mode. `metadata` carries ids and an enum, never
 * the name the banner renders.
 *
 * The audit row is written INSIDE the member's transaction because
 * `audit.record` stamps `actorType` from the ambient principal and never
 * from its input (`src/audit/record.ts`) — a row written anywhere else
 * would not say MEMBER.
 */
export async function enterViewAs(
  ctx: ViewAsCtx,
  input: { readonly contactId: string; readonly fromProjectId: string },
): Promise<ViewAsTarget> {
  return withTenant(ctx.tenantId, { type: "member", id: ctx.actor.memberId }, async (tx) => {
    const target = await authorizeViewAs(tx, ctx, input.contactId);
    // THE PROJECT MUST BE THE CONTACT'S OWN CLIENT'S, and a dbtest found
    // that the first cut did not check it. An owner holds
    // `client:view_all`, so `assertInScope` alone accepted ANY project of
    // the tenant beside ANY contact of it — and the row written below
    // would then have said "from Acme's project, viewed as a contact of
    // Beta", a sentence describing nothing that happened. An audit trail
    // whose rows can be incoherent is one nobody can reason from.
    //
    // Read under the member's own RLS-scoped transaction, so `clientId`
    // is compared against a row the member may actually see, and
    // `assertInScope` still runs: existence in the tenant is not the same
    // as reachable by this member, and a posted id must not be able to
    // put a project they cannot see into their own tenant's audit log.
    const project = await tx.project.findFirst({
      where: { id: input.fromProjectId, clientId: target.clientId },
      select: { id: true },
    });
    if (!project) deny("NOT_FOUND");
    // The project's KEY is deliberately neither selected nor returned.
    // An earlier cut took `projectKey` as a third action parameter and
    // interpolated it into a redirect target — in a file whose own
    // docblock boasts that this slice carries no return path "because
    // the only way to have one is a parameter on a security-sensitive
    // route that a reviewer must then check for open redirection" (code
    // review). It was not exploitable; it was a claim contradicting
    // itself one screen later.
    await assertInScope(tx, ctx.actor, { projectId: input.fromProjectId });
    await record(tx, {
      action: "project.viewed_as_contact",
      targetType: "Project",
      targetId: input.fromProjectId,
      metadata: {
        contactId: target.contactId,
        clientId: target.clientId,
        portalProfile: target.profile,
      },
    });
    return target;
  });
}

/**
 * EVERY RENDER — the same gate, with the refusal turned into `null`.
 *
 * The page calls this and, on `null`, sends the member back to their
 * own application. It does NOT clear `Session.viewAsContactId` — an
 * earlier draft of this paragraph said it did, which is the repo's
 * recurring finding in miniature. Leaving the pointer is deliberate as
 * well as simpler: it grants nothing (every render re-derives the whole
 * gate), and a member whose access is restored mid-session finds the
 * mode still there rather than silently emptied by a transient refusal.
 * A THROW would be
 * wrong here in a way that matters. The member is inside a client's
 * view; if their access has just been narrowed, the honest response is
 * to put them back in their own application, not to hand them an error
 * boundary rendered inside a portal frame with a red banner across the
 * top still claiming they are looking at Acme's screen.
 *
 * Only an authorization refusal becomes `null`. `CONTACT_NOT_VIEWABLE`
 * is a `DomainError` and is swallowed here too — a contact suspended
 * while the member was reading is precisely this case — but anything
 * else (a dropped connection, a pool timeout) is rethrown, for the
 * reason `portalReadOrNull` gives on the other plane: a surface that
 * reports "you are no longer allowed in here" when the database is down
 * has told someone something false.
 */
export async function resolveViewAs(
  ctx: ViewAsCtx,
  contactId: string,
): Promise<ViewAsTarget | null> {
  try {
    return await withTenant(ctx.tenantId, { type: "member", id: ctx.actor.memberId }, (tx) =>
      authorizeViewAs(tx, ctx, contactId),
    );
  } catch (e) {
    // MFA_REQUIRED IS RE-THROWN, never swallowed. `project:manage_portal`
    // is not a ✦ code today, so this cannot fire — but AUTHZ.md records
    // this exact trap one layer up for `isAuthorized`/`hasAccess`: "a
    // step-up surface asked about this way would vanish instead of
    // prompting". If the code ever becomes ✦, a member with a stale
    // factor must meet the step-up page, not a silent bounce to /home
    // with nothing to act on. The page turns it into that redirect.
    if (e instanceof AuthzError) {
      if (e.reason === "MFA_REQUIRED") throw e;
      return null;
    }
    // Duck-typed on the code rather than `instanceof DomainError`, so a
    // DomainError thrown across a module boundary — or re-created by a
    // serialisation seam — still reads as one.
    if (typeof e === "object" && e !== null && (e as { code?: unknown }).code === "CONTACT_NOT_VIEWABLE") {
      return null;
    }
    throw e;
  }
}
