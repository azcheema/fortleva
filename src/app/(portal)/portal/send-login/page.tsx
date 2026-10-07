import type { Metadata } from "next";
import { getFormatter, getTranslations } from "next-intl/server";
import Link from "next/link";

import { Callout, Page, PageHeader, SectionCard } from "@/components/semantic";
import { isUuid } from "@/db/context";
import { Button } from "@/components/ui/button";
import {
  CREDENTIAL_TYPES,
  listPortalLoginAsks,
  readPortalLoginAsk,
  readPortalSubmissions,
  SECRET_FIELDS,
} from "@/modules/vault";
import { listPortalProjects } from "@/projects/portal";
import { portalReadOrNull } from "@/portal";
import { requirePortalContext } from "@/portal/context";

import { PortalFrame } from "../portal-frame";
import { PortalTasksEmpty } from "../task-list";
import { DeclineAskForm } from "./decline-form";
import { SendLoginForm } from "./send-login-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("portal.sendLogin");
  return { title: t("title") };
}

/** Between the parts of a list row's second line — punctuation, not words. */
const SEPARATOR = " · ";

/** `?ask=` as one uuid, or null — `searchParams` may hold an array, or anything at all. */
const askParam = (raw: string | string[] | undefined): string | null =>
  typeof raw === "string" && isUuid(raw) ? raw : null;

/**
 * `/portal/send-login` — "SEND US A LOGIN" (Phase 3V slice 96; founder
 * decision C64). A client hands a password, key or note over to their
 * agency here instead of by email or in a comment: it goes straight into
 * the agency's vault, for the team only, and the client's people are told.
 * Below the form, the reader's OWN list of what they sent — a name and a
 * date, never the secret (C64 (b)).
 *
 * AND WHERE THE AGENCY'S ASKS ARE ANSWERED (slice 98, C66): the reader's
 * own open asks are listed by name above the form, each opening
 * `?ask=<id>` — the ask's name, where it lands and the agency's note, the
 * form started from what the agency wrote, and "We don't have this". The
 * names are HERE and not on `/portal`, because `/portal` is rendered by
 * View-as under a member session and this page is reached only by a
 * contact (the design review's medium). An `?ask=` that is not one of the
 * reader's open asks — another person's, answered, cancelled, malformed —
 * reads "This request is no longer open" and the ordinary page, the same
 * words for every reason.
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
export default async function SendLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string | string[]; declined?: string | string[]; ask?: string | string[] }>;
}) {
  const { principal, name } = await requirePortalContext();
  const t = await getTranslations("portal.sendLogin");
  const tVault = await getTranslations("vault");
  const format = await getFormatter();
  const { sent: sentFlag, declined: declinedFlag, ask: rawAsk } = await searchParams;
  const askId = askParam(rawAsk);

  const submissions = await portalReadOrNull("readPortalSubmissions", () => readPortalSubmissions(principal));
  const open = submissions?.open === true;
  // Everything below in SEQUENCE after the read above, never beside it.
  // The ask this page was opened for, when it is one of the reader's open
  // asks; otherwise their open asks, to pick from.
  const ask = open && askId !== null
    ? await portalReadOrNull("readPortalLoginAsk", () => readPortalLoginAsk(principal, askId))
    : null;
  const asks = open && ask === null
    ? ((await portalReadOrNull("listPortalLoginAsks", () => listPortalLoginAsks(principal))) ?? [])
    : [];
  // The picker's projects — the portal-enabled projects of this client, asked
  // for the SAME capability the action needs (`listPortalProjects`' rule).
  // None in answer to an ask: it lands where the ask says.
  const projects = open && ask === null
    ? await portalReadOrNull("listPortalProjects", () => listPortalProjects(principal, "portal.credential.submit"))
    : null;
  const sent = submissions?.sent ?? [];
  const when = (d: Date) => format.dateTime(d, { dateStyle: "medium" });

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
          {sentFlag === "1" ? (
            <Callout tone="success" role="status" title={t("sent")}>
              {t("sentBody")}
            </Callout>
          ) : null}
          {declinedFlag === "1" ? (
            <Callout tone="success" role="status" title={t("decline.done")}>
              {t("decline.doneBody")}
            </Callout>
          ) : null}
          {open && askId !== null && ask === null ? (
            <Callout tone="info" role="status" title={t("ask.gone")}>
              {t("ask.goneBody")}
            </Callout>
          ) : null}
          {open && ask ? (
            <>
              <SectionCard
                title={t("ask.title", { name: ask.name })}
                description={ask.project ? t("ask.forProject", { project: ask.project.name }) : t("ask.forCompany")}
              >
                <div className="flex flex-col gap-4">
                  {ask.note ? (
                    <div data-slot="ask-note" className="flex flex-col gap-1">
                      <span className="text-xs text-muted-foreground">{t("ask.note")}</span>
                      <p className="whitespace-pre-wrap text-sm text-foreground">{ask.note}</p>
                    </div>
                  ) : null}
                  <p className="text-sm text-muted-foreground">{t("ask.formDescription")}</p>
                  <SendLoginForm
                    types={CREDENTIAL_TYPES}
                    fieldsByType={SECRET_FIELDS}
                    projects={[]}
                    ask={{ id: ask.id, type: ask.type, name: ask.name }}
                  />
                </div>
              </SectionCard>
              <SectionCard title={t("decline.title")} description={t("decline.description")}>
                <DeclineAskForm askId={ask.id} />
              </SectionCard>
            </>
          ) : null}
          {open && ask === null ? (
            <>
              {asks.length > 0 ? (
                <SectionCard title={t("asks.title")} description={t("asks.description")} contentClassName="p-0">
                  <ul data-slot="login-asks" className="divide-y divide-border">
                    {asks.map((a) => {
                      // ONE text expression for the line (the portal's
                      // byte-stable rule).
                      const meta = [
                        tVault(`types.${a.type}`),
                        ...(a.project ? [a.project.name] : []),
                        t("asks.askedOn", { date: when(a.askedAt) }),
                      ].join(SEPARATOR);
                      return (
                        <li
                          key={a.id}
                          data-slot="login-ask"
                          className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2"
                        >
                          <span className="flex min-w-0 flex-col gap-0.5">
                            <span className="truncate text-sm text-foreground">{a.name}</span>
                            <span className="text-xs text-muted-foreground">{meta}</span>
                          </span>
                          <Button asChild variant="outline" size="sm">
                            <Link href={`/portal/send-login?ask=${a.id}`} prefetch={false}>
                              {t("asks.answer")}
                            </Link>
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                </SectionCard>
              ) : null}
              <SectionCard title={t("formTitle")} description={t("formDescription")}>
                <SendLoginForm
                  types={CREDENTIAL_TYPES}
                  fieldsByType={SECRET_FIELDS}
                  projects={projects ?? []}
                  ask={null}
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
                      {t("list.sentOn", { date: when(login.sentAt) })}
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
