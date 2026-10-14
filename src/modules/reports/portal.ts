import { AuthzError } from "@/authz/errors";
import { authorizePortal, withPortalRead, type PortalPrincipal } from "@/portal";

import { originOf, seriesOf, SPEED_WEEKS_SHOWN, type SpeedSeries, type SpeedWeekRow } from "./speed-shapes";

/**
 * THE CLIENT'S WEBSITE SPEED (Phase 6 slice 118; founder decision C94) — on
 * the portal's Reports page: for each of the client's projects whose
 * "Show to the client" switch is on AND whose portal is on, the weekly
 * numbers Google published for its site. Read under the contact's
 * principal: `portal_gate` on `website_speed_week` (client, derived
 * visibility, `portal_enabled`) decides; the `where` restates its terms as
 * defence in depth, and the project row comes through its own gate.
 *
 * WHAT A ROW SAYS: the period, the three p75s and the nine shares; never
 * when it was fetched, nor anything of the agency's. The row's `origin`
 * column is not selected (it is on the never-list as a column name); the
 * SITE the client is told about is their project's own Production URL's
 * origin — `productionUrl` is a client-visible column (DATA_MODEL §6.5),
 * read here on the portal for the first time, and a card is drawn only
 * when Google holds public data for that exact origin, so a staging or
 * internal host typed there by mistake can never reach a client as a
 * chart (the security review's 6). The rows drawn are those of that
 * origin — a `where` term, and since migration 20261023110000 the
 * database's own rule too.
 */

export type PortalSpeedProject = {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  /** The site measured — the Production URL's origin, the client's own address. */
  readonly origin: string;
  readonly series: SpeedSeries;
};

/** Projects read at most — a client with more sites than this is not a portal client. */
const PORTAL_SPEED_PROJECT_LIMIT = 20;

const speedWhere = (principal: PortalPrincipal) => ({
  tenantId: principal.tenantId,
  clientId: principal.clientId,
  visibility: "CLIENT_VISIBLE" as const,
  portalEnabled: true,
});

export async function listPortalWebsiteSpeed(principal: PortalPrincipal): Promise<readonly PortalSpeedProject[]> {
  return withPortalRead(principal, async (tx) => {
    await authorizePortal(tx, principal, "portal.report.view");
    const projects = await tx.project.findMany({
      where: {
        tenantId: principal.tenantId,
        clientId: principal.clientId,
        portalEnabled: true,
        archivedAt: null,
        productionUrl: { not: null },
        speedWeeks: { some: speedWhere(principal) },
      },
      select: { id: true, key: true, name: true, productionUrl: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: PORTAL_SPEED_PROJECT_LIMIT,
    });
    const out: PortalSpeedProject[] = [];
    // One read per project, in SEQUENCE (AGENTS.md's `Promise.all` trap).
    for (const p of projects) {
      const origin = originOf(p.productionUrl);
      if (origin === null) continue;
      // The allow-list, INLINE — the projections test reads only a literal
      // (`SPEED_WEEK_SELECT` is the same list, for the team's read). One read
      // per device kind, in sequence, so neither kind can starve the other
      // (the code review's 12).
      const rows: SpeedWeekRow[] = [];
      for (const formFactor of ["PHONE", "DESKTOP"] as const) {
        rows.push(
          ...(await tx.websiteSpeedWeek.findMany({
            where: { ...speedWhere(principal), projectId: p.id, origin, formFactor },
            select: {
              formFactor: true,
              periodStart: true,
              periodEnd: true,
              lcpP75Ms: true,
              inpP75Ms: true,
              clsP75: true,
              lcpGood: true,
              lcpNeedsWork: true,
              lcpPoor: true,
              inpGood: true,
              inpNeedsWork: true,
              inpPoor: true,
              clsGood: true,
              clsNeedsWork: true,
              clsPoor: true,
            },
            orderBy: { periodEnd: "desc" },
            take: SPEED_WEEKS_SHOWN,
          })),
        );
      }
      if (rows.length === 0) continue;
      out.push({ id: p.id, key: p.key, name: p.name, origin, series: seriesOf(rows) });
    }
    return out;
  });
}

/**
 * WHETHER THERE IS A SPEED SERIES FOR THIS CONTACT TO SEE — the nav's
 * question, beside the reports' count. Zero, never a refusal.
 *
 * THE SAME ANSWER AS THE LIST (the code review's 1): a project counts only
 * with rows of its CURRENT site — after a Production URL moves, the old
 * site's rows are history the page does not draw, and a nav entry over an
 * empty page is what this must not say. That is the DATABASE's rule since
 * migrations 20261023110000 and 20261023120000 (the stamp and the fan-out
 * derive `visibility` from the switch AND the row's origin against the
 * project's current URL — a previous site's rows, and every row of a URL
 * the app refuses, are INTERNAL), so a gated row IS a current-site row and
 * one Prisma count answers (no raw SQL: a portal projection carries an
 * allow-list a reader can check, `portal-projections.test.ts`).
 */
export async function countPortalWebsiteSpeed(principal: PortalPrincipal): Promise<number> {
  return withPortalRead(principal, async (tx) => {
    try {
      await authorizePortal(tx, principal, "portal.report.view");
    } catch (e) {
      if (!(e instanceof AuthzError)) throw e;
      return 0;
    }
    return tx.project.count({
      where: {
        tenantId: principal.tenantId,
        clientId: principal.clientId,
        portalEnabled: true,
        archivedAt: null,
        productionUrl: { not: null },
        speedWeeks: { some: speedWhere(principal) },
      },
    });
  });
}
