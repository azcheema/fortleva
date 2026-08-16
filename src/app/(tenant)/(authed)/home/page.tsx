import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { requireMemberSession } from "@/auth/session";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { Page, PageHeader } from "@/components/page-header";
import { resolveTimeZone } from "@/i18n/resolve";
import { requireTenantContext } from "@/members/tenant-context";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("home");
  return { title: t("title") };
}

const greetingKey = (hour: number): "morning" | "afternoon" | "evening" =>
  hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";

/**
 * /home — "My Work" (UI.md rule 8): the post-login destination. Assigned
 * work, waiting-on-client, triage, inbox and the timer arrive with their
 * modules; until then one empty state pointing at Clients and Projects.
 */
export default async function HomePage() {
  const { membership, userEmail } = await requireTenantContext();
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
  const greeting = t(`greeting.${greetingKey(hour)}`, { name: firstName });

  return (
    <Page>
      <PageHeader title={greeting} description={t("workspace", { name: membership.tenantName })} />
      <section className="mt-6">
        <EmptyState
          title={t("empty.title")}
          description={t("empty.description")}
          actions={
            <>
              <Button asChild>
                <Link href="/clients">{t("empty.clients")}</Link>
              </Button>
              <Button asChild variant="outline">
                <Link href="/projects">{t("empty.projects")}</Link>
              </Button>
            </>
          }
        />
      </section>
    </Page>
  );
}
