import { assertInScope, type MemberActor } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { withTenant } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import type { SpeedCheckOutcome } from "@/generated/prisma/enums";

import { originOf, seriesOf, SPEED_WEEK_SELECT, SPEED_WEEKS_SHOWN, type SpeedSeries, type SpeedWeekRow } from "./speed-shapes";

/**
 * THE TEAM'S WEBSITE SPEED (Phase 6 slice 118; founder decision C94 (d)) —
 * the project page's Website speed card: the weekly numbers Google
 * published for the site behind the Production URL, when Google was last
 * asked and what came of it, and where the "Show to the client" switch
 * stands. READ-ONLY; the switch is `setSpeedShared` (`src/projects/service.ts`).
 *
 * `report:view` on all four gates (CMAE — the catalogue's "View performance
 * reports / CrUX charts"), then the project in scope (NOT_FOUND outside it,
 * the project page's own rule). ONE member transaction, reads in sequence.
 */

export type SpeedCtx = {
  readonly tenantId: string;
  /** From requireTenantContext() — never from form params. */
  readonly actor: MemberActor;
};

export type WebsiteSpeed = {
  readonly productionUrl: string | null;
  /** The site measured — null when the URL is unset or not http(s). */
  readonly origin: string | null;
  /** The "Show to the client" switch (C94 (a)). */
  readonly shown: boolean;
  /** The project's portal switch — with it off the client sees nothing whatever `shown` says. */
  readonly portalEnabled: boolean;
  readonly archived: boolean;
  /** When Google was last asked, about which site, and what came of it; null until the first check. */
  readonly check: { readonly checkedAt: Date; readonly origin: string | null; readonly outcome: SpeedCheckOutcome; readonly detail: string | null } | null;
  /** The current origin's rows, oldest first, per device kind. */
  readonly series: SpeedSeries;
};

export async function readWebsiteSpeed(ctx: SpeedCtx, projectId: string): Promise<WebsiteSpeed> {
  return withTenant(ctx.tenantId, { type: "member", id: ctx.actor.memberId }, async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "report:view");
    const p = await tx.project.findFirst({
      where: { id: projectId },
      select: { id: true, productionUrl: true, portalShowSpeed: true, portalEnabled: true, archivedAt: true },
    });
    if (!p) deny("NOT_FOUND");
    await assertInScope(tx, ctx.actor, { projectId });
    const check = await tx.websiteSpeedCheck.findFirst({
      where: { projectId },
      select: { checkedAt: true, origin: true, outcome: true, detail: true },
    });
    const origin = originOf(p!.productionUrl);
    // One read per device kind, in sequence (the code review's 12).
    const rows: SpeedWeekRow[] = [];
    if (origin) {
      for (const formFactor of ["PHONE", "DESKTOP"] as const) {
        rows.push(
          ...(await tx.websiteSpeedWeek.findMany({
            where: { projectId, origin, formFactor },
            select: SPEED_WEEK_SELECT,
            orderBy: { periodEnd: "desc" },
            take: SPEED_WEEKS_SHOWN,
          })),
        );
      }
    }
    return {
      productionUrl: p!.productionUrl,
      origin,
      shown: p!.portalShowSpeed,
      portalEnabled: p!.portalEnabled,
      archived: p!.archivedAt !== null,
      check,
      series: seriesOf(rows),
    };
  });
}
