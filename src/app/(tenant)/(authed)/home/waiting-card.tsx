import { CheckIcon, UserRoundIcon } from "lucide-react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";

import { SectionCard } from "@/components/semantic";
import { formatDay } from "@/lib/format";
import { itemReturnTo } from "@/lib/work-view";
import type { WaitingOnClient, WaitingRow } from "@/modules/work";

/**
 * `/home`'s "WAITING ON CLIENT" (UI.md rule 8) — the last of that rule's
 * cards, and the one that waited longest: `assigneeContactId` had no
 * writer until Phase 3 slice 6c and no member-plane surface until its
 * second commit, so until now the card could only ever have said zero.
 *
 * **TWO GROUPS, TICKED FIRST** (founder decision, 2026-09-22). The
 * client saying "I've done my part" is the task coming BACK, and it is
 * the one moment nobody at the agency would otherwise notice — a
 * notification is read once and archived, a card is a standing list. The
 * second group is the literal reading of the card's own name.
 *
 * A ROW IS ONE LINK TO THE TASK, over its backlog — the queue row's
 * address for a task, so the peek opens where a member can act: chase
 * it, take it back, or accept the client's word and finish it.
 *
 * **EACH GROUP IS DRAWN ONLY IF IT HAS ROWS**, and the card only if
 * either does (the page's guard) — the inbox card's rule. An empty
 * "Client says done" heading over nothing is a row of space spent
 * restating an absence.
 *
 * THE GROUP COUNTS ARE OF THE ROWS SHOWN, not of the world, because the
 * cap cuts from the end of an ordered list — the queue's rule rather
 * than the triage card's. When it bites, ONE sentence above both groups
 * says so, which is why `truncated` is a single flag for the card and
 * not one per group: two truncation lines on a five-row card is more
 * chrome than list.
 */
export async function WaitingCard({ glance }: { glance: WaitingOnClient }) {
  // ONE resolution of each, passed to the groups — next-intl caches per
  // request, so this is about having a single source for both groups
  // rather than about cost.
  const [t, locale] = await Promise.all([getTranslations("home"), getLocale()]);

  return (
    <SectionCard
      title={t("waiting.title")}
      description={t("waiting.description")}
      contentClassName="p-0"
    >
      {glance.truncated ? (
        <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
          {/* THE CAP THE READ ACTUALLY APPLIED, carried on its answer —
              not the module constant, which a caller passing its own
              limit would make a lie (a fresh code review caught the
              constant being restated here while the read takes an
              option, and the dbtest already passes one). */}
          {t("waiting.truncated", { count: glance.limit })}
        </p>
      ) : null}
      {glance.ticked.length > 0 ? (
        <Group
          heading={t("waiting.tickedHeading", { count: glance.ticked.length })}
          rows={glance.ticked}
          testId="home-waiting-ticked"
          ticked
          t={t}
          locale={locale}
        />
      ) : null}
      {glance.waiting.length > 0 ? (
        <Group
          heading={t("waiting.waitingHeading", { count: glance.waiting.length })}
          rows={glance.waiting}
          testId="home-waiting-still"
          ticked={false}
          t={t}
          locale={locale}
        />
      ) : null}
    </SectionCard>
  );
}

function Group({
  heading,
  rows,
  testId,
  ticked,
  t,
  locale,
}: {
  heading: string;
  rows: readonly WaitingRow[];
  testId: string;
  /** Decides the glyph and the meta line — never the row's shape. */
  ticked: boolean;
  t: Awaited<ReturnType<typeof getTranslations<"home">>>;
  locale: string;
}) {
  return (
    // **THE SEPARATOR IS ON THE SECTION, NOT ON THE HEADING.** The `<h3>`
    // is always the first child of its own section, so a `first:` rule
    // there matches every group and the two ran together as one list —
    // which is the opposite of this card's whole shape. `queue-rows.tsx`
    // puts the rule on the group WRAPPER for exactly this reason. It is a
    // TOP border with `first:border-t-0` rather than a bottom one because
    // the truncation line above already carries `border-b`, and a bottom
    // rule here would double it. Found by a fresh code review.
    <section className="border-t border-border first:border-t-0">
      {/* An h3 carrying its count, not a landmark region — the queue's
          rule, so a screen reader walks one card and not four. */}
      <h3 className="px-4 pt-3 pb-1 text-xs font-medium text-muted-foreground">
        {heading}
      </h3>
      <ul data-testid={testId}>
        {rows.map((row) => (
          <li key={row.id} className="border-t border-border first:border-t-0">
            {/* The LINK is the row, the queue row's rule: the whole strip
                is the target so a thumb does not have to find a word. The
                address is the task's peek over its backlog — where the
                verbs are. */}
            <Link
              // THE SHARED HELPER, never a hand-rolled copy: the peek's
              // address has one definition (`item-surface.ts`), which the
              // queue row, the inbox and the property actions all go
              // through. A second copy here would survive a rename of the
              // query param as a link to nowhere.
              href={itemReturnTo("backlog-peek", row.projectKey, row.number)}
              className="flex items-center gap-3 px-4 py-2.5 hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            >
              {ticked ? (
                <CheckIcon aria-hidden="true" className="size-4 shrink-0 text-(--tone-success-fg)" />
              ) : (
                <UserRoundIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{row.title}</span>
                {/* WHO AND WHERE, in one muted line. The contact's name is
                    the point of the card — "waiting on client" with no
                    name is a queue nobody can chase — and the project is
                    the queue row's rule, because the link goes there. */}
                <span className="block truncate text-xs text-muted-foreground">
                  {row.contactName
                    ? t("waiting.rowMeta", { name: row.contactName, project: row.projectName })
                    : row.projectName}
                  {/* WHEN THEY SAID IT. The ticked group is ordered
                      newest-claim-first and showed no date, so a claim
                      from six weeks ago and one from an hour ago read
                      identically — in the one group this card exists to
                      make noticeable. The portal shows the client the
                      same stamp for the same reason. */}
                  {ticked && row.markedDoneAt
                    ? ` · ${t("waiting.saidOn", { date: formatDay(locale, row.markedDoneAt) })}`
                    : ""}
                </span>
              </span>
              {row.targetDate ? (
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {/* `targetDate` is a `@db.Date` — UTC midnight standing
                      for a calendar day — so `formatDay` pins it to UTC
                      or the day shifts west of Greenwich. */}
                  {formatDay(locale, row.targetDate)}
                </span>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
