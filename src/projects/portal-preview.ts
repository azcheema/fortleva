import { assertInScope, type MemberActor } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { withTenant } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import type { ContactPortalProfile } from "@/generated/prisma/enums";
import { listPortalTasks, type PortalProjectTasks } from "@/modules/work";
import {
  PORTAL_CAPABILITIES,
  portalGatesFor,
  portalModuleVerdict,
  portalReadOrNull,
  profileHolds,
  synthesiseContactPrincipal,
} from "@/portal";

/**
 * "WHAT THE CLIENT SEES" — the member side of the portal, and the
 * first surface that ever looked through a synthesised contact
 * principal.
 *
 * THE RULE IT EXISTS TO OBEY. SECURITY.md §5.1 and the plan's §3.2 pin say
 * the same thing in three documents: the member-facing preview "reuses
 * the exact same functions" as a real contact request, because **a
 * separate preview renderer is how previews lie**. So this file renders
 * nothing and projects nothing. It authorises a member, decides WHICH
 * contact the preview speaks for, synthesises that contact's principal,
 * and hands it to `listPortalTasks` — the same function `/portal` calls
 * under a real contact session. `src/authz/portal-view-as.test.ts` is
 * the import-graph assertion AUTHZ.md §11 asks for: it fails if this
 * file ever grows a row read of its own.
 *
 * THE PRINCIPAL IS SYNTHESISED, AND SINCE SLICE 5 NOT HERE.
 * `synthesiseContactPrincipal()` (`src/portal/synthesise.ts`) is the
 * member plane's one builder, and the hazard it closes is the gates
 * map: it is caller-supplied data, and a surface carrying ANOTHER
 * tenant's map would let one agency's entitlements decide another's.
 * That function takes no tenant id to resolve them from — it reads
 * `contact.tenantId` off the row this file just read inside the
 * member's own RLS-scoped transaction. The member's session decides
 * nothing but whether they may ask.
 *
 * The belt below stays here rather than moving with it, and the
 * difference is the point: the builder can only check the ONE contact
 * handed to it, while `audience` is COUNTED from the whole list, and a
 * count is an answer too.
 *
 * WHY THE "WHY" LIVES HERE AND NOT IN THE PROJECTION. On the portal
 * plane every refusal renders identically, because a denial reason is a
 * fact about the AGENCY (`portalReadOrNull`, AUTHZ §8). The member IS
 * the agency, and an empty preview with no explanation would be the one
 * surface where that rule does harm: a member who has switched the
 * portal on, shared three tasks and invited nobody must be told which of
 * the four things standing in the way is theirs to fix. So the projection
 * still answers only WHAT, through the same swallowing wrapper, and the
 * blockers below are computed separately from rows the member is
 * entitled to read anyway. The two never share a code path, which is
 * what stops the member-side explanation from becoming a portal-side
 * leak.
 *
 * NOT AUDITED, DELIBERATELY. `project.viewed_as_contact` is in the audit
 * catalogue and this does not write it. Three reasons, in order of
 * weight: a page RENDER is not an act, and Next re-renders on prefetch,
 * revalidation and refresh, so a row per render would bury the act the
 * name belongs to; every row in this preview is a CLIENT_VISIBLE row of
 * a project the member already holds `project:view` and scope on, so
 * nothing here discloses anything the Backlog does not; and the action
 * names the explicit mode View-as-Contact builds next, where a member
 * enters a client's view and navigates it. Spending the name on a tab
 * render would leave that slice without one. *(Slice 5 landed it:
 * `/view-as` records exactly one row per ENTRY, because the entry is a
 * POST and not a render — see `src/clients/view-as.ts`.)*
 */

export type PortalPreviewCtx = {
  readonly tenantId: string;
  /** From requireTenantContext() — never from form params. */
  readonly actor: MemberActor;
};

/**
 * Everything standing between this project's shared work and the
 * client's screen, from the member's side of the glass. ALL that apply,
 * never the first: a portal that is switched off AND has no audience
 * needs two things done, and reporting one at a time is how a member
 * fixes one and sees no change.
 */
export type PortalPreviewBlocker =
  /** Gates 1–3: the kill-switch, the plan, or the tenant's own switch. */
  | "MODULE_OFF"
  /** `Project.portalEnabled` is false — the master switch on this tab. */
  | "PORTAL_OFF"
  /** Archived projects publish nothing (founder decision, 2026-09-21). */
  | "PROJECT_ARCHIVED"
  /** No contact of this client can sign in, so nobody is looking. */
  | "NO_AUDIENCE"
  /**
   * Everything is open and the project simply has nothing marked
   * CLIENT_VISIBLE — which is the FIRST state of this tab for most
   * projects, because INTERNAL is the default everywhere.
   *
   * It is a blocker rather than a change to the empty panel, and that
   * distinction is the finding it answers (code review, 2026-09-21).
   * The panel is the CONTACT'S: its copy says "Nothing shared with you
   * yet — ask your contact at the agency", and a delivery lead reading
   * their own project was being told to ask themselves. Rewriting that
   * copy would fork the one component this tab's whole claim rests on;
   * putting the member-voiced explanation here — where the other four
   * already live — keeps the panel byte-faithful and still hands the
   * member the verb.
   */
  | "NOTHING_SHARED";

export type PortalPreviewContact = {
  readonly id: string;
  readonly name: string;
  readonly profile: ContactPortalProfile;
};

export type PortalPreview = {
  readonly blockers: readonly PortalPreviewBlocker[];
  /**
   * The contact this preview speaks for — null when the client has none
   * who could sign in. The name is shown, because "what the client sees"
   * is not a single answer: two contacts of one client can hold
   * different profiles, and a preview that did not say whose view it was
   * would be making a promise it cannot keep.
   */
  readonly contact: PortalPreviewContact | null;
  /** How many contacts of this client could sign in right now. */
  readonly audience: number;
  /**
   * The projection's own answer for this project, or null — which is
   * both "nothing is shared" and "the read was refused", exactly as it
   * is for a contact. The blockers above are what tell the two apart,
   * and they are computed from the member's side.
   */
  readonly tasks: PortalProjectTasks | null;
  readonly truncated: boolean;
};

/**
 * `project:manage_portal` + scope, then the contact, then the same
 * projection a contact's own request runs.
 *
 * Three transactions rather than one, and the split is not incidental:
 * the member's read runs under the member principal, the module gates
 * under the system principal (they are unreadable under a contact one —
 * `src/portal/module-gates.ts`), and the projection under the CONTACT
 * principal, which is the only one that proves anything about what a
 * client can reach. Nesting them would mean one principal for all three.
 */
export async function readPortalPreview(
  ctx: PortalPreviewCtx,
  projectId: string,
): Promise<PortalPreview> {
  const seen = await withTenant(
    ctx.tenantId,
    { type: "member", id: ctx.actor.memberId },
    async (tx) => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "project:manage_portal");
      const project = await tx.project.findFirst({
        where: { id: projectId },
        select: { id: true, clientId: true, portalEnabled: true, archivedAt: true },
      });
      // NOT_FOUND either way, so a project of another tenant (RLS
      // returns no row), one outside the member's scope (`assertInScope`)
      // and one that does not exist are the same answer (AUTHZ.md §4).
      // Unreachable from the Portal tab — `loadProject` has already
      // resolved the same project for the same actor and 404'd — but a
      // service whose safety depends on its only caller is not a service.
      // `return deny(...)`, not a bare call: `deny` returns `never`, but
      // TypeScript only narrows `project` past it in a return position —
      // the same idiom `authorizePortal()` records.
      if (!project) return deny("NOT_FOUND");
      await assertInScope(tx, ctx.actor, { projectId });

      // WHO THE PREVIEW SPEAKS FOR. Every contact of this client that
      // could actually reach the portal — and "actually" is the word the
      // first cut of this query got wrong (code review, 2026-09-21). It
      // asked for `authorizePortal()`'s admission test, ACTIVE and
      // stamped as invited (the row-level half of invite-only, AUTHZ §8
      // amendment 3), and that is admission to a PROJECTION, not to the
      // product: `portalGateDecision` refuses an unverified address
      // ("unverified") before any portal page runs, so a client whose
      // only contact had never verified their email was counted as "1
      // contact can sign in" and shown no NO_AUDIENCE blocker, while
      // /portal/login turned that contact away. A blocker list is only
      // worth reading if it is exhaustive.
      //
      // Still NOT checked here: that a `ContactAccount` credential
      // exists. Nothing in the product creates one yet (the invite slice
      // does), so requiring it today would report NO_AUDIENCE for every
      // tenant; the invite slice owns adding it.
      //
      // The ORDER is `invitedAt` then the id — deterministic without
      // depending on anything a collation or an enum's declaration order
      // decides, which `portalProfile: "asc"` would have (Postgres sorts
      // an enum by its ORDINAL, so that clause would have read as
      // "PRIMARY first" only for as long as nobody reordered the type).
      // The profile preference is applied in TypeScript below, where it
      // is a rule anyone can read.
      const contacts = await tx.contact.findMany({
        where: {
          clientId: project.clientId,
          portalStatus: "ACTIVE",
          invitedAt: { not: null },
          emailVerified: true,
        },
        select: {
          id: true,
          tenantId: true,
          clientId: true,
          name: true,
          portalProfile: true,
        },
        orderBy: [{ invitedAt: "asc" }, { id: "asc" }],
      });
      return { project, contacts };
    },
  );

  const { project, contacts } = seen;
  // BELT, and the same one `authorizePortal()` carries: under
  // `tenant_isolation` this read cannot return another tenant's contact,
  // so this can only fire if a GUC and a row disagree — which is exactly
  // when one wants it to. Applied to the WHOLE list, not only the
  // contact finally chosen (review), because `audience` is counted from
  // the list and a count is an answer too.
  if (contacts.some((c) => c.tenantId !== ctx.tenantId)) {
    deny("NOT_FOUND", "contact tenant does not match");
  }
  const gates = await portalGatesFor(ctx.tenantId);
  // The same verdict `authorizePortal()` reaches for this capability, so
  // the member's explanation and the contact's refusal can never
  // disagree about whether the module is open.
  const moduleVerdict = portalModuleVerdict("portal.work_item.view", gates);

  const blockers: PortalPreviewBlocker[] = [];
  if (!moduleVerdict.ok) blockers.push("MODULE_OFF");
  if (!project.portalEnabled) blockers.push("PORTAL_OFF");
  if (project.archivedAt) blockers.push("PROJECT_ARCHIVED");
  if (contacts.length === 0) blockers.push("NO_AUDIENCE");

  // WHOSE VIEW, and it is DERIVED rather than named — which is the
  // correction a review asked for and it is a forward-looking one. The
  // first cut said `find(CONTACT_PRIMARY) ?? contacts[0]`, on the sound
  // reasoning that PRIMARY holds every v1 capability and so sees the
  // most, and a preview that under-reports what is exposed is wrong in
  // the dangerous direction. But the FALLBACK was invite order, and
  // `capabilities.ts` already names `CONTACT_FINANCE` as v2 — a profile
  // that will not hold `portal.work_item.view` at all. A client whose
  // only contacts were finance would then have been previewed through a
  // profile that sees nothing here, with no blocker to explain it.
  //
  // So: prefer the contacts whose profile actually holds the capability
  // this projection needs, and among those the WIDEST profile, measured
  // against the frozen capability table rather than spelled out. A
  // profile added later is ranked without touching this line. `sort` is
  // stable, so the query's deterministic order survives ties.
  const width = (profile: string) =>
    PORTAL_CAPABILITIES.filter((c) => profileHolds(profile, c)).length;
  const able = contacts.filter((c) => profileHolds(c.portalProfile, "portal.work_item.view"));
  const pool = able.length > 0 ? able : contacts;
  const as = [...pool].sort((a, b) => width(b.portalProfile) - width(a.portalProfile))[0];

  let list: Awaited<ReturnType<typeof listPortalTasks>> | null = null;
  if (as) {
    // The principal is built by the one member-plane builder
    // (`src/portal/synthesise.ts`, slice 5), which resolves the gates
    // from `as.tenantId` rather than from anything this file is
    // holding. Until then those two lines lived here, with the belt
    // above them; they are the same two lines, in the place the next
    // member-plane surface cannot bypass.
    const principal = await synthesiseContactPrincipal(ctx.tenantId, as);
    list = await portalReadOrNull("previewPortalTasks", () =>
      listPortalTasks(principal, { projectId }),
    );
  }
  // One project was asked for, so at most one group comes back; a
  // refusal and an empty answer are both `null`, as they are for a
  // contact.
  const tasks = list?.projects[0] ?? null;

  // LAST, and only when nothing else is in the way: with a blocker
  // standing, "nothing is shared" is not the reason the panel is empty
  // and saying so would send the member to fix the wrong thing. The
  // narrow inaccuracy is a contact whose row changes between the member
  // read and the projection — then the panel is empty for a reason this
  // list does not name, and this line names the wrong one. One extra
  // round trip would not close that race either, since the row can
  // change after it too.
  if (!tasks && blockers.length === 0) blockers.push("NOTHING_SHARED");

  return {
    blockers,
    contact: as ? { id: as.id, name: as.name, profile: as.portalProfile } : null,
    audience: contacts.length,
    tasks,
    truncated: list?.truncated ?? false,
  };
}
