import type { Metadata } from "next";
import { EyeOffIcon, PlusIcon, ShieldCheckIcon } from "lucide-react";
import Link from "next/link";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";

import { effectivePermissions } from "@/authz/authorize";
import { AuthzError } from "@/authz/errors";
import { handleAuthzRedirect, mfaRedirectTarget } from "@/authz/redirects";
import { listClients } from "@/clients/service";
import { Callout, EmptyState, Page, PageHeader, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { withTenant } from "@/db";
import { resolveTimeZone } from "@/i18n/resolve";
import { localDateString } from "@/lib/duration";
import { formatMoney } from "@/lib/format";
import { requireTenantContext } from "@/members/tenant-context";
import { listBillRateCards, listCostRateCards, revealCostRates, type RateCardView } from "@/modules/time";
import { CURRENCIES, readPreferences } from "@/preferences/service";
import { listProjects } from "@/projects/service";
import { listServices } from "@/services/service";

import { CostLayerSwitch, CreateRateCardForm, RateCardTable, type RateCardRow, type ScopeOptions } from "./rate-cards";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("rates") };
}

const PATH = "/settings/rates";

/**
 * /settings/rates (PLAN.md 2T screens; UI.md §3.1, rule 12, rule 14):
 * BILL cards — by workspace, member, project, member-on-project or
 * agreement — for rate:view_bill, managed with rate:manage_bill; the
 * pinned rate-change wording on the form and in the toast; Reprice as
 * the audited correction (time:reprice). COST cards are the ✦ half:
 * listed (metadata) only behind a fresh factor, amounts revealed only
 * with `?cost=1` through the audited revealCostRates, and the tenant's
 * cost layer switch (settings:edit) lives beside them.
 */
export default async function RatesPage({ searchParams }: { searchParams: Promise<{ cost?: string }> }) {
  const { membership, actor } = await requireTenantContext();
  const ctx = { tenantId: membership.tenantId, actor };
  const t = await getTranslations("settings.rates");
  const tCommon = await getTranslations("common");
  const locale = await getLocale();
  const format = await getFormatter();
  const timezone = await resolveTimeZone();
  const sp = await searchParams;

  let bill: RateCardView[] | null = null;
  try {
    bill = await listBillRateCards(ctx);
  } catch (e) {
    if (!(e instanceof AuthzError)) throw e;
  }
  if (!bill) {
    return (
      <Page width="form">
        <PageHeader title={t("title")} />
        <div className="mt-6">
          <SectionCard>
            <EmptyState variant="forbidden" title={tCommon("forbiddenTitle")} body={t("noPermission")} />
          </SectionCard>
        </div>
      </Page>
    );
  }

  // The label sources are other modules' view codes; a rate viewer who
  // lacks one simply gets ids labelled "outside your scope", not a 500.
  const orEmpty = <T,>(p: Promise<T[]>): Promise<T[]> =>
    p.catch((e: unknown) => {
      if (e instanceof AuthzError) return [];
      throw e;
    });
  const [{ held, prefs, members }, projectGroups, services, clients] = await Promise.all([
    withTenant(membership.tenantId, { type: "member", id: membership.memberId }, async (tx) => {
      const [held, prefs, members] = await Promise.all([
        effectivePermissions(tx, actor.memberId),
        readPreferences(tx, membership.tenantId),
        tx.member.findMany({
          select: { id: true, status: true, user: { select: { name: true } } },
          orderBy: { joinedAt: "asc" },
        }),
      ]);
      return { held, prefs, members };
    }),
    orEmpty(listProjects(ctx, { includeArchived: true })),
    orEmpty(listServices(ctx)),
    orEmpty(listClients(ctx, { includeArchived: true })),
  ]);

  const canManageBill = held.has("rate:manage_bill");
  const canViewCost = held.has("rate:view_cost");
  const canManageCost = held.has("rate:manage_cost");
  const canReprice = held.has("time:reprice");
  const canEditSettings = held.has("settings:edit");
  const today = localDateString(new Date(), timezone);

  // Labels, resolved here so the client table never formats anything.
  const memberName = new Map(members.map((m) => [m.id, m.user.name]));
  const projects = projectGroups.flatMap((g) => g.projects);
  const projectLabel = new Map(projects.map((p) => [p.id, `${p.key} · ${p.name}`]));
  const clientName = new Map(clients.map((c) => [c.id, c.name]));
  const serviceLabel = new Map(
    services.map((s) => [s.id, `${s.name} · ${s.projectKey ?? clientName.get(s.clientId) ?? ""}`.replace(/ · $/, "")]),
  );
  const appliesTo = (c: RateCardView): string => {
    switch (c.scope) {
      case "TENANT":
        return t("workspaceDefault");
      case "MEMBER":
        return memberName.get(c.memberId ?? "") ?? t("unknownMember");
      case "PROJECT":
        return projectLabel.get(c.projectId ?? "") ?? t("unknownProject");
      case "PROJECT_MEMBER":
        return `${memberName.get(c.memberId ?? "") ?? t("unknownMember")} · ${projectLabel.get(c.projectId ?? "") ?? t("unknownProject")}`;
      case "SERVICE":
        return serviceLabel.get(c.serviceId ?? "") ?? t("unknownService");
    }
  };
  const dateLabel = (iso: string) => format.dateTime(new Date(`${iso}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" });
  const rateLabel = (amount: string | null, currency: string) =>
    amount === null ? null : `${formatMoney(locale, Number(amount), currency)}${t("perHour")}`;
  const toRow = (c: RateCardView, amount: string | null): RateCardRow => ({
    id: c.id,
    kind: c.kind,
    scope: c.scope,
    appliesTo: appliesTo(c),
    rateLabel: rateLabel(amount, c.currency),
    fromLabel: dateLabel(c.effectiveFrom),
    toLabel: c.effectiveTo ? dateLabel(c.effectiveTo) : null,
    effectiveFrom: c.effectiveFrom,
    open: c.effectiveTo === null,
  });
  // Open cards first (the ones that apply), then history — each group as the service ordered it.
  const byOpen = (rows: RateCardRow[]) => [...rows.filter((r) => r.open), ...rows.filter((r) => !r.open)];
  const billRows = byOpen(bill.map((c) => toRow(c, c.amount)));

  // ── the ✦ half ──────────────────────────────────────────────────────
  // Listing COST cards is itself ✦ (a fresh factor): a stale or missing
  // one is offered as a step-up link, never forced on page load. Only
  // the explicit `?cost=1` reveal redirects (then comes straight back).
  let costRows: RateCardRow[] | null = null;
  let costMfaHref: string | null = null;
  let costRevealed = false;
  if (canViewCost) {
    try {
      const cost = await listCostRateCards(ctx);
      let amounts: Record<string, string> = {};
      if (sp.cost === "1" && cost.length > 0) {
        try {
          amounts = await revealCostRates(ctx, cost.slice(0, 50).map((c) => c.id));
          costRevealed = true;
        } catch (e) {
          handleAuthzRedirect(e, `${PATH}?cost=1`);
          if (!(e instanceof AuthzError)) throw e;
        }
      }
      costRows = byOpen(cost.map((c) => toRow(c, amounts[c.id] ?? null)));
    } catch (e) {
      if (!(e instanceof AuthzError)) throw e;
      costMfaHref = mfaRedirectTarget(e, PATH);
    }
  }

  const options: ScopeOptions = {
    members: members.filter((m) => m.status === "ACTIVE").map((m) => ({ id: m.id, name: m.user.name })),
    projects: projects.filter((p) => p.status !== "ARCHIVED").map((p) => ({ id: p.id, label: projectLabel.get(p.id)! })),
    services: services.filter((s) => s.status !== "ENDED").map((s) => ({ id: s.id, label: serviceLabel.get(s.id)! })),
  };

  return (
    <Page width="form">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          canManageBill ? (
            <Button asChild size="sm">
              <Link href="#new-rate">
                <PlusIcon />
                {t("bill.add")}
              </Link>
            </Button>
          ) : null
        }
      />

      <div className="mt-6 flex flex-col gap-4">
        <SectionCard title={t("bill.title")} description={t("bill.description")} contentClassName="p-0">
          <RateCardTable
            rows={billRows}
            canClose={canManageBill}
            canReprice={canReprice}
            today={today}
            returnTo={PATH}
            scrollLabel={t("bill.title")}
            emptyTitle={t("bill.empty")}
            emptyBody={t("bill.emptyBody")}
            addHref={canManageBill ? "#new-rate" : undefined}
            addLabel={canManageBill ? t("bill.add") : undefined}
          />
        </SectionCard>

        {canManageBill ? (
          <SectionCard id="new-rate" className="scroll-mt-16" title={t("form.title")}>
            <CreateRateCardForm
              kind="BILL"
              options={options}
              currencies={CURRENCIES}
              defaultCurrency={prefs.currencyDefault}
              today={today}
              returnTo={PATH}
            />
          </SectionCard>
        ) : null}

        {canViewCost ? (
          <SectionCard
            title={
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden="true">{"✦"}</span>
                {t("cost.title")}
              </span>
            }
            description={<span id="cost-layer-hint">{t("cost.description")}</span>}
            actions={<CostLayerSwitch enabled={prefs.finance.costRatesEnabled} canEdit={canEditSettings} />}
            contentClassName="p-0"
          >
            {costRows === null ? (
              <div className="p-4">
                <Callout tone="info" role="status">
                  <span className="flex flex-wrap items-center justify-between gap-3">
                    <span>{t("cost.mfaRequired")}</span>
                    {costMfaHref ? (
                      <Button asChild size="sm" variant="outline" data-testid="cost-mfa-link">
                        <Link href={costMfaHref}>
                          <ShieldCheckIcon aria-hidden="true" />
                          {t("cost.confirm")}
                        </Link>
                      </Button>
                    ) : null}
                  </span>
                </Callout>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
                  <p className="text-xs text-muted-foreground">{t("cost.layerHint")}</p>
                  {costRows.length > 0 ? (
                    costRevealed ? (
                      <Button asChild variant="outline" size="sm" data-testid="cost-hide">
                        <Link href={PATH}>
                          <EyeOffIcon aria-hidden="true" />
                          {t("cost.hide")}
                        </Link>
                      </Button>
                    ) : (
                      <Button asChild size="sm" data-testid="cost-reveal">
                        <Link href={`${PATH}?cost=1`}>
                          <span aria-hidden="true">{"✦"}</span>
                          {t("cost.reveal")}
                        </Link>
                      </Button>
                    )
                  ) : null}
                </div>
                {costRevealed ? (
                  <div className="px-4 pt-3">
                    <Callout tone="info" role="status">
                      <span className="inline-flex items-center gap-1.5">
                        <ShieldCheckIcon aria-hidden="true" className="size-4" />
                        {t("cost.revealed")}
                      </span>
                    </Callout>
                  </div>
                ) : null}
                <RateCardTable
                  rows={costRows}
                  canClose={canManageCost}
                  canReprice={canReprice}
                  today={today}
                  returnTo={PATH}
                  scrollLabel={t("cost.title")}
                  emptyTitle={t("cost.empty")}
                  emptyBody={t("cost.emptyBody")}
                  addHref={canManageCost ? "#new-cost-rate" : undefined}
                  addLabel={canManageCost ? t("cost.add") : undefined}
                />
                {canManageCost ? (
                  <div id="new-cost-rate" className="scroll-mt-16 border-t border-border p-4">
                    <h3 className="mb-3 text-sm font-semibold">{t("form.costTitle")}</h3>
                    <CreateRateCardForm
                      kind="COST"
                      options={options}
                      currencies={CURRENCIES}
                      defaultCurrency={prefs.currencyDefault}
                      today={today}
                      returnTo={PATH}
                    />
                  </div>
                ) : null}
              </>
            )}
          </SectionCard>
        ) : null}
      </div>
    </Page>
  );
}
