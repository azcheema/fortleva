import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { Callout, Page, PageHeader, SectionCard } from "@/components/semantic";
import { listPortalDocuments, type PortalDocument } from "@/documents/portal";
import { portalReadOrNull, type PortalPrincipal } from "@/portal";

import { PortalFrame } from "../portal-frame";
import { PortalTasksEmpty } from "../task-list";
import { PortalFileList } from "./file-list";

/**
 * A refused download's word, as the page draws it (`./actions.ts`). Two
 * values and no third: `rate` is the reader's own budget, `download` is
 * everything the reader may not be told the reason for.
 */
export type PortalFileError = "download" | "rate";

export const portalFileErrorOf = (raw: string | undefined): PortalFileError | undefined =>
  raw === "download" || raw === "rate" ? raw : undefined;

/**
 * `/portal/files`, AS A COMPONENT — every shared file of the contact's
 * client, minus the decision about who is asking (UI.md §4; PLAN Phase
 * 3 "read surfaces: … `Document`s/files (client-visible only, short-lived
 * signed URLs authorization-checked at issue time)").
 *
 * A component and not a page for the reason `<PortalHome>` is:
 * `/view-as/files` renders it under a synthesised principal and
 * `e2e/view-as.spec.ts` byte-compares the two. Nothing in here reaches
 * for a request context; the name comes in as a prop.
 *
 * ONE CARD PER PLACE A FILE CAN LIVE: the company's own files first —
 * a file with no project is shared with the company itself — then a
 * card per project, its name linking to the one-screen project page,
 * in the order the projection returns them (deliverables first, newest
 * version first). Inside each, `PortalFileList` groups by kind.
 *
 * ONE READ, through `portalReadOrNull`: a refusal and an empty answer
 * are the same page, byte for byte, because a reason is a fact about
 * the agency (`src/portal/render.ts`).
 *
 * THE REFUSAL BANNER IS THE ONE THING THAT MAKES THE TWO ROUTES DIFFER,
 * and only when it is there: `/portal/files?error=…` is where a refused
 * download lands, `/view-as/files` never carries one, and the byte
 * comparison is drawn on the page without it.
 */
export async function PortalFilesView({
  principal,
  name,
  error,
}: {
  principal: PortalPrincipal;
  name: string;
  error?: PortalFileError;
}) {
  const t = await getTranslations("portal.files");
  // The budget refusal is the domain error's own sentence — the one
  // `action.test.ts` requires a catalogue entry for — rather than a
  // second copy of it under this namespace (code review).
  const tDomain = await getTranslations("domainErrors");
  const refusal = error === "rate" ? tDomain("DOWNLOAD_RATE_LIMITED") : error ? t("errors.download") : null;
  const list = await portalReadOrNull("listPortalDocuments", () => listPortalDocuments(principal));
  const documents = list?.documents ?? [];

  const company = documents.filter((d) => d.project === null);
  const byProject = new Map<string, { key: string; name: string; documents: PortalDocument[] }>();
  for (const d of documents) {
    if (!d.project) continue;
    let group = byProject.get(d.project.id);
    if (!group) {
      group = { key: d.project.key, name: d.project.name, documents: [] };
      byProject.set(d.project.id, group);
    }
    group.documents.push(d);
  }

  return (
    <PortalFrame name={name} principal={principal} nav="files">
      <Page>
        <div className="flex flex-col gap-6">
          <PageHeader title={t("title")} description={t("description")} />
          {refusal ? (
            // `alert`, never `status` (UI.md §9): a refusal the reader
            // must not miss, on the plane that has no toast to carry it.
            <div data-testid="portal-file-error">
              <Callout tone="danger" role="alert">
                {refusal}
              </Callout>
            </div>
          ) : null}
          {documents.length === 0 ? (
            <PortalTasksEmpty />
          ) : (
            <>
              {list?.truncated ? <Callout tone="info">{t("truncated", { count: documents.length })}</Callout> : null}
              {company.length > 0 ? (
                <SectionCard title={t("company")} description={t("companyDescription")} contentClassName="p-0">
                  <PortalFileList documents={company} returnTo="/portal/files" />
                </SectionCard>
              ) : null}
              {[...byProject].map(([projectId, group]) => (
                <SectionCard
                  key={projectId}
                  title={
                    <Link
                      href={`/portal/projects/${group.key}`}
                      prefetch={false}
                      className="underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                      {group.name}
                    </Link>
                  }
                  contentClassName="p-0"
                >
                  <PortalFileList documents={group.documents} returnTo="/portal/files" />
                </SectionCard>
              ))}
            </>
          )}
        </div>
      </Page>
    </PortalFrame>
  );
}
