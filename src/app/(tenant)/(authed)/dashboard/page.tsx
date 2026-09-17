import type { Metadata } from "next";
import { ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { requireMemberSession } from "@/auth/session";
import {
  EmptyState,
  EntityChip,
  Page,
  PageHeader,
  SectionCard,
  StatusBadge,
} from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getActiveMembership, membershipsFor } from "@/members/tenant-context";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("dashboard") };
}

/**
 * Workspace picker (UI.md rule 8): /home is the home page; this lists
 * memberships. The account menu OFFERS it only above one membership —
 * with a single workspace there is nothing to pick. The route stays
 * reachable regardless, because it is where `requireTenantContext`
 * sends a user with no active membership, and the only place a
 * SUSPENDED membership's status is visible.
 *
 * KNOWN DEFECT, recorded 2026-09-17 (PLAN §0), NOT introduced here:
 * this picker cannot actually switch. Every ACTIVE row links to a bare
 * `/home`, and nothing in the repository ever WRITES the session's
 * `activeTenantId` pointer (`src/auth/index.ts` declares it
 * `input: false`; `getActiveMembership` is its only reader), so a
 * member of two active tenants always lands back in `active[0]` — the
 * one with the earliest `joinedAt`. Switching needs a server action
 * that re-derives the membership and writes the pointer; until it
 * exists, do not describe this page as working.
 *
 * On the page whose only job is choosing a workspace, the choices are
 * the controls: each active membership is a full-width row link with a
 * hover surface and a trailing chevron, and the one you are currently
 * in carries aria-current plus the two-channel active-row treatment
 * (§9). The escape hatch in the header is an outline button — it used
 * to be the loudest thing here.
 *
 * The "WORKSPACES / 1" tile is gone: it counted the list printed 60px
 * below it, alone in a three-column grid with two empty cells.
 */
export default async function DashboardPage() {
  const session = await requireMemberSession();
  // Both reads come off the ONE per-request memoised list: this page
  // used to call `listMembershipsForUser` beside `getActiveMembership`,
  // which memoises the very same query, and so ran it twice.
  const [memberships, active] = await Promise.all([
    membershipsFor(session.user.id),
    getActiveMembership(session),
  ]);
  const t = await getTranslations("dashboard");
  const hasActive = memberships.some((m) => m.status === "ACTIVE");

  return (
    <Page>
      <PageHeader
        title={t("title", { name: session.user.name })}
        actions={
          hasActive ? (
            <Button asChild variant="outline">
              <Link href="/home">{t("goHome")}</Link>
            </Button>
          ) : null
        }
      />

      <div className="mt-6">
        <SectionCard title={t("workspaces")} contentClassName="p-0">
          {memberships.length === 0 ? (
            <div className="px-4">
              <EmptyState variant="forbidden" title={t("noneTitle")} body={t("none")} />
            </div>
          ) : (
            <ul className="flex flex-col">
              {memberships.map((m) => {
                const current = active?.tenantId === m.tenantId;
                const body = (
                  <>
                    <EntityChip
                      id={m.tenantId}
                      name={m.tenantName}
                      kind="client"
                      size="md"
                      className="font-medium"
                    />
                    <span className="ml-auto flex shrink-0 items-center gap-2">
                      {current ? (
                        <span className="text-xs text-muted-foreground">{t("current")}</span>
                      ) : null}
                      <StatusBadge domain="memberStatus" value={m.status} />
                    </span>
                  </>
                );
                return (
                  <li key={m.memberId} className="border-b border-border last:border-b-0">
                    {m.status === "ACTIVE" ? (
                      <Link
                        href="/home"
                        aria-label={t("open", { name: m.tenantName })}
                        aria-current={current ? "page" : undefined}
                        className={cn(
                          "row-h relative flex items-center gap-3 px-4 text-sm transition-colors duration-(--dur-instant) ease-out hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                          // Two channels, the same pair the rail uses:
                          // an --accent fill AND a 2px --primary bar.
                          current &&
                            "bg-accent font-medium before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full before:bg-primary",
                        )}
                      >
                        {body}
                        <ChevronRightIcon
                          aria-hidden="true"
                          className="size-4 shrink-0 text-muted-foreground"
                        />
                      </Link>
                    ) : (
                      <div className="row-h flex items-center gap-3 px-4 text-sm">{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </SectionCard>
      </div>
    </Page>
  );
}
