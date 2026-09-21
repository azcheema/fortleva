import { getTranslations } from "next-intl/server";

import { Callout, Page, PageHeader } from "@/components/semantic";
import { listPortalTasks } from "@/modules/work";
import { portalReadOrNull, type PortalPrincipal } from "@/portal";

import { PortalFrame } from "./portal-frame";
import { PortalTasksEmpty, ProjectTasks } from "./task-list";

/**
 * THE PORTAL HOME, AS A COMPONENT — everything `/portal` is, minus the
 * decision about who is asking.
 *
 * It exists because of View-as-Contact (Phase 3 slice 5) and it is the
 * mechanism behind that slice's one hard claim. SECURITY.md §5.1
 * requires the member-facing view to be "output byte-compared to a real
 * contact session in CI", and the only way a comparison like that can
 * keep passing is if there is nothing to compare: ONE component, two
 * routes, differing in how the principal was obtained and in nothing
 * else. `/portal` gets it from a contact session
 * (`requirePortalContext()`); `/view-as` synthesises it from a contact
 * row a member has been authorised to look through
 * (`synthesiseContactPrincipal()`). Both hand it here.
 *
 * WHICH IS WHY THE PRINCIPAL IS A PROP AND NOT A LOOKUP. If this file
 * called `requirePortalContext()` it would be a portal-plane component,
 * and View-as — which runs under the MEMBER'S session, by founder
 * decision — would have had to grow its own copy of this page. Two
 * copies is exactly the arrangement the pins forbid: the preview would
 * be right on the day it was written and wrong after the first
 * narrowing nobody remembered to mirror.
 *
 * NOTHING IN HERE MAY REACH FOR A REQUEST CONTEXT, for the same reason
 * `task-list.tsx` says so at the top: on the member plane there is no
 * contact session to find, and a component that looked for one would
 * throw at render. The contact's NAME comes in as a prop. Their LANGUAGE
 * and TIME ZONE do not — those are the whole request's, pinned above
 * every layout by `src/clients/view-as-context.ts`, because next-intl's server
 * hooks read the request config and cannot be handed one per subtree.
 *
 * ONE SURFACE FOR EVERY AUTHORIZATION REFUSAL, and it is the
 * load-bearing line. `portalReadOrNull` turns every `AuthzError` into
 * `null`, and `null` renders the same empty state as a client who
 * genuinely has nothing shared. A contact of a tenant whose plan lacks
 * the module, one whose agency switched the portal off, one whose
 * profile does not hold the capability and one whose agency has shared
 * nothing all see the same page, byte for byte. A denial reason is a
 * fact about the AGENCY, and the portal is the one surface where the
 * agency's facts are not the reader's to have (`src/portal/render.ts`).
 *
 * That property is inherited by View-as unchanged, which is worth
 * stating because it is the one place it could be thought a bug: a
 * member inside View-as sees the SAME undifferentiated empty page a
 * contact would. The member's explanation lives on the Portal tab,
 * where the blockers are computed member-side from rows they may read
 * anyway — never from this call's denial.
 */

/**
 * `data-portal-surface` is the boundary the byte comparison is drawn
 * around, and it is on the frame rather than on the page so that the
 * portal's CHROME is inside it too — the bar, the product mark and the
 * "signed in as" line are as much "what the client sees" as the task
 * list. What is OUTSIDE it is the red View-as banner, which is the only
 * thing on that route a contact never gets. Naming the boundary in the
 * markup, rather than agreeing on a CSS selector in a spec file, is
 * what stops the test from silently comparing less than it claims.
 */
export async function PortalHome({
  principal,
  name,
}: {
  principal: PortalPrincipal;
  name: string;
}) {
  const t = await getTranslations("portal");
  const list = await portalReadOrNull("listPortalTasks", () => listPortalTasks(principal));
  const projects = list?.projects ?? [];

  return (
    <PortalFrame name={name}>
      <Page>
        <div className="flex flex-col gap-6">
          <PageHeader title={t("title")} description={t("description")} />
          {projects.length === 0 ? (
            // Shared with the member app's Portal tab since 2026-09-21,
            // so the preview there and this page cannot drift apart —
            // see `task-list.tsx` for why the variant and the glyph are
            // what they are.
            <PortalTasksEmpty />
          ) : (
            <>
              {list?.truncated ? (
                <Callout tone="info">{t("tasks.truncated", { count: list.shown })}</Callout>
              ) : null}
              {projects.map((project) => (
                <ProjectTasks key={project.projectId} project={project} />
              ))}
            </>
          )}
        </div>
      </Page>
    </PortalFrame>
  );
}
