import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";

import { HealthChip, StatusIcon, Timeline, TimelineItem } from "@/components/semantic";
import { STATUS_MAP } from "@/lib/enum-map";
import { formatDate, formatDay } from "@/lib/format";
import type { PortalTimelineEntry } from "@/modules/work";

/**
 * THE CLIENT TIMELINE, DRAWN (Phase 3, DATA_MODEL §6.16; UI.md §4 item
 * 4 and §10.15 pattern 3). One dated rail — the same `Timeline` the
 * member's own Timeline tab uses, so the two planes share a silhouette —
 * newest first, with anything still to come above everything that has
 * happened.
 *
 * FOUR KINDS OF ENTRY, and the node says which before any hue is read:
 * a published update wears its health's own glyph and tone, a reached
 * milestone the filled success check, a shipped version the filled
 * package, and a milestone still due the outlined dashed circle — open,
 * like the milestone it stands for. Filled means it happened; outlined
 * means it is the plan. That is the whole vocabulary, and it is the
 * member Timeline's vocabulary too (`STATUS_MAP.milestoneStatus`,
 * `versionStatus`), so a client who is ever shown the agency's screen
 * recognises it.
 *
 * WHAT A ROW SAYS: a name (or the post's title, or "Update #4" when it
 * has none), then one dated sentence — published, reached, due,
 * released. Release notes, when the agency wrote any, follow as prose.
 * Nothing else: no author, no status word on an open milestone (the
 * projection does not carry one — `listPortalTimeline`), no link into
 * the agency's own application. A post links to the project's updates
 * page, where the same card the `/portal` home draws renders it whole.
 *
 * Rendered on both planes — a real contact session and View-as — from
 * the same props, and the `data-*` hooks below are what
 * `e2e/portal-project.spec.ts` reads, so they too are drawn alike.
 */
export function PortalTimeline({
  entries,
  projectKey,
}: {
  entries: readonly PortalTimelineEntry[];
  projectKey: string;
}) {
  return (
    <Timeline>
      {entries.map((entry, i) => (
        <TimelineEntry key={`${entry.kind}-${entry.id}`} entry={entry} projectKey={projectKey} last={i === entries.length - 1} />
      ))}
    </Timeline>
  );
}

function TimelineEntry({
  entry,
  projectKey,
  last,
}: {
  entry: PortalTimelineEntry;
  projectKey: string;
  last: boolean;
}) {
  const t = useTranslations("portal.timeline");
  const locale = useLocale();
  const when = formatDate(locale, entry.at);

  switch (entry.kind) {
    case "update": {
      const spec = STATUS_MAP.projectHealth[entry.health];
      return (
        <TimelineItem
          node={<StatusIcon name={spec.icon} className="size-3.5" />}
          tone={spec.tone}
          filled
          last={last}
          contentClassName="flex flex-col gap-1"
        >
          <div data-slot="portal-event" data-kind={entry.kind} className="flex flex-col gap-1">
            <span className="flex flex-wrap items-center gap-2">
              <Link
                href={`/portal/projects/${projectKey}/updates#update-${entry.id}`}
                // No prefetch: this component also renders on the member
                // plane (View-as, the Portal tab), where a prefetch of a
                // portal-gated route with a member cookie is a redirect
                // to the client sign-in page on every render.
                prefetch={false}
                className="text-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {entry.title ?? t("updateNumber", { seq: entry.seq })}
              </Link>
              <HealthChip value={entry.health} />
            </span>
            <span className="text-xs text-muted-foreground">
              {entry.title ? `${t("updateNumber", { seq: entry.seq })} · ` : null}
              {t("published", { date: when })}
            </span>
          </div>
        </TimelineItem>
      );
    }
    case "milestone_done": {
      const spec = STATUS_MAP.milestoneStatus.DONE;
      return (
        <TimelineItem
          node={<StatusIcon name={spec.icon} className="size-3.5" />}
          tone={spec.tone}
          filled
          last={last}
          contentClassName="flex flex-col gap-1"
        >
          <div data-slot="portal-event" data-kind={entry.kind} className="flex flex-col gap-1">
            <span className="text-sm font-medium text-foreground">{entry.name}</span>
            <span className="text-xs text-muted-foreground">{t("milestoneReached", { date: when })}</span>
          </div>
        </TimelineItem>
      );
    }
    case "milestone_due": {
      const spec = STATUS_MAP.milestoneStatus.PLANNED;
      return (
        <TimelineItem
          node={<StatusIcon name={spec.icon} className="size-3.5" />}
          tone={spec.tone}
          last={last}
          contentClassName="flex flex-col gap-1"
        >
          <div data-slot="portal-event" data-kind={entry.kind} className="flex flex-col gap-1">
            <span className="text-sm font-medium text-foreground">{entry.name}</span>
            {/* A due date is a DAY encoded as UTC midnight — `formatDay`,
                as the task list's target date; the other three kinds are
                instants and take `formatDate` above. */}
            <span className="text-xs text-muted-foreground">
              {t("milestoneDue", { date: formatDay(locale, entry.at) })}
            </span>
          </div>
        </TimelineItem>
      );
    }
    case "version_shipped": {
      const spec = STATUS_MAP.versionStatus.SHIPPED;
      return (
        <TimelineItem
          node={<StatusIcon name={spec.icon} className="size-3.5" />}
          tone={spec.tone}
          filled
          last={last}
          contentClassName="flex flex-col gap-1"
        >
          <div data-slot="portal-event" data-kind={entry.kind} className="flex flex-col gap-1">
            <span className="text-sm font-medium text-foreground">
              {t("version", { version: entry.version })}
              {entry.title ? ` · ${entry.title}` : null}
            </span>
            <span className="text-xs text-muted-foreground">{t("released", { date: when })}</span>
            {entry.releaseNotes ? (
              <p className="text-sm whitespace-pre-wrap text-muted-foreground">{entry.releaseNotes}</p>
            ) : null}
          </div>
        </TimelineItem>
      );
    }
  }
}
