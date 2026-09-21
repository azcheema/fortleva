import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { PortalHome } from "@/app/(portal)/portal/portal-home";
import { resolveViewAsTarget } from "@/clients/view-as-context";
import { resolveMemberLocale } from "@/i18n/resolve";
import { requireTenantContext } from "@/members/tenant-context";
import { synthesiseContactPrincipal } from "@/portal";

import { ViewAsBanner } from "./view-as-banner";

export async function generateMetadata(): Promise<Metadata> {
  // The MEMBER'S language: a browser tab title is chrome, and chrome on
  // this route belongs to the member (see `view-as-banner.tsx`). It is
  // also outside `[data-portal-surface]`, so it is not part of what the
  // byte comparison holds constant.
  const t = await getTranslations({ locale: await resolveMemberLocale(), namespace: "viewAs" });
  return { title: t("title") };
}

/**
 * `/view-as` — VIEW-AS-CONTACT (Phase 3 memo slice 5).
 *
 * A member walks a client's portal as one named contact. The pins give
 * this four obligations and the whole file is arranged around them:
 * the same projection functions as a real contact request, a red
 * banner, `project.viewed_as_contact` audited, and output byte-compared
 * to a real contact session in CI (SECURITY.md §5.1 and its vector
 * table).
 *
 * WHY IT IS A SIBLING OF `(authed)` AND NOT A CHILD. Everything under
 * `(authed)` is wrapped in `AppShell` — the nav rail, ⌘K, the timer
 * pill, the workspace switcher. UI.md §11 says the portal's chrome is
 * "tenant name/logo, project switcher, profile menu — no ⌘K, no keymap,
 * no timer", so a View-as page inside that layout would be the client's
 * screen wearing the agency's furniture, and byte-identity would be
 * impossible by construction rather than by mistake. It is still a
 * member-authenticated route: `src/proxy.ts` demands a member cookie
 * for everything that is not `/ops`, `/portal` or public, and this is
 * none of those.
 *
 * AND WHY IT IS NOT UNDER `/portal`, which would have been the obvious
 * place. The proxy gates that prefix on the PORTAL session cookie: a
 * member arriving with only a member cookie is redirected to
 * `/portal/login`, a form that cannot authenticate them. Putting
 * View-as there would have meant widening a plane boundary to let one
 * page through, which is the sort of hole that is opened for a good
 * reason and closed for none.
 *
 * THE AUTHORIZATION IS RE-DERIVED HERE, EVERY RENDER — it is not
 * inherited from the act of entering. `resolveViewAsTarget()` runs
 * `project:manage_portal`, the client-scope check and the contact's own
 * admission again (`src/clients/view-as.ts`), so a member whose role was
 * narrowed, whose client assignment was removed, or whose contact was
 * suspended while they were reading stops being inside the mode at the
 * next navigation. `Session.viewAsContactId` records that they ASKED,
 * never that they may.
 *
 * A REDIRECT AND NOT A 404 when that returns null, which is the
 * opposite of the Portal tab's answer next door and deliberately so.
 * A 404 is right for a hidden surface someone typed the URL of. This is
 * a surface the member was legitimately inside a moment ago, and the
 * honest response to "your access just changed" is to put them back in
 * their own application — not to leave them on an error boundary
 * rendered inside a portal frame under a red banner still claiming they
 * are looking at a client's screen.
 *
 * NOTHING IS READ HERE. The banner takes a name; every task on the page
 * comes from `listPortalTasks` under the CONTACT principal, inside
 * `<PortalHome>` — the very component `/portal` renders. That is the
 * import-graph half of the pins, and `src/authz/portal-view-as.test.ts`
 * fails if this file ever grows a query of its own.
 */
export default async function ViewAsPage() {
  const target = await resolveViewAsTarget();
  // Not in the mode, or no longer allowed to be. `/home` rather than
  // the project they came from: the mode spans a client, and this slice
  // deliberately carries no return path (see `actions.ts`).
  if (!target) redirect("/home");

  // THE BELT'S TWO ARGUMENTS COME FROM DIFFERENT PLACES, deliberately.
  // The first cut passed `target.tenantId` on both sides, which made the
  // check inside `synthesiseContactPrincipal` incapable of firing here —
  // decoration, in a function whose docblock calls it a live check the
  // next caller cannot bypass (code review). The MEMBER'S tenant comes
  // from their session; the CONTACT'S comes from a row read under it.
  const { membership } = await requireTenantContext();
  const principal = await synthesiseContactPrincipal(membership.tenantId, {
    id: target.contactId,
    tenantId: target.tenantId,
    clientId: target.clientId,
  });

  return (
    <>
      {/* OUTSIDE `data-portal-surface`, which `<PortalFrame>` marks and
          the byte comparison is drawn around. The banner is the one
          thing on this route no contact ever receives; inside the
          boundary it would make byte-identity impossible and the test
          would have to be weakened to a subset match. */}
      <ViewAsBanner name={target.name} />
      <PortalHome principal={principal} name={target.name} />
    </>
  );
}
