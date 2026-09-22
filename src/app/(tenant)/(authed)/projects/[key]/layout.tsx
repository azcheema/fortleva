import type { Metadata } from "next";
import { ExternalLinkIcon, GlobeIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { NuqsAdapter } from "nuqs/adapters/next/app";

import { isAuthorized } from "@/authz/authorize";
import { Callout, EntityTile, Page, PageHeader, StatusBadge } from "@/components/semantic";
import { withTenant } from "@/db";
import { hasAccess } from "@/entitlements/resolver";
import { requireTenantContext } from "@/members/tenant-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TabNav } from "@/components/tab-nav";

import { loadProject } from "./data";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ key: string }>;
}): Promise<Metadata> {
  const { key } = await params;
  const project = await loadProject(key);
  return { title: `${project.key} · ${project.name}` };
}

/**
 * /projects/[key] shell (UI.md §3.1): tabs in the fixed order Overview ·
 * Board · Backlog · Triage · Timeline · Time · Files · Team · Portal
 * (Updates arrives with ProjectUpdate). Overview is the landing tab because there
 * is no board to land on for a project with no work yet.
 *
 * Four of the nine are conditional, and each is HIDDEN rather than
 * disabled when its permission is missing (§3.1): Time on
 * `time:view_team`, Files on `document:view`, Portal on
 * `project:manage_portal`, Triage on `work_item:triage`. A hidden tab is
 * not a gate — every one of those pages carries its own.
 *
 * The header is the project's identity in one line: the key in the
 * mono face (it is a code, and it is typed), the name, then the two
 * facts that change how the project behaves — its status and whether a
 * client can reach it at all. The client sits above as an EntityChip,
 * so the workspace colour is present on every tab.
 */
export default async function ProjectLayout({
  params,
  children,
}: {
  params: Promise<{ key: string }>;
  children: React.ReactNode;
}) {
  const { key } = await params;
  const project = await loadProject(key);
  const t = await getTranslations("projects");
  const base = `/projects/${project.key}`;
  // 2T: the Time tab (rollups, budget, reports) is a team surface. The
  // finance-gated Money page is a sub-view of it (UI.md §3.1) at its
  // pinned route /projects/[key]/money, so the tab stays lit there.
  const { membership, actor } = await requireTenantContext();
  // TWO CHECKS, TWO HELPERS, and the difference is the whole reason
  // `hasAccess` exists. `isAuthorized` runs gate 4 only; `hasAccess`
  // runs all four. The Portal tab needs all four because §3.1 says a
  // module-gated item is HIDDEN when the entitlement or the tenant
  // preference is off — and the page behind this tab starts with
  // `requireAccess`, so a tab lit on the permission alone would have led
  // a tenant with the portal switched off straight into an error
  // boundary (measured, 2026-09-21). Time's check is left as it was:
  // changing it is a behaviour change for the `time` module and belongs
  // in a slice that can test it.
  const [canViewTime, canManagePortal] = await withTenant(
    membership.tenantId,
    { type: "member", id: membership.memberId },
    // SEQUENTIAL, NOT `Promise.all`, and the first cut of this got it
    // wrong in a way only the browser could show. A Prisma interactive
    // transaction is ONE connection: two multi-query operations started
    // concurrently on the same `tx` interleave their statements on it,
    // and `pg` says so out loud — "Calling client.query() when the
    // client is already executing a query is deprecated and will be
    // removed in pg@9.0". Every gate here costs several queries
    // (`effectivePermissions` alone is one, `hasAccess` runs four), so
    // running them together put a project page's authorization on a
    // pipe it does not own. Typecheck, lint, unit, dbtests and the build
    // were all green; the e2e run went red across surfaces that have
    // nothing to do with the portal, which is what a shared-connection
    // fault looks like.
    async (tx) => {
      const time = await isAuthorized(tx, actor, "time:view_team");
      // Short-circuited on the cap `loadProject` already resolved, so
      // the extra gate reads happen only for the members who could hold
      // the tab at all — not on every tab of every project for an
      // employee who can never see it.
      const portal = project.caps.managePortal
        ? await hasAccess(tx, membership.tenantId, actor, "project:manage_portal")
        : false;
      return [time, portal] as const;
    },
  );

  const tabs = [
    { href: base, label: t("tabs.overview"), exact: true },
    { href: `${base}/board`, label: t("tabs.board") },
    // A single item's page is a Backlog sub-view, the way /money is a
    // sub-view of Time: the backlog is the project's full list of items
    // (archived ones included), and an item page reached from search or
    // the inbox has no board context to return to. Without this the
    // strip renders with NOTHING current, which reads as "this page has
    // no tabs".
    { href: `${base}/backlog`, label: t("tabs.backlog"), also: [`${base}/items`] },
    // Phase 3 slice 6b: the client's requests, waiting for an answer.
    // It sits after Backlog because that is where the work it produces
    // lands, and it is HIDDEN without `work_item:triage`, off the same
    // batched permission read the other caps use — so it costs no query.
    //
    // **GATE 4 ONLY, WHICH IS BOARD AND BACKLOG'S RULE AND NOT
    // PORTAL'S** — the first version of this comment claimed parity with
    // Portal and was wrong (code review). Portal deliberately runs
    // `hasAccess` (all four gates) because a permission-only tab on a
    // tenant with the module off walks into the page's own
    // `requireAccess`; `work_item:triage` is in the `work` module, so
    // the same is technically true here. It is left as it is for
    // consistency: Board and Backlog are UNCONDITIONAL tabs on that same
    // module, so a `work`-off tenant already meets that wall two tabs
    // earlier, and the denial is uniform (a 404, never a 403). Changing
    // it is a behaviour change for the `work` module and belongs in a
    // slice that can test it — the same disposition Time carries above.
    //
    // A member without the permission has no lane; the requests are
    // still visible to them in the board's TRIAGE column, so nothing is
    // concealed that a viewer could not reach one tab away.
    ...(project.caps.triage ? [{ href: `${base}/triage`, label: t("tabs.triage") }] : []),
    { href: `${base}/timeline`, label: t("tabs.timeline") },
    ...(canViewTime ? [{ href: `${base}/time`, label: t("tabs.time"), also: [`${base}/money`] }] : []),
    ...(project.caps.viewDocuments ? [{ href: `${base}/files`, label: t("tabs.files") }] : []),
    { href: `${base}/team`, label: t("tabs.team") },
    // Phase 3: the portal master switch and what the client sees. Hidden
    // rather than disabled when the member lacks project:manage_portal
    // (UI.md §3.1); the page itself 404s for the typed URL.
    ...(canManagePortal ? [{ href: `${base}/portal`, label: t("tabs.portal") }] : []),
  ];

  return (
    <Page width="wide">
      <PageHeader
        breadcrumb={
          // A trail, not a chip: the client's tile stacked directly above
          // the project's own mark and — in a workspace of one client —
          // resolved to the same square twice. The name is the trail.
          <Link
            href={`/clients/${project.client.id}`}
            className="rounded-sm underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {project.client.name}
          </Link>
        }
        title={
          <span className="flex min-w-0 items-center gap-2.5">
            {/* The project's own mark, the same one its rows wear in every
                list — identity should not vanish on the detail page. */}
            <EntityTile id={project.id} name={project.name} size="lg" />
            <span className="num-id shrink-0 font-mono text-base text-muted-foreground">
              {project.key}
            </span>
            <span className="truncate">{project.name}</span>
          </span>
        }
        badges={
          <>
            <StatusBadge domain="projectStatus" value={project.status} />
            {/* Portal state is NOT client-visibility: it gets the brand tone and
                its own glyph so it can never be read as the warm "client can
                see" pill (UI.md §10.4 collision rule). §10.4 specifies a badge
                for portal ON only — "off" is the resting state of every
                project and does not need a chip on every tab. */}
            {project.portalEnabled ? (
              <Badge variant="brand">
                <GlobeIcon aria-hidden="true" />
                {t("portal.on")}
              </Badge>
            ) : null}
            {/* Phase 3 slot: <HealthChip value={project.health} /> lands here,
                beside the status, once ProjectUpdate.health exists. */}
          </>
        }
        actions={
          project.productionUrl ? (
            <Button asChild variant="outline" size="sm">
              <a href={project.productionUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLinkIcon />
                {t("overview.openProduction")}
              </a>
            </Button>
          ) : null
        }
      />
      {project.status === "ARCHIVED" ? (
        <Callout tone="caution" role="status" className="mt-4">
          {t("overview.archivedBanner")}
        </Callout>
      ) : null}
      <TabNav tabs={tabs} className="mt-4" />
      {/* The work surfaces keep their view in the URL (UI.md rule 6),
          and nuqs needs its adapter above every useQueryStates. It is
          mounted HERE rather than at the root because the adapter
          patches history globally: the board and the backlog are the
          only surfaces that use it today, and the portal and ops planes
          should not inherit a patch they never asked for. It moves up
          the tree when /home and /search join. */}
      <NuqsAdapter>
        <div className="mt-6">{children}</div>
      </NuqsAdapter>
    </Page>
  );
}
