import { PlusIcon, ReceiptIcon } from "lucide-react";
import Link from "next/link";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";

import { effectivePermissions } from "@/authz/authorize";
import { AuthzError } from "@/authz/errors";
import { EmptyState, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { withTenant } from "@/db";
import { resolveTimeZone } from "@/i18n/resolve";
import { localDateString } from "@/lib/duration";
import { formatDurationSeconds, formatMoney } from "@/lib/format";
import { monthContaining } from "@/lib/week";
import { requireTenantContext } from "@/members/tenant-context";
import { agreementConsumption, listBillRateCards, type RateCardView } from "@/modules/time";
import { CURRENCIES, readPreferences } from "@/preferences/service";
import { listServices } from "@/services/service";

import { CreateRateCardForm, RateCardTable, type RateCardRow } from "@/app/(tenant)/(authed)/settings/rates/rate-cards";

import { loadClient } from "../data";
import { CreateServiceForm, ServicesList } from "../overview-forms";

/**
 * Agreements tab (UI.md §3.1, 2T D4): the client's Service rows
 * presented as agreements — what the client buys — each with its open
 * BILL rate (rate:view_bill; the column does not exist without it, rule
 * 14) and this month's consumption, plus the SERVICE-scoped rate cards
 * and an add-a-rate form pinned to this client's agreements
 * (rate:manage_bill). Creating and ending agreements is service:*, as
 * on the old Overview card.
 */
export default async function ClientAgreementsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const client = await loadClient(id);
  const { membership, actor } = await requireTenantContext();
  const ctx = { tenantId: membership.tenantId, actor };
  const t = await getTranslations("clients");
  const tRates = await getTranslations("settings.rates");
  const locale = await getLocale();
  const format = await getFormatter();
  const timezone = await resolveTimeZone();
  const returnTo = `/clients/${client.id}/agreements`;

  const [services, { held, prefs }] = await Promise.all([
    client.caps.viewServices ? listServices(ctx, { clientId: client.id }) : Promise.resolve([]),
    withTenant(membership.tenantId, { type: "member", id: membership.memberId }, async (tx) => {
      const [held, prefs] = await Promise.all([effectivePermissions(tx, actor.memberId), readPreferences(tx, membership.tenantId)]);
      return { held, prefs };
    }),
  ]);
  const canViewBill = held.has("rate:view_bill");
  const canManageBill = held.has("rate:manage_bill");
  const canReprice = held.has("time:reprice");
  const canAddService = client.caps.createServices && client.status === "ACTIVE";
  const today = localDateString(new Date(), timezone);
  const month = monthContaining(today);

  // This month's hours per agreement (a SUM, never a ledger) — scoped by the service.
  const usage: Record<string, string> = {};
  await Promise.all(
    services.map(async (s) => {
      try {
        const c = await agreementConsumption(ctx, s.id, month);
        if (c.seconds > 0) usage[s.id] = formatDurationSeconds(locale, c.seconds, prefs.durationStyle);
      } catch (e) {
        if (!(e instanceof AuthzError)) throw e;
      }
    }),
  );

  // The SERVICE-scoped cards of this client's agreements (rate:view_bill).
  let cards: RateCardView[] = [];
  if (canViewBill && services.length > 0) {
    const ids = new Set(services.map((s) => s.id));
    try {
      cards = (await listBillRateCards(ctx, { scope: "SERVICE" })).filter((c) => c.serviceId && ids.has(c.serviceId));
    } catch (e) {
      if (!(e instanceof AuthzError)) throw e;
    }
  }
  const serviceName = new Map(services.map((s) => [s.id, s.name]));
  const rateLabel = (amount: string | null, currency: string) =>
    amount === null ? null : `${formatMoney(locale, Number(amount), currency)}${tRates("perHour")}`;
  const dateLabel = (iso: string) => format.dateTime(new Date(`${iso}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" });
  const rows: RateCardRow[] = cards.map((c) => ({
    id: c.id,
    kind: c.kind,
    scope: c.scope,
    appliesTo: serviceName.get(c.serviceId ?? "") ?? tRates("unknownService"),
    rateLabel: rateLabel(c.amount, c.currency),
    fromLabel: dateLabel(c.effectiveFrom),
    toLabel: c.effectiveTo ? dateLabel(c.effectiveTo) : null,
    effectiveFrom: c.effectiveFrom,
    open: c.effectiveTo === null,
  }));
  const openRows = [...rows.filter((r) => r.open), ...rows.filter((r) => !r.open)];
  // The rate column: the open SERVICE card today, one per agreement (the EXCLUDE guarantees at most one).
  const rates: Record<string, string | null> | undefined = canViewBill
    ? Object.fromEntries(
        services.map((s) => {
          const current = cards.find(
            (c) => c.serviceId === s.id && c.effectiveFrom <= today && (c.effectiveTo === null || c.effectiveTo > today),
          );
          return [s.id, current ? rateLabel(current.amount, current.currency) : null];
        }),
      )
    : undefined;

  return (
    <div className="flex flex-col gap-6">
      <SectionCard title={t("agreements.title")} description={t("agreements.description")} contentClassName="p-0">
        {services.length === 0 ? (
          <div className="px-4">
            {canAddService ? (
              <EmptyState
                variant="empty"
                icon={ReceiptIcon}
                title={t("services.empty")}
                body={t("services.emptyDescription")}
                action={
                  <Button asChild size="sm">
                    <Link href="#new-service">
                      <PlusIcon />
                      {t("services.add")}
                    </Link>
                  </Button>
                }
              />
            ) : (
              <EmptyState
                variant="forbidden"
                icon={ReceiptIcon}
                title={t("services.emptyReadOnly")}
                body={t("services.emptyReadOnlyDescription")}
              />
            )}
          </div>
        ) : (
          <ServicesList
            clientId={client.id}
            services={services}
            canEdit={client.caps.editServices}
            canDelete={client.caps.deleteServices}
            rates={rates}
            usage={usage}
            defaultCurrency={prefs.currencyDefault}
          />
        )}
        {canAddService ? (
          <div id="new-service" className="scroll-mt-16 border-t border-border p-4">
            <CreateServiceForm clientId={client.id} projects={client.projects.map((p) => ({ id: p.id, key: p.key, name: p.name }))} defaultCurrency={prefs.currencyDefault} />
          </div>
        ) : null}
      </SectionCard>

      {canViewBill && services.length > 0 ? (
        <SectionCard title={t("agreements.rates.title")} description={t("agreements.rates.description")} contentClassName="p-0">
          <RateCardTable
            rows={openRows}
            canClose={canManageBill}
            canReprice={canReprice}
            today={today}
            returnTo={returnTo}
            scrollLabel={t("agreements.rates.title")}
            emptyTitle={t("agreements.rates.empty")}
            emptyBody={t("agreements.rates.emptyBody")}
            addHref={canManageBill ? "#new-agreement-rate" : undefined}
            addLabel={canManageBill ? tRates("bill.add") : undefined}
          />
          {canManageBill ? (
            <div id="new-agreement-rate" className="scroll-mt-16 border-t border-border p-4">
              <h3 className="mb-3 text-sm font-semibold">{t("agreements.rates.add")}</h3>
              <CreateRateCardForm
                kind="BILL"
                fixedScope="SERVICE"
                options={{
                  members: [],
                  projects: [],
                  services: services.filter((s) => s.status !== "ENDED").map((s) => ({ id: s.id, label: s.name })),
                }}
                currencies={CURRENCIES}
                defaultCurrency={services.find((s) => s.currency)?.currency ?? prefs.currencyDefault}
                today={today}
                returnTo={returnTo}
              />
            </div>
          ) : null}
        </SectionCard>
      ) : null}
    </div>
  );
}
