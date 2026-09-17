import { BellIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { RelativeTime } from "@/components/relative-time";
import { SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import type { InboxGlance } from "@/notify/inbox";
import { GENERIC_COPY_KEY, KIND_MESSAGE_KEY } from "@/notify/kind-copy";
import { KIND_ICON } from "@/notify/kind-icon";

/**
 * `/home`'s inbox card (UI.md rule 8, "inbox top-5"): the newest unread
 * notifications and how many there are in all.
 *
 * DRAWN ONLY WHEN SOMETHING IS UNREAD. A card saying "nothing unread"
 * would be a second copy of the rail's badge being absent, spent on the
 * first phone screen — the rule that took the em-dash tiles off this
 * page. The inbox's verbs (read, archive, snooze) stay on `/inbox`: this
 * card is a glance with a way in, not a second inbox.
 */
export async function InboxCard({ glance, serverNow }: { glance: InboxGlance; serverNow: string }) {
  const [t, tInbox] = await Promise.all([getTranslations("home"), getTranslations("inbox")]);

  return (
    <SectionCard
      title={t("inbox.title")}
      description={t("inbox.unread", { count: glance.unread })}
      actions={
        <Button asChild size="sm" variant="outline">
          <Link href="/inbox">{t("inbox.open")}</Link>
        </Button>
      }
      contentClassName="p-0"
    >
      <ul data-testid="home-inbox">
        {glance.rows.map((r) => {
          const Icon = r.kind ? KIND_ICON[r.kind] : BellIcon;
          const label = tInbox(`kind.${r.kind ? KIND_MESSAGE_KEY[r.kind] : GENERIC_COPY_KEY}`);
          return (
            <li
              key={r.id}
              data-testid="home-inbox-row"
              className="flex items-start gap-3 border-t border-border px-4 py-2.5 first:border-t-0"
            >
              <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{label}</p>
                {r.subject ? (
                  <Link
                    href={r.subject.href}
                    className="mt-0.5 block truncate text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    {r.subject.title}
                  </Link>
                ) : (
                  <p className="mt-0.5 text-sm text-muted-foreground">{tInbox("subjectUnavailable")}</p>
                )}
              </div>
              <RelativeTime
                at={r.createdAt.toISOString()}
                now={serverNow}
                className="mt-0.5 shrink-0 text-xs whitespace-nowrap text-muted-foreground"
              />
            </li>
          );
        })}
      </ul>
    </SectionCard>
  );
}
