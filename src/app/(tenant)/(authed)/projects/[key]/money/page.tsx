import { ChevronLeftIcon, ChevronRightIcon, ClockIcon, DownloadIcon, EyeOffIcon, ShieldCheckIcon } from "lucide-react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";

import { isAuthorized } from "@/authz/authorize";
import { AuthzError } from "@/authz/errors";
import { handleAuthzRedirect } from "@/authz/redirects";
import { Callout, DataTable, EmptyState, MetricTile, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { withTenant } from "@/db";
import { resolveTimeZone } from "@/i18n/resolve";
import { localDateString } from "@/lib/duration";
import { formatDurationSeconds, formatMoney, formatPercent } from "@/lib/format";
import { isIsoDate, monthContaining } from "@/lib/week";
import { requireTenantContext } from "@/members/tenant-context";
import { getProjectBudget, projectMoney, type MoneyLine } from "@/modules/time";
import { readPreferences } from "@/preferences/service";

import { loadProject } from "../data";

/**
 * /projects/[key]/money (PLAN.md 2T screens; UI.md rule 14): the
 * finance view of one project for a month range. "Rate / Value" is the
 * bill half (time:view_team + rate:view_bill); "Internal cost / Margin"
 * is the ✦ half — offered to holders of rate:view_cost when the tenant's
 * cost layer is on, revealed only with `?cost=1`, which the service
 * answers with MFA_REQUIRED for a stale factor → step-up → back here
 * with the same URL. Every reveal is audited (rate_card.cost_revealed).
 * Cost never reaches a CSV, the portal or a cache from this page.
 */
export default async function ProjectMoneyPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<{ from?: string; to?: string; cost?: string }>;
}) {
  const { key } = await params;
  const project = await loadProject(key);
  const { membership, actor } = await requireTenantContext();
  const ctx = { tenantId: membership.tenantId, actor };
  const t = await getTranslations("projects.money");
  const tTime = await getTranslations("projects.time");
  const tCommon = await getTranslations("common");
  const locale = await getLocale();
  const timezone = await resolveTimeZone();
  const sp = await searchParams;
  // Held, not exercised: the export control shows for time:export holders; the route re-checks on use.
  const [prefs, canExport] = await withTenant(membership.tenantId, { type: "member", id: membership.memberId }, (tx) =>
    Promise.all([readPreferences(tx, membership.tenantId), isAuthorized(tx, actor, "time:export")]),
  );
  const today = localDateString(new Date(), timezone);
  const month = monthContaining(today);
  const range = { from: isIsoDate(sp.from) ? sp.from : month.from, to: isIsoDate(sp.to) ? sp.to : month.to };
  const revealCost = sp.cost === "1";
  const base = `/projects/${project.key}/money`;
  const urlFor = (r: { from: string; to: string }, cost: boolean) =>
    `${base}?from=${r.from}&to=${r.to}${cost ? "&cost=1" : ""}`;

  let money: Awaited<ReturnType<typeof projectMoney>> | null = null;
  let budget: Awaited<ReturnType<typeof getProjectBudget>> = null;
  try {
    money = await projectMoney(ctx, project.id, range, { revealCost });
    try {
      budget = await getProjectBudget(ctx, project.id);
    } catch (e) {
      if (!(e instanceof AuthzError)) throw e;
    }
  } catch (e) {
    // A stale/missing factor on the ✦ half is navigation, not a denial:
    // step-up (or enrol), then straight back to this exact view.
    handleAuthzRedirect(e, urlFor(range, true));
    if (!(e instanceof AuthzError)) throw e;
  }

  if (!money) {
    return (
      <SectionCard>
        <EmptyState variant="forbidden" title={tCommon("forbiddenTitle")} body={t("noPermission")} />
      </SectionCard>
    );
  }

  const fmt = (seconds: number) => formatDurationSeconds(locale, seconds, prefs.durationStyle);
  const amount = (value: string | null) =>
    value !== null && money.currency ? formatMoney(locale, Number(value), money.currency) : value;
  const pct = (p: number | null) => (p === null ? null : formatPercent(locale, p / 100, 1));
  const prevMonth = monthContaining(shiftMonth(range.from, -1));
  const nextMonth = monthContaining(shiftMonth(range.from, 1));
  const revealed = money.costRevealed;
  const showCostColumns = revealed;
  const moneyBudget = budget && budget.budget.kind === "MONEY" ? budget : null;

  // A render helper, not a component: called as a function so React keeps no state for it.
  const lineTable = (title: string, lines: MoneyLine[], labelHeader: string) => (
    <SectionCard title={title} contentClassName="p-0">
      {lines.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">{tTime("noRows")}</p>
      ) : (
        <DataTable flush density="compact" scrollLabel={title}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{labelHeader}</TableHead>
                <TableHead priority="medium" className="w-[10ch] text-right">{tTime("columns.hours")}</TableHead>
                <TableHead priority="low" className="w-[10ch] text-right">{tTime("columns.billable")}</TableHead>
                <TableHead className="w-[14ch] text-right">{t("columns.value")}</TableHead>
                {showCostColumns ? (
                  <>
                    <TableHead className="w-[14ch] text-right">{t("columns.cost")}</TableHead>
                    <TableHead className="w-[16ch] text-right">{t("columns.margin")}</TableHead>
                  </>
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((l) => {
                const label = l.label || tTime("unassigned");
                return (
                  <TableRow key={l.key}>
                    {/* THE LABEL IS THE ONLY COLUMN HERE WITHOUT A WIDTH, so it
                        was the one that forced this table past its box: a
                        `TableCell` is `whitespace-nowrap`, and `byEpic`/`byItem`
                        label a line "{key} {title}" — 34 characters of a task
                        title, uncapped, is a column floor. Measured on CI run
                        35400146183: "By epic" and "By task" 21px past a 356px
                        box on the phone walk, in BOTH themes, and 0 at every
                        other width — which is the whole shape of the defect,
                        since the value column is the only other one that
                        renders there. The same answer as `/clients` and the
                        time week (UI.md §10.12): `contain-inline-size` +
                        `w-full` takes the wrapper out of the column's intrinsic
                        sizing, so the column takes the remainder (254px at a
                        356px box) and the label truncates inside it instead of
                        widening it. "By member" and "By agreement" sat at 0 only
                        because a member's name and a service's are SHORTER —
                        the same latent floor, so the one helper fixes all four.
                        TEN rem and not `/clients`' fourteen, measured per
                        table: the floor never binds in the state the walk
                        photographs — the remainder is 254px at a 356px box,
                        the smallest of the seven measured (254, 392, 504,
                        559, 488, 734, 886; it dips at the 736px box, where
                        the `low` billable column arrives) — so the ONE place
                        it can bind is the ✦ revealed state, where cost and
                        margin are `high` too and a 356px box has ~24px left
                        after the three money columns. THE TRADE THERE, stated
                        rather than skipped (review): a floor buys a readable
                        label at the price of scroll, and for "By member" and
                        "By agreement" — whose labels were never going to force
                        anything — it is ~54px of scroll they did not have
                        before. It is still the right way round. Without it
                        that state truncates every label to three characters,
                        which is a row that names nothing while it prints a
                        number, and the identity column is the last thing a
                        table should spend; `/clients` made the same call at
                        14rem. Ten keeps the price as low as a readable label
                        allows. None of this is measured — the walk loads this
                        stop without `?cost=1` — and the real answer for a
                        phone in the revealed state is a rung on cost and
                        margin, which changes what a ✦ reveal shows and is the
                        founder's call, not this slice's. */}
                    <TableCell className="min-w-40">
                      <span className="flex w-full min-w-0 items-center contain-inline-size">
                        {/* §10.12: an identifying cell that truncates carries the
                            full text as its own `title`. */}
                        <span className="truncate" title={label}>
                          {label}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell priority="medium" className="num text-right text-muted-foreground">{fmt(l.seconds)}</TableCell>
                    <TableCell priority="low" className="num text-right text-muted-foreground">{fmt(l.billableSeconds)}</TableCell>
                    <TableCell className="num text-right font-semibold">{amount(l.value)}</TableCell>
                    {showCostColumns ? (
                      <>
                        <TableCell className="num text-right">{amount(l.cost) ?? "—"}</TableCell>
                        <TableCell className="num text-right">
                          {l.margin !== null ? (
                            <span className="inline-flex items-baseline gap-1.5">
                              <span>{amount(l.margin)}</span>
                              {l.marginPercent !== null ? (
                                <span className="text-xs text-muted-foreground">{pct(l.marginPercent)}</span>
                              ) : null}
                            </span>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                      </>
                    ) : null}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </DataTable>
      )}
    </SectionCard>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{tTime("range", { from: range.from, to: range.to })}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline" size="icon-sm" aria-label={tTime("prevMonth")}>
            <Link href={urlFor(prevMonth, revealed)}>
              <ChevronLeftIcon aria-hidden="true" />
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href={revealed ? urlFor(month, true) : base}>{tTime("thisMonth")}</Link>
          </Button>
          <Button asChild variant="outline" size="icon-sm" aria-label={tTime("nextMonth")}>
            <Link href={urlFor(nextMonth, revealed)}>
              <ChevronRightIcon aria-hidden="true" />
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href={`/projects/${project.key}/time?from=${range.from}&to=${range.to}`}>
              <ClockIcon aria-hidden="true" />
              {t("timeLink")}
            </Link>
          </Button>
          {/* ✦: the control shows for holders; a stale factor becomes step-up on click (AUTHZ.md §7.5). */}
          {money.canRevealCost && !revealed ? (
            <Button asChild size="sm" data-testid="money-reveal-cost">
              <Link href={urlFor(range, true)}>
                <span aria-hidden="true">{"✦"}</span>
                {t("reveal")}
              </Link>
            </Button>
          ) : null}
          {revealed ? (
            <Button asChild variant="outline" size="sm" data-testid="money-hide-cost">
              <Link href={urlFor(range, false)}>
                <EyeOffIcon aria-hidden="true" />
                {t("hide")}
              </Link>
            </Button>
          ) : null}
          {canExport ? (
            // A download, not a navigation. The rollup CSV carries cost + margin ONLY in the revealed
            // state (the route runs the same audited ✦ reveal again — every export is audited).
            <Button asChild variant="outline" size="sm" title={revealed ? t("exportCsvCostHint") : undefined} data-testid="money-export-csv">
              <a href={`/projects/${project.key}/time/export?kind=rollup&from=${range.from}&to=${range.to}${revealed ? "&cost=1" : ""}`}>
                <DownloadIcon aria-hidden="true" />
                {revealed ? (
                  <>
                    <span aria-hidden="true">{"✦"}</span>
                    {t("exportCsvCost")}
                  </>
                ) : (
                  t("exportCsv")
                )}
              </a>
            </Button>
          ) : null}
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        {t("description")}
        {money.canRevealCost && !revealed ? (
          <>
            {" "}
            <span aria-hidden="true">{"✦"}</span> {t("revealHint")}
          </>
        ) : null}
      </p>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="money-tiles">
        <MetricTile
          label={t("tiles.billableHours")}
          value={fmt(money.totals.billableSeconds)}
          unit={money.totals.effectiveRate !== null ? t("tiles.effectiveRate", { rate: amount(money.totals.effectiveRate) ?? "" }) : undefined}
        />
        <MetricTile label={t("tiles.value")} value={amount(money.totals.value) ?? money.totals.value} />
        {money.canRevealCost ? (
          <>
            <MetricTile
              label={t("tiles.cost")}
              value={revealed ? (amount(money.totals.cost) ?? "—") : "—"}
              unit={revealed ? undefined : t("tiles.hidden")}
            />
            <MetricTile
              label={t("tiles.margin")}
              value={revealed && money.totals.margin !== null ? (amount(money.totals.margin) ?? "—") : "—"}
              unit={revealed ? (pct(money.totals.marginPercent) ?? undefined) : t("tiles.hidden")}
            />
          </>
        ) : moneyBudget ? (
          <MetricTile
            label={t("tiles.budget")}
            value={amount(moneyBudget.budget.amount) ?? moneyBudget.budget.amount}
            unit={t("tiles.budgetUsed", { percent: String(moneyBudget.burn.percent) })}
          />
        ) : null}
      </div>

      {revealed ? (
        <Callout tone="info" role="status">
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheckIcon aria-hidden="true" className="size-4" />
            {t("revealed")}
          </span>
        </Callout>
      ) : null}
      {revealed && money.totals.uncostedSeconds > 0 ? (
        <Callout tone="caution" role="status">{t("uncosted", { hours: fmt(money.totals.uncostedSeconds) })}</Callout>
      ) : null}
      {revealed && money.currencyMismatch ? (
        <Callout tone="caution" role="status">{t("currencyMismatch")}</Callout>
      ) : null}

      {lineTable(t("byMember"), money.byMember, tTime("columns.member"))}
      {lineTable(t("byEpic"), money.byEpic, tTime("columns.epic"))}
      {lineTable(t("byItem"), money.byItem, tTime("columns.task"))}
      {lineTable(t("byAgreement"), money.byAgreement, tTime("columns.agreement"))}
    </div>
  );
}

/** First day of the month `delta` months away from `isoDate`'s month. */
const shiftMonth = (isoDate: string, delta: number): string => {
  const [y, m] = isoDate.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 10);
};
