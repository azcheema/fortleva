import type { Metadata } from "next";
import { getFormatter, getTranslations } from "next-intl/server";
import Link from "next/link";

import { Callout, Page, PageHeader, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { CREDENTIAL_TYPES, readPortalSubmissions, SECRET_FIELDS } from "@/modules/vault";
import { listPortalProjects } from "@/projects/portal";
import { portalReadOrNull } from "@/portal";
import { requirePortalContext } from "@/portal/context";

import { PortalFrame } from "../portal-frame";
import { PortalTasksEmpty } from "../task-list";
import { SendLoginForm } from "./send-login-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("portal.sendLogin");
  return { title: t("title") };
}

/**
 * `/portal/send-login` — "SEND US A LOGIN" (Phase 3V slice 96; founder
 * decision C64). A client hands a password, key or note over to their
 * agency here instead of by email or in a comment: it goes straight into
 * the agency's vault, for the team only, and the client's people are told.
 * Below the form, the reader's OWN list of what they sent — a name and a
 * date, never the secret (C64 (b)).
 *
 * A ROUTE OF ITS OWN, never a section of `/portal`, for the request form's
 * reason (`requests/new/page.tsx`): `/portal`'s body is rendered by
 * View-as under a MEMBER session too, and a form there would invite a
 * member to submit something only a contact can. The home carries the LINK
 * (drawn only when this page would take a login — the broker's one bit).
 *
 * THE EMPTY CASE IS THE PLANE'S UNIFORM ONE: sending switched off by the
 * agency, the module, a profile without the capability, access ended —
 * every refusal renders the same page (`portalReadOrNull`).
 */
export default async function SendLoginPage({ searchParams }: { searchParams: Promise<{ sent?: string }> }) {
  const { principal, name } = await requirePortalContext();
  const t = await getTranslations("portal.sendLogin");
  const format = await getFormatter();
  const { sent: sentFlag } = await searchParams;

  const submissions = await portalReadOrNull("readPortalSubmissions", () => readPortalSubmissions(principal));
  // The picker's projects — the portal-enabled projects of this client, asked
  // for the SAME capability the action needs (`listPortalProjects`' rule). In
  // sequence after the read above, never beside it.
  const projects = submissions?.open
    ? await portalReadOrNull("listPortalProjects", () => listPortalProjects(principal, "portal.credential.submit"))
    : null;
  const open = submissions?.open === true;
  const sent = submissions?.sent ?? [];

  return (
    <PortalFrame name={name} principal={principal} nav="home">
      <Page width="form">
        <div className="flex flex-col gap-6">
          <PageHeader
            title={t("title")}
            description={t("description")}
            actions={
              <Button asChild variant="outline" size="sm">
                <Link href="/portal" prefetch={false}>
                  {t("back")}
                </Link>
              </Button>
            }
          />
          {!open && sent.length === 0 ? <PortalTasksEmpty /> : null}
          {open ? (
            <>
              {sentFlag === "1" ? (
                <Callout tone="success" role="status" title={t("sent")}>
                  {t("sentBody")}
                </Callout>
              ) : null}
              <SectionCard title={t("formTitle")} description={t("formDescription")}>
                <SendLoginForm
                  types={CREDENTIAL_TYPES}
                  fieldsByType={SECRET_FIELDS}
                  projects={projects ?? []}
                />
              </SectionCard>
            </>
          ) : null}
          {/* What the reader sent stands whether or not the agency is taking
              logins now (C64 (b)): the switch is never told by a list
              emptying. Keyed by position — a login's id never reaches the
              client. */}
          {sent.length > 0 ? (
            <SectionCard title={t("list.title")} description={t("list.description")} contentClassName="p-0">
              <ul data-slot="sent-logins" className="divide-y divide-border">
                {sent.map((login, index) => (
                  <li
                    key={index}
                    data-slot="sent-login"
                    className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-2"
                  >
                    <span className="min-w-0 truncate text-sm text-foreground">{login.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {t("list.sentOn", { date: format.dateTime(login.sentAt, { dateStyle: "medium" }) })}
                    </span>
                  </li>
                ))}
              </ul>
            </SectionCard>
          ) : null}
        </div>
      </Page>
    </PortalFrame>
  );
}
