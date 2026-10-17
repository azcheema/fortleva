import { CircleAlertIcon } from "lucide-react";
import Link from "next/link";

import { EntityTile, StatusBadge } from "@/components/semantic";
import type { ProjectStatus } from "@/generated/prisma/enums";
import { entityStyle } from "@/lib/entity-color";
import type { BarGeometry } from "@/lib/lineup-plan";
import { cn } from "@/lib/utils";

/**
 * ALL PROJECTS ON ONE TIMELINE — the chart (slice 130; founder decision C107
 * (d) — design §3.6). Plain HTML on tokens, server-rendered and no directive,
 * the `BarList` precedent: every position arrives as a percentage the page
 * computed (`lineup-plan.ts`), every word already formatted.
 *
 * THE ROW'S LABEL IS ITS CONTENT. The label is a link to the project whose
 * name carries the dates and the milestones in words for a screen reader, and
 * the client, the dates, the status and "Launch date passed" are visible text
 * beside it. The track is a picture of the same facts: the bar — in the
 * project's identity colour, 12 px, rounded at a data end and square where the
 * window cuts it — is a second link to the same page for a mouse, out of the
 * tab order and hidden from assistive technology; a milestone is a 10 px dot
 * with a 2 px ring of the surface, FILLED when done and HOLLOW when not (shape,
 * not colour, says which); the today line crosses every row. Each mark carries
 * its words in `title` for a pointer. The legend under the chart names the
 * three marks.
 *
 * On a phone the label stacks over the track, so the 13 weeks keep the full
 * width and nothing scrolls sideways.
 */

export type LineupMark = {
  readonly id: string;
  /** Percent of the track. */
  readonly left: number;
  readonly done: boolean;
  readonly title: string;
};

export type LineupRow = {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly href: string;
  readonly clientName: string;
  /** "1 Sep – 30 Nov" — visible beside the name. */
  readonly datesText: string;
  /** Everything the track draws, in words: the dates and the milestones. */
  readonly srText: string;
  readonly status: ProjectStatus;
  readonly late: boolean;
  readonly bar: BarGeometry;
  readonly barTitle: string;
  /** For a bar wholly outside the window: "← launch 3 Mar" or "starts 4 Jun →". */
  readonly edgeText: string | null;
  readonly milestones: readonly LineupMark[];
};

export function ProjectLineup({
  label,
  rows,
  months,
  weekLines,
  today,
  lateLabel,
  legend,
}: {
  /** From t(): what the list is, for a screen reader. */
  label: string;
  rows: readonly LineupRow[];
  /** The month names over the track, each at its first day's offset. */
  months: readonly { readonly key: string; readonly left: number; readonly text: string }[];
  /** Where each week after the first begins. */
  weekLines: readonly number[];
  /** Today's offset, or null when today is outside the window. */
  today: { readonly left: number; readonly title: string } | null;
  lateLabel: string;
  legend: { readonly today: string; readonly done: string; readonly open: string };
}) {
  const track = (children: React.ReactNode, className?: string) => (
    <div className={cn("relative min-w-0 flex-1", className)}>
      {weekLines.map((left) => (
        <span key={left} aria-hidden="true" className="absolute inset-y-0 w-px bg-border" style={{ left: `${left}%` }} />
      ))}
      {today ? (
        <span
          aria-hidden="true"
          title={today.title}
          className="absolute inset-y-0 z-10 w-0.5 -translate-x-1/2 bg-primary"
          style={{ left: `${today.left}%` }}
        />
      ) : null}
      {children}
    </div>
  );

  return (
    <div data-slot="project-lineup" data-testid="projects-lineup" className="flex flex-col">
      {/* The month names, over the track only. */}
      <div aria-hidden="true" className="flex border-b border-border px-4">
        <div className="hidden md:block md:w-64 md:shrink-0" />
        {track(
          months.map((m) => (
            <span
              key={m.key}
              className="absolute top-1/2 -translate-y-1/2 pl-1 text-xs whitespace-nowrap text-muted-foreground"
              style={{ left: `${m.left}%` }}
            >
              {m.text}
            </span>
          )),
          "h-8",
        )}
      </div>

      <ul aria-label={label} className="flex flex-col">
        {rows.map((row) => (
          <li
            key={row.id}
            data-testid="lineup-row"
            data-project-key={row.key}
            className="flex flex-col gap-1 border-b border-border px-4 py-2 md:flex-row md:items-center md:gap-0"
          >
            <div className="flex min-w-0 flex-col md:w-64 md:shrink-0 md:pr-3">
              <Link
                href={row.href}
                className="flex min-w-0 items-center gap-2 rounded-sm text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                <EntityTile id={row.id} name={row.name} />
                <span className="num-id shrink-0 font-mono text-xs text-muted-foreground">{row.key}</span>
                <span className="min-w-0 truncate" title={row.name}>
                  {row.name}
                </span>
                <span className="sr-only">{row.srText}</span>
              </Link>
              <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <span className="min-w-0 truncate" title={row.clientName}>
                  {row.clientName}
                </span>
                <span className="num whitespace-nowrap">{row.datesText}</span>
                {row.status !== "ACTIVE" ? <StatusBadge domain="projectStatus" value={row.status} /> : null}
                {row.late ? (
                  <span className="inline-flex items-center gap-1 whitespace-nowrap text-(--tone-danger-fg)" data-testid="lineup-late">
                    <CircleAlertIcon aria-hidden="true" className="size-3.5" />
                    {lateLabel}
                  </span>
                ) : null}
              </span>
            </div>
            {track(
              <>
                {row.bar.kind === "inside" ? (
                  <Link
                    href={row.href}
                    tabIndex={-1}
                    aria-hidden="true"
                    title={row.barTitle}
                    data-testid="lineup-bar"
                    className={cn(
                      "absolute top-1/2 h-3 -translate-y-1/2 bg-(--entity) hover:brightness-110",
                      !row.bar.cutStart && "rounded-l-sm",
                      !row.bar.cutEnd && "rounded-r-sm",
                      row.status === "PAUSED" && "opacity-50",
                    )}
                    style={{ ...entityStyle(row.id, row.name), left: `${row.bar.left}%`, width: `${row.bar.width}%` }}
                  />
                ) : row.edgeText ? (
                  <span
                    aria-hidden="true"
                    className={cn(
                      "absolute top-1/2 -translate-y-1/2 text-xs whitespace-nowrap text-muted-foreground",
                      row.bar.kind === "before" ? "left-1" : "right-1",
                    )}
                  >
                    {row.edgeText}
                  </span>
                ) : null}
                {row.milestones.map((m) => (
                  <span
                    key={m.id}
                    aria-hidden="true"
                    title={m.title}
                    data-testid="lineup-milestone"
                    data-done={m.done ? "" : undefined}
                    className={cn(
                      "absolute top-1/2 z-20 size-2.5 -translate-1/2 rounded-full ring-2 ring-card",
                      m.done ? "bg-foreground" : "border-2 border-foreground bg-card",
                    )}
                    style={{ left: `${m.left}%` }}
                  />
                ))}
              </>,
              "h-8",
            )}
          </li>
        ))}
      </ul>

      {/* The three marks, named — never a colour or a shape alone. */}
      <div aria-hidden="true" className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-0.5 bg-primary" />
          {legend.today}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-full bg-foreground" />
          {legend.done}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2.5 rounded-full border-2 border-foreground" />
          {legend.open}
        </span>
      </div>
    </div>
  );
}
