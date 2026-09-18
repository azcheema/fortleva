import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { requireMemberSession } from "@/auth/session";
import {
  Callout,
  EmptyState,
  EntityChip,
  Page,
  PageHeader,
  SectionCard,
  StatusBadge,
} from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { getActiveMembership, membershipsFor } from "@/members/tenant-context";

import { switchWorkspaceAction } from "./actions";
import { WorkspaceRowButton } from "./workspace-row-button";

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
 * It picks as of 2026-09-18 (slice 26). It did not before: every row
 * linked to a bare `/home` and nothing ever WROTE the session's
 * `activeTenantId`, so a member of two active tenants always landed
 * back in `active[0]`, the earliest `joinedAt`. Each ACTIVE row is now
 * a form posting `switchWorkspaceAction`, which re-derives the
 * membership under RLS before it writes the pointer.
 *
 * On the page whose only job is choosing a workspace, the choices are
 * the controls: each active membership is a full-width SUBMIT with a
 * hover surface and a trailing chevron — a button, not a link, since
 * 2026-09-18, because choosing writes the session pointer and Next
 * prefetches links. The one you are currently in carries aria-current
 * plus the two-channel active-row treatment (§9). The escape hatch in the header is an outline button — it used
 * to be the loudest thing here.
 *
 * The "WORKSPACES / 1" tile is gone: it counted the list printed 60px
 * below it, alone in a three-column grid with two empty cells.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>;
}) {
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
  // The switch found no ACTIVE membership for what was clicked — the
  // membership was suspended or removed between this page rendering and
  // the click. The list below already shows that; this says why the
  // click did nothing, so it cannot read as a failure that reverted.
  const unavailable = (await searchParams).notice === "unavailable";

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

      {unavailable ? (
        <Callout tone="caution" role="alert" className="mt-6">
          {t("unavailable")}
        </Callout>
      ) : null}

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
                      // A FORM, not a link. Choosing a workspace WRITES
                      // the session pointer, and Next prefetches links —
                      // a GET here would switch workspace on hover. The
                      // button carries the row's whole surface, so the
                      // affordance is unchanged.
                      <form action={switchWorkspaceAction}>
                        <input type="hidden" name="tenantId" value={m.tenantId} />
                        <WorkspaceRowButton
                          label={t("open", { name: m.tenantName })}
                          current={current}
                        >
                          {body}
                        </WorkspaceRowButton>
                      </form>
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
