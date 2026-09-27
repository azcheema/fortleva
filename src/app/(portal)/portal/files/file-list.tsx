import { DownloadIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { PORTAL_DOCUMENT_KINDS, type PortalDocument } from "@/documents/portal";
import { formatBytes, formatDate } from "@/lib/format";

import { fileAnchor, signOffKey } from "@/portal/signoff-vocabulary";

import { PortalSignOff } from "../sign-off";
import { downloadDocumentAction } from "./actions";

/**
 * THE SHARED FILES, AS A LIST — one implementation for `/portal/files`
 * (a card per project, and one for the company's own files) and for
 * the one-screen project page's "Files & deliverables" section (UI.md
 * §4 item 6). Grouped by KIND in the projection's fixed order —
 * deliverables, then reports, then everything else — under a small
 * heading each, so a client reads down the same few headings on every
 * card; a kind with nothing in it is absent, not drawn empty.
 *
 * WHAT A ROW SAYS: the name, then one line of facts — which version,
 * how big, when it was shared — and the download. On a DELIVERABLE,
 * since the sign-off slice, the ask to sign it off: the approve /
 * request-changes control where the reader may answer, the state in
 * words otherwise, and the decision with the version it was about once
 * one stands (UI.md §4 item 6's other half). Nothing else: no uploader,
 * no tags, no visibility badge (on this plane everything is by
 * definition visible).
 *
 * THE DOWNLOAD IS A FORM POST, NOT A LINK, for the reason the member
 * plane's `DownloadButton` is: the action mints a short-lived off-origin
 * URL and writes the `file.downloaded` audit row on the way, and Next
 * PREFETCHES `<Link>`s in production — a GET that downloaded would audit
 * a download every time a mouse crossed it. The form carries the
 * document's id (which names WHICH row to look for and never widens what
 * is reachable — `resolvePortalDownload` re-derives every identifying
 * term from the principal) and where to land on a refusal.
 *
 * TWO CONSUMERS ON TWO PLANES, so this reaches for no request context
 * (`task-list.tsx`'s rule): `/view-as/files` and the View-as project
 * page render it under a MEMBER session, inside `inert`, where the
 * form is a form that cannot be submitted — look, don't touch.
 */
export function PortalFileList({
  documents,
  returnTo,
}: {
  documents: readonly PortalDocument[];
  /** Where a refused download lands, with `?error=` — the page this list is on. */
  returnTo: string;
}) {
  const t = useTranslations("portal.files");
  const locale = useLocale();
  const groups = PORTAL_DOCUMENT_KINDS.map((kind) => ({
    kind,
    documents: documents.filter((d) => d.kind === kind),
  })).filter((g) => g.documents.length > 0);

  return (
    <div className="divide-y divide-border">
      {groups.map(({ kind, documents: rows }) => (
        <section key={kind} data-slot="portal-file-group" data-kind={kind} className="p-4">
          <h3 className="eyebrow mb-2 text-muted-foreground">{t(`kinds.${kind}`)}</h3>
          <ul className="flex flex-col gap-3">
            {rows.map((d) => (
              <li
                key={d.id}
                id={fileAnchor(d.id)}
                data-slot="portal-file"
                data-kind={d.kind}
                className="flex scroll-mt-16 flex-wrap items-center justify-between gap-x-4 gap-y-1"
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-sm font-medium text-foreground" title={d.name}>
                    {d.name}
                  </span>
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                    <span>{t("version", { number: d.version.number })}</span>
                    <span className="num">{formatBytes(locale, d.version.sizeBytes)}</span>
                    <span>{t("shared", { date: formatDate(locale, d.version.at) })}</span>
                  </span>
                  {/* THE ASK, on the deliverable it is about. The version
                      the ask names is printed beside the state when it is
                      not the newest one above — a decision stands on the
                      bytes the client saw, and a later upload does not
                      move it (DATA_MODEL §6.8). */}
                  {d.approval && d.approval.status !== "NOT_REQUESTED" ? (
                    <span className="flex flex-col gap-0.5 pt-1">
                      {d.approval.versionNumber !== null && d.approval.versionNumber !== d.version.number ? (
                        <span className="text-2xs text-muted-foreground">
                          {t("approvalVersion", { number: d.approval.versionNumber })}
                        </span>
                      ) : null}
                      <PortalSignOff
                        key={signOffKey(d.id, d.approval)}
                        subject="deliverable"
                        id={d.id}
                        status={d.approval.status}
                        decidedAt={d.approval.decidedAt?.toISOString() ?? null}
                        note={d.approval.note}
                        canDecide={d.approval.canDecide}
                      />
                    </span>
                  ) : null}
                </span>
                <form action={downloadDocumentAction} className="shrink-0">
                  <input type="hidden" name="documentId" value={d.id} />
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <Button type="submit" variant="outline" size="sm" aria-label={t("downloadName", { name: d.name })}>
                    <DownloadIcon aria-hidden="true" />
                    {t("download")}
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
