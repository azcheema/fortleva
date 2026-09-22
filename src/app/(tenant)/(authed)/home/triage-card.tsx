import { InboxIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { SectionCard } from "@/components/semantic";
import type { TriageGlance } from "@/modules/work";

/**
 * `/home`'s triage count (UI.md rule 8) — client requests waiting for an
 * answer, grouped by the project whose lane answers them.
 *
 * **IT WAITED FOR A WRITER SINCE 2W.** This page's own header carried a
 * comment saying rule 8's "triage count" was absent on purpose, because
 * nothing could put a task in triage and the card's number would always
 * have been zero — the same reason the three em-dash tiles were taken
 * off this page. Slice 6a's portal intake gave it a writer and 6b gave
 * it a destination.
 *
 * DRAWN ONLY WHEN THERE IS A ROW TO DRAW, the inbox card's rule: a card
 * saying "no requests" spends the first phone screen restating an
 * absence nobody asked about. The page gates on `projects.length`, not
 * on `total` — a count with no row under it is a number the member
 * cannot act on, which is the §5.8 failure this card exists to avoid
 * rather than commit.
 *
 * A ROW IS ONE LINK TO ONE LANE, the queue row's shape — because the
 * lane is where a request is answered and §5.8's rule is that a surface
 * offers the verb that changes what it shows. A tenant-wide number with
 * nowhere to go would be a notification, not a card.
 *
 * THE HEADING'S NUMBER MAY EXCEED THE ROWS' and that is deliberate: the
 * cap cuts PROJECTS off an already-exact grouped total, so the total is
 * free and honest, and the line beneath says how many projects are not
 * named. The queue does the opposite — its group counts are of the rows
 * SHOWN — because its cap cuts from the end of an ordered list, where a
 * count of the remainder is a number nobody could act on.
 */
export async function TriageCard({ glance }: { glance: TriageGlance }) {
  const t = await getTranslations("home");

  return (
    <SectionCard
      title={t("triage.title")}
      description={t("triage.waiting", { count: glance.total })}
      contentClassName="p-0"
    >
      <ul data-testid="home-triage">
        {glance.projects.map((p) => (
          <li key={p.projectKey} data-testid="home-triage-row" className="border-t border-border first:border-t-0">
            {/* The LINK is the row, not a control inside it: the whole
                strip is the target, the queue row's rule, so a thumb
                does not have to find a word. */}
            <Link
              href={`/projects/${p.projectKey}/triage`}
              className="flex items-center gap-3 px-4 py-2.5 hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            >
              <InboxIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{p.projectName}</span>
              {/* The count is spoken with its noun — a bare "3" beside a
                  project name is ambiguous to a screen reader, which
                  reads the row as "Acme, 3". */}
              <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                <span aria-hidden="true">{p.count}</span>
                <span className="sr-only">{t("triage.waiting", { count: p.count })}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {glance.moreProjects > 0 ? (
        <p className="border-t border-border px-4 py-2.5 text-sm text-muted-foreground">
          {t("triage.moreProjects", { count: glance.moreProjects })}
        </p>
      ) : null}
    </SectionCard>
  );
}
