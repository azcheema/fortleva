import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { requireMemberSession } from "@/auth/session";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Page, PageHeader } from "@/components/page-header";
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
  const tCommon = await getTranslations("common");
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
      <section className="mt-6">
        <h2 className="text-base font-medium">{t("workspaces")}</h2>
        {memberships.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">{t("none")}</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {memberships.map((m) => (
              <li key={m.memberId}>
                <Card size="sm">
                  <CardContent className="flex items-center justify-between gap-3">
                    <span className="font-medium">{m.tenantName}</span>
                    <Badge variant={m.status === "SUSPENDED" ? "outline" : "secondary"}>
                      {m.status === "SUSPENDED" ? tCommon("suspended") : tCommon("active")}
                    </Badge>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Page>
  );
}
