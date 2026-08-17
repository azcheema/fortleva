import type { Metadata } from "next";
import { InboxIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { requireMemberSession } from "@/auth/session";
import { EmptyState, Page, PageHeader, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { resolveTimeZone } from "@/i18n/resolve";
import { requireTenantContext } from "@/members/tenant-context";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("home");
  return { title: t("title") };
}

const greetingKey = (hour: number): "morning" | "afternoon" | "evening" =>
  hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";

/**
 * /home — "My Work" (UI.md rule 8): the post-login destination.
 *
 * The three em-dash tiles that used to stand here are gone. A tile
 * earns its card when it carries a number that changes; three cards
 * showing "—" were 330px of the first phone screen spent saying
 * nothing. They come back with the numbers, in 2W/2T.
 *
 * The queue's empty state offers ONE verb (§5.8), and it is a create
 * verb — the two buttons it replaced were copies of two rail items
 * sitting 200px to the left.
 */
export default async function HomePage() {
  // Still required, and still first: a user with no ACTIVE membership is
  // redirected to the workspace picker rather than shown an empty queue.
  const { userEmail } = await requireTenantContext();
  const session = await requireMemberSession();
  const t = await getTranslations("home");
  const firstName = session.user.name.split(/\s+/)[0] || userEmail;
  // The viewer's clock: Member.timezone → tenant `ui.timezone` → Europe/Stockholm (UI.md §8).
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      hour: "numeric",
      hourCycle: "h23",
      timeZone: await resolveTimeZone(),
    }).format(new Date()),
  );

  return (
    <Page>
      {/* No "Workspace: {name}" subtitle: the header says it 60px above. */}
      <PageHeader title={t(`greeting.${greetingKey(hour)}`, { name: firstName })} />

      <div className="mt-6">
        <SectionCard title={t("queue")} description={t("queueDescription")}>
          <EmptyState
            variant="empty"
            icon={InboxIcon}
            title={t("empty.title")}
            body={t("empty.description")}
            action={
              <Button asChild>
                <Link href="/clients#new-client">
                  <PlusIcon />
                  {t("empty.action")}
                </Link>
              </Button>
            }
            className="mx-auto items-center py-8 text-center"
          />
        </SectionCard>
      </div>
    </Page>
  );
}
