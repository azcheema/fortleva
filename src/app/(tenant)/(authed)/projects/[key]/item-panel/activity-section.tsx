import {
  CalendarIcon,
  ClockIcon,
  FileTextIcon,
  type LucideIcon,
  MessageSquareIcon,
  PencilIcon,
  PencilLineIcon,
  PlusIcon,
  UserRoundIcon,
} from "lucide-react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";

import { RelativeTime } from "@/components/relative-time";
import {
  EmptyState,
  PriorityGlyph,
  SectionCard,
  StatusIcon,
  Timeline,
  TimelineItem,
  VisibilityBadge,
  VisibilityIcon,
  visibilityLabelKey,
  visibilityRowCue,
} from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { STATUS_MAP, type StatusValue } from "@/lib/enum-map";
import { formatDay, formatDuration, type DurationStyle } from "@/lib/format";
import type { Tone } from "@/lib/tones";
import { workViewHref } from "@/lib/work-view";
import type { ActivityEntry, ItemActivityPage, ResolvedWorkflowState } from "@/modules/work";

import {
  activitySentence,
  isPriority,
  isVisibility,
  type ActivityLookups,
  type ActivitySentence,
} from "./activity-copy";

/**
 * The item panel's Activity section (UI.md §5.4, slice 8): the item's
 * field history on the one dated rail (§10.15), newest first, one page
 * at a time. Each row is WHO, WHAT (activity-copy.ts) and WHEN — the
 * relative time §8 reserves for activity — with the row's own
 * visibility chip, because a history row is a class-B row like any
 * other and absence of a chip is not a state (§10.4). The chip is the
 * row's visibility NOW — what the portal would show — not a record of
 * what the client was once shown: making the item private flips its
 * client-visible rows INTERNAL in the database and nothing flips them
 * back on a re-share, exactly as the item's own chip forgets, so the
 * two chips always agree.
 *
 * The page is the one `getItemDetail` read, so this section can never
 * show history for an item the panel refused. Older pages are LINKS on
 * the full page (`?before=<row id>`, the inbox's keyset), and a page
 * past the end is its own state whose verb is back to the latest —
 * "No activity yet" there would tell a member with a long history that
 * there is none.
 */

type Category = StatusValue<"stateCategory">;

const isCategory = (v: string | null): v is Category =>
  v !== null && Object.hasOwn(STATUS_MAP.stateCategory, v);

/**
 * The node glyph is the FIELD (never a bare dot — the rail's rule); the
 * three fields whose VALUE has a glyph of its own draw that instead, so
 * a Done row reads as done in greyscale exactly as it does on the board.
 */
const FIELD_ICON: Record<string, LucideIcon> = {
  created: PlusIcon,
  title: PencilLineIcon,
  description: FileTextIcon,
  estimate: ClockIcon,
  targetDate: CalendarIcon,
  assignee: UserRoundIcon,
  comment: MessageSquareIcon,
  commentVisibility: MessageSquareIcon,
};
const GLYPH = "size-3";

function nodeFor(row: ActivityEntry): { node: React.ReactNode; tone?: Tone; filled?: boolean } {
  switch (row.field) {
    case "stateCategory":
      if (isCategory(row.newValue)) {
        const spec = STATUS_MAP.stateCategory[row.newValue];
        return {
          node: <StatusIcon name={spec.icon} className={GLYPH} />,
          tone: spec.tone,
          filled: row.newValue === "DONE",
        };
      }
      break;
    case "priority":
      // NONE draws three faint dashes, which read as a bare dot at 12px;
      // the pencil says "changed" instead, and the sentence says to what.
      if (isPriority(row.newValue) && row.newValue !== "NONE") return { node: <PriorityGlyph value={row.newValue} /> };
      break;
    case "visibility":
      if (isVisibility(row.newValue)) return { node: <VisibilityIcon value={row.newValue} /> };
      break;
  }
  const Icon = FIELD_ICON[row.field] ?? PencilIcon;
  return { node: <Icon aria-hidden="true" className={GLYPH} /> };
}

/**
 * "changed “<property>”": the catalogue's own label for a field the
 * sentence builder had no words for (a slice yet to arrive, or a value
 * its parsers refused), quoted because the labels are title-case nouns
 * ("Due date", "Part of") — so a person reads changed “Due date” and
 * never a column name. A field with no label yet names itself.
 */
const PROPERTY_LABEL = {
  stateCategory: "state",
  assignee: "assignee",
  priority: "priority",
  estimate: "estimate",
  startDate: "startDate",
  targetDate: "dueDate",
  visibility: "visibility",
  parentId: "parent",
  milestoneId: "milestone",
} as const;
type PropertyLabelKey = (typeof PROPERTY_LABEL)[keyof typeof PROPERTY_LABEL];
const propertyLabelKey = (field: string): PropertyLabelKey | null =>
  Object.hasOwn(PROPERTY_LABEL, field) ? PROPERTY_LABEL[field as keyof typeof PROPERTY_LABEL] : null;

export async function ActivitySection({
  activity,
  pageHref,
  states,
  durationStyle,
}: {
  activity: ItemActivityPage;
  /** The full item page, bare (no query) — where older pages live, whichever surface renders this. */
  pageHref: string;
  /** The project's states, names resolved: a state ref renders as its name here. */
  states: readonly ResolvedWorkflowState[];
  durationStyle: DurationStyle;
}) {
  const [t, tCommon, tProps, tCat, tPriority, tVis, locale] = await Promise.all([
    getTranslations("projects.item.activity"),
    getTranslations("common"),
    getTranslations("projects.item.properties"),
    getTranslations("states.stateCategory"),
    getTranslations("states.priority"),
    getTranslations("visibility"),
    getLocale(),
  ]);
  // The instant every relative time on this render is measured from,
  // taken AFTER the read. A row stamped by another process's clock can
  // still be ahead of it; `RelativeTime` clamps that to "now".
  const serverNow = new Date().toISOString();

  const stateById = new Map(states.map((s) => [s.id, s]));
  const look: ActivityLookups = {
    stateName: (ref, category) => {
      const state = ref ? stateById.get(ref) : undefined;
      if (state) return state.name;
      // The state is gone (a workflow edit): the category the row
      // carries is still true, and it is what the portal reads anyway.
      return isCategory(category) ? tCat(category) : (category ?? tCommon("unknown"));
    },
    priority: (v) => tPriority(v),
    // @db.Date semantics: "YYYY-MM-DD" is UTC midnight and formatDay
    // formats in UTC, so the day never shifts west of Greenwich.
    day: (iso) => formatDay(locale, new Date(iso)),
    duration: (m) => formatDuration(locale, m, durationStyle),
    visibility: (v) => tVis(visibilityLabelKey(v)),
    member: (name) => name ?? tCommon("unknown"),
  };

  // Sixteen sentences in five shapes — next-intl types the ICU arguments
  // per key, and every key in a group takes the same ones.
  const say = (s: ActivitySentence): string => {
    switch (s.key) {
      case "created":
      case "descriptionEdited":
      case "commented":
      case "commentEdited":
      case "commentDeleted":
        return t(s.key);
      case "titleChanged":
      case "priorityChanged":
      case "estimateChanged":
      case "dueDateChanged":
      case "reassigned":
      case "stateChanged":
        return t(s.key, { from: s.from, to: s.to });
      case "estimateSet":
      case "dueDateSet":
      case "assigned":
      case "visibilityChanged":
      case "commentVisibilityChanged":
        return t(s.key, { to: s.to });
      case "estimateCleared":
      case "dueDateCleared":
      case "unassigned":
        return t(s.key, { from: s.from });
      case "fieldChanged": {
        const key = propertyLabelKey(s.field);
        return t("fieldChanged", { field: key ? tProps(key) : s.field });
      }
    }
  };

  // Who: the resolved name; an id that no longer resolves is "Unknown";
  // a row that names nobody at all (an import, a job) is the system.
  const who = (row: ActivityEntry): string =>
    row.actor.name ?? (row.actor.kind === "system" ? t("system") : tCommon("unknown"));

  // Whether a `?before=` cursor built this page is the SERVICE's answer
  // (`before` is null unless the cursor was one of this item's rows), so
  // the "Latest" link and the past-the-end state can never disagree with
  // the rows.
  const paged = activity.before !== null;
  // `pageHref` is the bare item page; the params helper owns the `?`.
  const latestHref = `${pageHref}#activity`;
  const olderHref = activity.nextCursor
    ? `${workViewHref(pageHref, {}, { before: activity.nextCursor })}#activity`
    : null;
  const rows = activity.rows;

  return (
    // `scroll-mt-16`: the anchor both paging links land on sits under the
    // shell's sticky header otherwise (§10.15 pattern 2).
    <SectionCard id="activity" title={t("title")} className="scroll-mt-16">
      <div data-testid="item-activity" className="flex flex-col gap-4">
        {rows.length === 0 ? (
          paged ? (
            <EmptyState
              variant="filtered"
              title={t("pastEnd.title")}
              body={t("pastEnd.body")}
              action={
                <Button asChild size="sm" variant="outline">
                  <Link href={latestHref}>{t("latest")}</Link>
                </Button>
              }
            />
          ) : (
            <p className="text-sm text-muted-foreground">{t("empty")}</p>
          )
        ) : (
          <>
            {paged ? (
              <Button asChild size="sm" variant="outline" className="w-fit">
                <Link href={latestHref}>{t("latest")}</Link>
              </Button>
            ) : null}
            <Timeline>
              {rows.map((row, i) => {
                const { node, tone, filled } = nodeFor(row);
                return (
                  <TimelineItem
                    key={row.id}
                    node={node}
                    tone={tone}
                    filled={filled}
                    last={i === rows.length - 1}
                    contentClassName={visibilityRowCue(row.visibility)}
                  >
                    <div data-testid="item-activity-row" data-field={row.field} className="flex flex-col gap-1">
                      {/* `wrap-anywhere`: a title that is one unbroken token (a pasted URL) wraps in the phone-width sheet instead of clipping at the card edge. */}
                      <p className="text-sm wrap-anywhere">
                        <span className="font-medium">{who(row)}</span>{" "}
                        <span className="text-muted-foreground">{say(activitySentence(row, look))}</span>
                      </p>
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                        <RelativeTime at={row.createdAt.toISOString()} now={serverNow} />
                        <VisibilityBadge value={row.visibility} size="sm" />
                      </p>
                    </div>
                  </TimelineItem>
                );
              })}
            </Timeline>
            {olderHref ? (
              <Button asChild size="sm" variant="outline" className="w-fit">
                <Link href={olderHref}>{t("older")}</Link>
              </Button>
            ) : null}
          </>
        )}
      </div>
    </SectionCard>
  );
}
