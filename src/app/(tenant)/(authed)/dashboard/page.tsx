import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { requireMemberSession } from "@/auth/session";
import {
  EmptyState,
  EntityChip,
  MetricTile,
  Page,
  PageHeader,
  SectionCard,
  StatusBadge,
} from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { listMembershipsForUser } from "@/members/service";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("dashboard") };
}

/** Workspace picker (UI.md rule 8): /home is the home page; this lists memberships. */
export default async function DashboardPage() {
  const session = await requireMemberSession();
  const memberships = await listMembershipsForUser(session.user.id);
  const t = await getTranslations("dashboard");
  const hasActive = memberships.some((m) => m.status === "ACTIVE");

  return (
    <Page>
      <PageHeader
        title={t("title", { name: session.user.name })}
        actions={
          hasActive ? (
            <Button asChild>
              <Link href="/home">{t("goHome")}</Link>
            </Button>
          ) : null
        }
      />

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <MetricTile label={t("metric")} value={memberships.length} />
      </div>

      <div className="mt-6">
        <SectionCard title={t("workspaces")}>
          {memberships.length === 0 ? (
            <EmptyState variant="forbidden" title={t("noneTitle")} body={t("none")} />
          ) : (
            <ul className="flex flex-col">
              {memberships.map((m) => (
                <li
                  key={m.memberId}
                  className="row-h flex items-center justify-between gap-3 border-b border-border last:border-b-0"
                >
                  <EntityChip
                    id={m.tenantId}
                    name={m.tenantName}
                    kind="client"
                    size="md"
                    className="font-medium"
                  />
                  <StatusBadge domain="memberStatus" value={m.status} />
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </Page>
  );
}
