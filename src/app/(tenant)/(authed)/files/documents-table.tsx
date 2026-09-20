import { DownloadIcon, FileIcon } from "lucide-react";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";

import { DataTable, RowActions, VisibilityBadge, visibilityRowCue } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { DocumentListItem } from "@/documents/service";
import { bytesParts } from "@/lib/format";

import { deleteDocumentAction, downloadAction } from "./actions";
import { VisibilitySelect } from "./visibility-select";

/**
 * The one documents table (server component) shared by /files and the
 * client/project Files tabs.
 *
 * Visibility is SAFETY-CRITICAL here, so it is said three times over:
 * every row renders a chip (never absence) — the editable rows now
 * render the SAME chip, because `<VisibilitySelect>` is read-first —, a
 * client-visible row additionally carries the 2px warm left border from
 * visibilityRowCue(), and the table closes with a legend naming both
 * states in words. The row also emits data-visibility for E2E.
 *
 * The row's actions are one quiet ghost download icon plus a `⋯` menu.
 * Deleting a stored file used to be a solid red button that acted on
 * the first click; it is now a danger menu item that asks the question
 * in the row before anything is destroyed.
 *
 * Sizes are split into value and unit so the digits right-align on
 * their own rail while "kB"/"MB" stays quiet beside them.
 */
export async function DocumentsTable({
  documents,
  returnTo,
  canDelete,
  canChangeVisibility,
}: {
  documents: DocumentListItem[];
  returnTo: string;
  canDelete: boolean;
  canChangeVisibility: boolean;
}) {
  const t = await getTranslations("files");
  const tCommon = await getTranslations("common");
  const format = await getFormatter();
  const locale = await getLocale();

  return (
    <div className="flex flex-col gap-2">
      <DataTable scrollLabel={t("tableLabel")}>
        <Table>
          <TableHeader>
            <TableRow>
              {/* EVERY COLUMN BUT THE NAME CARRIES ITS OWN WIDTH, which is
                  the other half of containing the name cell below and was
                  learnt the same day. Chromium hands a table's spare width
                  to the columns WITHOUT a specified one, in proportion to
                  their max-content — and a contained cell's max-content is
                  zero. So containment alone inverted the intent: at a
                  1134px box the filename took 166px while the visibility
                  badge, which has two possible values and needs neither,
                  took 370. These four widths are UNDER each column's own
                  min-content (the eyebrow face is 11px, so 18ch is ~99px
                  against a visibility column that cannot go below ~178),
                  so they never shrink anything and the safety-critical
                  badge cannot be squeezed by them — they only stop those
                  columns claiming slack, leaving the name as the sole
                  absorber. Measured: 101px of name at a 356px box and 622
                  at 1134, where containment alone gave it 166.
                  NOT a pattern borrowed from `/clients`, which declares
                  five bare heads and deliberately lets the slack SPREAD
                  across all of them — that works there because its columns
                  are evenly sized. It cannot work here: one column holds a
                  two-value badge with a ~178px min-content and would take
                  the lot. `/projects` reaches the same end by a third
                  road again (`table-fixed`). Three tables, three answers,
                  each measured. */}
              <TableHead>{t("columns.name")}</TableHead>
              <TableHead className="w-[18ch]">{t("columns.visibility")}</TableHead>
              <TableHead priority="medium" className="w-[10ch] text-right">
                {t("columns.size")}
              </TableHead>
              <TableHead priority="low" className="w-[10ch] text-right">
                {t("columns.versions")}
              </TableHead>
              <TableHead priority="low" className="w-[14ch]">{t("columns.updated")}</TableHead>
              <TableHead pinned className="w-0 text-right">
                <span className="sr-only">{tCommon("actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {documents.map((d) => {
              const size = bytesParts(locale, d.sizeBytes);
              const download = t("downloadName", { name: d.name });
              return (
                <TableRow
                  key={d.id}
                  data-visibility={d.visibility}
                  className={visibilityRowCue(d.visibility)}
                >
                  {/* THE NAME COLUMN IS THE ONE THAT YIELDS, and since
                      2026-09-20 it yields by CONTAINMENT rather than by a
                      per-viewport cap. `max-w-28 sm:max-w-64` was here to
                      stop an untruncated filename pushing the download and
                      the ⋯ off a 390px screen — the one thing a row of
                      files exists to offer — and it did that, but a
                      max-width on a table CELL is a FLOOR in Chromium
                      (slice 28): it clamps the column's MIN-content
                      contribution as well as its max-content one, so this
                      column could not go below 112px however little room
                      was left. Measured LOCALLY at a 356px box: name 112 +
                      visibility 178 + the pinned actions 76 = 366, an 11px
                      scroll. CI measured 14px in Swedish and 6 in English,
                      because the runner renders these strings 3-4px wider
                      — the same platform gap every number in this repo
                      carries, and the reason the ratchets hold CI's.
                      VISIBILITY IS NOT THE ONE TO CUT even though it is
                      the widest: it is safety-critical (UI.md §10.4), it
                      carries all five channels of the badge, and a phone
                      that truncated "Privat för teamet" or dropped the
                      column to a rung would be the exact failure this
                      product cannot have. So the name column takes the
                      remainder instead — 101px at a 356px box, where the
                      cap gave it 112 and cost the table a scroll — and
                      truncates inside it, which is what the cap was
                      approximating all along. UI.md §10.12 listed these
                      viewport-scoped caps as an ACCEPTED EXCEPTION; this
                      is one of them retired.
                      FIVE REM, and it never binds on any of the three LIST
                      pages: the remainder is 101px at the narrowest box
                      locally and ~98 on CI, so the floor keeps ~18px of
                      headroom there and exists only to stop a filename
                      vanishing if the other two ever grow — an icon and
                      about five characters, which is identity and not much
                      else.
                      THE FIFTH CALL SITE IS NOT FIXED BY THIS, and saying
                      so is the point (review). The item panel renders this
                      same table inside a peek capped at `max-w-[85vw]`,
                      which at 390px is a box near 298 — narrower than any
                      rung, and narrower than this table's own minimum of
                      80 + 178 + 76 = 334. It cannot fit: the badge is the
                      one thing that must not yield, so what is left there
                      is a scroll UNDER the pinned actions column, which is
                      exactly the trade the pin exists to make (UI.md
                      §10.12) — the verbs stay reachable however far it
                      goes. This change improves it (366 → 334) without
                      closing it. Nothing measures it either: the walk's
                      `project-item-peek` stop shows the EMPTY attachments
                      state, because the seed attaches no document to a
                      work item. Seeding one would put the peek's
                      attachments under the ratchet for the first time —
                      worth a slice, not worth smuggling into this one. */}
                  <TableCell className="min-w-20">
                    <span className="flex w-full min-w-0 items-center gap-2 contain-inline-size">
                      <FileIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate font-medium" title={d.name}>
                        {d.name}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell>
                    {canChangeVisibility && d.clientId ? (
                      <VisibilitySelect
                        documentId={d.id}
                        value={d.visibility}
                        returnTo={returnTo}
                      />
                    ) : (
                      <VisibilityBadge value={d.visibility} />
                    )}
                  </TableCell>
                  <TableCell priority="medium" className="num text-right whitespace-nowrap">
                    {size.value}
                    <span className="ml-1 text-muted-foreground">{size.unit}</span>
                  </TableCell>
                  <TableCell priority="low" className="num text-right">
                    {d.versionCount}
                  </TableCell>
                  <TableCell priority="low" className="num text-muted-foreground">
                    {format.dateTime(d.updatedAt, { dateStyle: "medium" })}
                  </TableCell>
                  <TableCell pinned>
                    {/* A real form, so the presigned redirect still happens
                        on the server. */}
                    {canDelete ? (
                      <RowActions
                        label={tCommon("actionsFor", { name: d.name })}
                        primary={<DownloadButton id={d.id} returnTo={returnTo} label={download} />}
                        items={[
                          {
                            key: "delete",
                            label: t("delete"),
                            // No `icon`: this is a SERVER component, and a
                            // lucide icon is a plain function there — passing
                            // one across the RSC boundary to <RowActions>
                            // would fail to serialise at render time.
                            tone: "danger",
                            confirm: t("deleteConfirm", { name: d.name }),
                            formAction: deleteDocumentAction,
                            hidden: [
                              { name: "documentId", value: d.id },
                              { name: "returnTo", value: returnTo },
                            ],
                          },
                        ]}
                      />
                    ) : (
                      // No menu rather than an always-disabled one: a
                      // control that can never act is noise in every row.
                      <div
                        data-slot="row-actions"
                        className="flex items-center justify-end gap-1"
                      >
                        <DownloadButton id={d.id} returnTo={returnTo} label={download} />
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </DataTable>
      {/* The legend is part of the safety system, not decoration: it names
          both states in words, next to the exact chips the rows wear. It
          sits OUTSIDE the table's hairline — inside it, at cell padding,
          it read as a malformed third row. */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-2">
          <VisibilityBadge value="INTERNAL" size="sm" />
          {t("legend.internal")}
        </span>
        <span className="inline-flex items-center gap-2">
          <VisibilityBadge value="CLIENT_VISIBLE" size="sm" />
          {t("legend.clientVisible")}
        </span>
      </div>
    </div>
  );
}

/** The row's one everyday verb: a 28px ghost icon whose tooltip is its label. */
function DownloadButton({ id, returnTo, label }: { id: string; returnTo: string; label: string }) {
  return (
    <form action={downloadAction}>
      <input type="hidden" name="documentId" value={id} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button type="submit" variant="ghost" size="icon-sm" aria-label={label}>
            <DownloadIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </form>
  );
}
