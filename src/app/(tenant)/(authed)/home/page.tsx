import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { requireMemberSession } from "@/auth/session";
import { EmptyState, MetricTile, Page, PageHeader, SectionCard } from "@/components/semantic";
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
 * /home — "My Work" (UI.md rule 8): the post-login destination. The
 * three tiles are the shape the page will keep; their numbers arrive
 * with the Work and Time modules (2W/2T), so they stand at an em dash
 * rather than at a fake zero — a zero would read as a measurement.
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
  const pending = t("tiles.pending");

  return (
    <Page>
      <PageHeader title={greeting} description={t("workspace", { name: membership.tenantName })} />

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <MetricTile label={t("tiles.assigned")} value={pending} />
        <MetricTile label={t("tiles.waiting")} value={pending} />
        <MetricTile label={t("tiles.due")} value={pending} />
      </div>

      <div className="mt-6">
        <SectionCard title={t("queue")} description={t("queueDescription")}>
          <EmptyState
            variant="empty"
            title={t("empty.title")}
            body={t("empty.description")}
            action={
              <Button asChild>
                <Link href="/clients">{t("empty.clients")}</Link>
              </Button>
            }
            secondary={
              <Button asChild variant="outline">
                <Link href="/projects">{t("empty.projects")}</Link>
              </Button>
            }
          />
        </SectionCard>
      </div>
    </Page>
  );
}
