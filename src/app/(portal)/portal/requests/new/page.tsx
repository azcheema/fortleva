import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { Page, PageHeader, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { listPortalProjects } from "@/projects/portal";
import { portalReadOrNull } from "@/portal";
import { requirePortalContext } from "@/portal/context";

import { PortalFrame } from "../../portal-frame";
import { PortalTasksEmpty } from "../../task-list";
import { RequestForm } from "./request-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("portal.requests");
  return { title: t("title") };
}

/**
 * `/portal/requests/new` — THE ONE THING A CLIENT CAN PUT ON THE
 * AGENCY'S BOARD (plan §3, "portal REQUEST intake").
 *
 * IT IS A ROUTE OF ITS OWN AND NOT A SECTION OF `/portal`, and the
 * reason is View-as-Contact. `/portal`'s body is `<PortalHome>`, the one
 * component the member app's `/view-as` renders too, byte-compared in
 * CI — so anything added there is also rendered under a MEMBER session.
 * A form is safe there (every portal action takes its principal from
 * `requirePortalContext()`, which finds no contact on a member request),
 * but it would put a submit button in front of a member that can only
 * ever bounce them to the client sign-in page. The LINK is shared,
 * because a link is genuinely part of what the client sees; the form is
 * one navigation further on, where only a contact can be.
 *
 * WHAT A MEMBER INSIDE VIEW-AS GETS IF THEY FOLLOW THAT LINK is the
 * portal login page, which is the correct answer and a slightly abrupt
 * one. It is recorded rather than smoothed over: a nicer answer needs
 * the route to know which plane it is on, and a portal page that can
 * tell is a portal page that can differ.
 *
 * THE EMPTY CASE IS THE PLANE'S UNIFORM ONE. `portalReadOrNull` turns
 * every authorization refusal into `null`, and `null` renders exactly
 * what a client with no portal-enabled project renders — so a contact
 * whose profile lacks `portal.request.create`, one whose agency's plan
 * lacks the module, and one whose agency simply has not enabled a
 * project all see the same page. That the picker is asked for the
 * CREATE capability rather than the view one (`listPortalProjects`) is
 * what makes the first of those three land here rather than at the end
 * of a submit.
 */
export default async function NewPortalRequest() {
  const { principal, name } = await requirePortalContext();
  const t = await getTranslations("portal.requests");
  const projects = await portalReadOrNull("listPortalProjects", () =>
    listPortalProjects(principal, "portal.request.create"),
  );

  return (
    <PortalFrame name={name}>
      <Page>
        <div className="flex flex-col gap-6">
          <PageHeader
            title={t("title")}
            description={t("description")}
            actions={
              <Button asChild variant="outline" size="sm">
                <Link href="/portal">{t("back")}</Link>
              </Button>
            }
          />
          {!projects || projects.length === 0 ? (
            <PortalTasksEmpty />
          ) : (
            <SectionCard title={t("formTitle")} description={t("formDescription")}>
              <RequestForm projects={projects} />
            </SectionCard>
          )}
        </div>
      </Page>
    </PortalFrame>
  );
}
