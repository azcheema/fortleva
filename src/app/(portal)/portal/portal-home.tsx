import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { Callout, Page, PageHeader } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { listPortalTasks, listPortalUpdates, type PortalProjectTasks, type PortalUpdate } from "@/modules/work";
import { portalReadOrNull, type PortalPrincipal } from "@/portal";
import { listPortalProjects } from "@/projects/portal";

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
 *
 * THE REQUEST LINK IS HERE AND THE REQUEST FORM IS NOT (slice 6a), and
 * the split is View-as again. Everything in this component is rendered
 * under a MEMBER session by `/view-as` as well, so a form placed here
 * would show a member a submit button that can only bounce them to the
 * client sign-in page — every portal action takes its principal from
 * `requirePortalContext()`, so a member cannot drive one, but being
 * unable to is not the same as not being invited to try. A LINK is
 * genuinely part of what the client sees, so it stays; the form lives
 * one navigation on, at `/portal/requests/new`, where only a contact
 * can be. The byte comparison is unaffected either way: both routes
 * render this file, so both render the same link or neither does.
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
  // THE LINK IS SHOWN ONLY WHEN THE SUBMIT WOULD WORK. It asks the same
  // question `/portal/requests/new` asks — the portal-enabled projects
  // of this client, under `portal.request.create` — so a contact whose
  // profile does not hold the verb, or whose agency has no project
  // switched on, is not offered a door that opens onto the plane's
  // uniform empty page. One extra bounded read, and it is the read that
  // decides the chrome.
  //
  // SEQUENTIAL, NOT `Promise.all`, and a code review was right about
  // why. These are two independent TRANSACTIONS, so the parallel form
  // really would overlap — but `portalReadOrNull` swallows only
  // `AuthzError`, so if both rejected with something else (a dropped
  // connection on this page is the realistic case) `Promise.all` would
  // surface the first and leave the second an UNHANDLED rejection.
  // Trading one round trip on a low-traffic page for that is the right
  // way round.
  const requestTargets = await portalReadOrNull("listPortalProjects", () =>
    listPortalProjects(principal, "portal.request.create"),
  );
  // The newest published update per project (Phase 3), a third
  // sequential read under the same rule as the two above. A project
  // with an update and no shared task still gets a card — the update IS
  // what the agency shared — so the two lists are merged by project
  // here, in the order the task list already fixed, with update-only
  // projects after it.
  const latest = await portalReadOrNull("listPortalUpdates", () =>
    listPortalUpdates(principal, { latestOnly: true }),
  );
  const updateByProject = new Map<string, PortalUpdate>((latest ?? []).map((u) => [u.projectId, u]));
  const projects: PortalProjectTasks[] = [...(list?.projects ?? [])];
  for (const u of latest ?? []) {
    if (!projects.some((p) => p.projectId === u.projectId)) {
      projects.push({ projectId: u.projectId, projectName: u.projectName, tasks: [] });
    }
  }
  const canRequest = (requestTargets?.length ?? 0) > 0;

  return (
    <PortalFrame name={name}>
      <Page>
        <div className="flex flex-col gap-6">
          <PageHeader
            title={t("title")}
            description={t("description")}
            actions={
              canRequest ? (
                <Button asChild size="sm">
                  <Link href="/portal/requests/new">{t("requests.cta")}</Link>
                </Button>
              ) : null
            }
          />
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
                <ProjectTasks
                  key={project.projectId}
                  project={project}
                  update={updateByProject.get(project.projectId) ?? null}
                />
              ))}
            </>
          )}
        </div>
      </Page>
    </PortalFrame>
  );
}
