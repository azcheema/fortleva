import Link from "next/link";
import { useFormatter, useLocale, useTranslations } from "next-intl";

import { HealthChip, StatusIcon, Timeline, TimelineItem } from "@/components/semantic";
import { STATUS_MAP } from "@/lib/enum-map";
import { formatDay } from "@/lib/format";
import type { PortalTimelineEntry } from "@/modules/work";

import { signOffKey, versionAnchor } from "@/portal/signoff-vocabulary";

import { PortalSignOff } from "../../sign-off";

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
  // An instant, in the REQUEST's zone — the same one `UpdateView` prints a
  // post's "Published" in, so the rail and the card under it cannot name
  // two days for one post (`formatDate` would use the process's zone).
  const format = useFormatter();
  const when = format.dateTime(entry.at, { year: "numeric", month: "short", day: "numeric" });

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
                as the task list's target date; the other kinds are
                instants and take the request-zone `when` above. */}
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
          <div
            id={versionAnchor(entry.id)}
            data-slot="portal-event"
            data-kind={entry.kind}
            className="flex scroll-mt-16 flex-col gap-1"
          >
            <span className="text-sm font-medium text-foreground">
              {t("version", { version: entry.version })}
              {entry.title ? ` · ${entry.title}` : null}
            </span>
            <span className="text-xs text-muted-foreground">{t("released", { date: when })}</span>
            {entry.releaseNotes ? (
              <p className="text-sm whitespace-pre-wrap text-muted-foreground">{entry.releaseNotes}</p>
            ) : null}
            {/* THE SIGN-OFF CONTROL, on the entry the ask is about (PLAN
                §0: "on a `version_shipped` rail entry"). Offered only
                where it would work — `canDecide` is the projection's
                boolean about the reader — and drawn as the standing
                decision otherwise. The decision ALSO gets an entry of
                its own above (`approval_decided`), dated by the day it
                was made; this line is the version's own state. */}
            <PortalSignOff
              key={signOffKey(entry.id, entry.approval)}
              subject="version"
              id={entry.id}
              status={entry.approval.status}
              decidedAt={entry.approval.decidedAt?.toISOString() ?? null}
              note={entry.approval.note}
              canDecide={entry.approval.canDecide}
            />
          </div>
        </TimelineItem>
      );
    }
    case "approval_decided": {
      // THE CLIENT'S OWN ANSWER, as an event: the approval map's glyph
      // and tone (`STATUS_MAP.approvalStatus` — success check, danger
      // undo), filled, because it happened. It names the version or the
      // file and, for a file, which version of it the ask was about; the
      // note is quoted, because it is the client's words read back.
      const spec = STATUS_MAP.approvalStatus[entry.outcome];
      const approved = entry.outcome === "APPROVED";
      const label =
        entry.subject === "version"
          ? approved
            ? t("versionApproved", { version: entry.label })
            : t("versionChanges", { version: entry.label })
          : approved
            ? t("deliverableApproved", { name: entry.label, number: entry.versionNumber ?? 0 })
            : t("deliverableChanges", { name: entry.label, number: entry.versionNumber ?? 0 });
      return (
        <TimelineItem
          node={<StatusIcon name={spec.icon} className="size-3.5" />}
          tone={spec.tone}
          filled
          last={last}
          contentClassName="flex flex-col gap-1"
        >
          <div
            data-slot="portal-event"
            data-kind={entry.kind}
            data-subject={entry.subject}
            data-outcome={entry.outcome}
            className="flex flex-col gap-1"
          >
            <span className="text-sm font-medium text-foreground">{label}</span>
            <span className="text-xs text-muted-foreground">{t("decided", { date: when })}</span>
            {entry.note ? <q className="text-sm whitespace-pre-wrap text-muted-foreground">{entry.note}</q> : null}
          </div>
        </TimelineItem>
      );
    }
    case "document_version": {
      // A DELIVERED FILE (the portal files slice): the filled file-check,
      // brand tone — it happened, and it is the agency's output rather
      // than a plan or a post. One entry per version, so "v2" reads as
      // its own event above "v1". No download here: the rail says what
      // was delivered and when; the files section below it is where the
      // newest version is fetched from, so a client cannot click a "v1"
      // entry and receive v2.
      return (
        <TimelineItem
          node={<StatusIcon name="file-check" className="size-3.5" />}
          tone="brand"
          filled
          last={last}
          contentClassName="flex flex-col gap-1"
        >
          <div
            data-slot="portal-event"
            data-kind={entry.kind}
            data-document-kind={entry.documentKind}
            className="flex flex-col gap-1"
          >
            <span className="text-sm font-medium text-foreground">
              {entry.documentKind === "DELIVERABLE"
                ? t("deliverable", { name: entry.name })
                : t("report", { name: entry.name })}
            </span>
            <span className="text-xs text-muted-foreground">
              {t("fileVersion", { number: entry.versionNumber })} · {t("shared", { date: when })}
            </span>
          </div>
        </TimelineItem>
      );
    }
  }
}
