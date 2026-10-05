import { useLocale, useTranslations } from "next-intl";
import { getTranslations } from "next-intl/server";

import { Page, PageHeader, SectionCard, StatusBadge } from "@/components/semantic";
import { readPortalCompany } from "@/clients/portal";
import { formatDate, formatMoney } from "@/lib/format";
import { portalReadOrNull, type PortalPrincipal } from "@/portal";
import { listPortalServices, type PortalService } from "@/services/portal";

import { PortalFrame } from "../portal-frame";
import { PortalTasksEmpty } from "../task-list";

/**
 * `/portal/company`, AS A COMPONENT — the client's own company record
 * and the agreements between them and the agency, minus the decision
 * about who is asking (PLAN Phase 3 "read surfaces: … `Service`s, own
 * company record"; UI.md §4).
 *
 * A component and not a page for the reason `<PortalHome>` is:
 * `/view-as/company` renders it under a synthesised principal and
 * `e2e/view-as.spec.ts` byte-compares the two. Nothing in here reaches
 * for a request context.
 *
 * TWO SEQUENTIAL READS, each through `portalReadOrNull`. The company
 * record decides the page: refused, or somehow absent, and the whole
 * page is the plane's one empty state. The agreements are a SECTION
 * that is present or absent — absent for a collaborator, whose profile
 * does not hold `portal.service.view` because an agreement carries the
 * fee (money, AUTHZ §8), and absent for a primary contact whose agency
 * has shared none — and the two cases render identically, because
 * "your agency has agreements it has not shown you" is a fact about the
 * agency (`src/portal/render.ts`).
 *
 * THE RECORD IS DRAWN AS FACTS, NOT A FORM: a contact cannot edit it
 * (UI.md §4's exhaustive list of portal actions has no "edit company"),
 * and the copy says what to do instead — tell the agency.
 */
export async function PortalCompanyView({ principal, name }: { principal: PortalPrincipal; name: string }) {
  const t = await getTranslations("portal.company");
  const company = await portalReadOrNull("readPortalCompany", () => readPortalCompany(principal));
  const services = company
    ? await portalReadOrNull("listPortalServices", () => listPortalServices(principal))
    : null;

  return (
    <PortalFrame name={name} principal={principal} nav="company">
      <Page>
        <div className="flex flex-col gap-6">
          <PageHeader title={company ? company.name : t("title")} description={t("description")} />
          {!company ? (
            <PortalTasksEmpty />
          ) : (
            <>
              <SectionCard title={t("record")} description={t("recordDescription")}>
                <dl data-slot="portal-company" className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
                  <Fact label={t("name")} value={company.name} />
                  {company.orgNr ? <Fact label={t("orgNr")} value={company.orgNr} mono /> : null}
                  {company.vatNumber ? <Fact label={t("vatNumber")} value={company.vatNumber} mono /> : null}
                  {company.address ? (
                    <Fact
                      label={t("address")}
                      value={
                        <span className="flex flex-col">
                          {[
                            company.address.line1,
                            company.address.line2,
                            [company.address.postalCode, company.address.city].filter(Boolean).join(" "),
                            company.address.countryCode,
                          ]
                            .filter((line): line is string => Boolean(line))
                            .map((line, i) => (
                              <span key={`${i}-${line}`}>{line}</span>
                            ))}
                        </span>
                      }
                    />
                  ) : null}
                </dl>
              </SectionCard>

              {services && services.length > 0 ? (
                <SectionCard title={t("agreements")} description={t("agreementsDescription")} contentClassName="p-0">
                  <ul data-slot="portal-agreements" className="divide-y divide-border">
                    {services.map((s) => (
                      <Agreement key={s.id} service={s} />
                    ))}
                  </ul>
                </SectionCard>
              ) : null}
            </>
          )}
        </div>
      </Page>
    </PortalFrame>
  );
}

function Fact({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={mono ? "num-id font-mono text-sm text-foreground" : "text-sm text-foreground"}>{value}</dd>
    </div>
  );
}

/**
 * One agreement: the name with its status beside it, the description
 * written for the client, then one line of facts — one-off or
 * recurring and at what interval, the fee ex. VAT, the renewal or end
 * date, and the project it is tied to. The fee is drawn only when the
 * projection carried one (an amount AND a currency — `listPortalServices`
 * says why a bare amount is not a fact).
 */
function Agreement({ service }: { service: PortalService }) {
  // A sync component with the hooks, not an async one re-resolving the
  // namespace per row (code review) — `useTranslations` works in a
  // server component and reads the request's catalogue once.
  const t = useTranslations("portal.company");
  const locale = useLocale();
  const when =
    service.status === "ENDED" && service.endsAt
      ? t("ended", { date: formatDate(locale, service.endsAt) })
      : service.endsAt
        ? t("ends", { date: formatDate(locale, service.endsAt) })
        : service.renewsAt
          ? t("renews", { date: formatDate(locale, service.renewsAt) })
          : null;
  return (
    <li data-slot="portal-agreement" data-status={service.status} className="flex flex-col gap-1 p-4">
      <span className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-foreground">{service.name}</span>
        <StatusBadge domain="serviceStatus" value={service.status} />
      </span>
      {service.description ? <p className="text-sm text-muted-foreground">{service.description}</p> : null}
      <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        <span>
          {t(`kinds.${service.kind}`)}
          {service.billingInterval ? ` · ${t(`intervals.${service.billingInterval}`)}` : null}
        </span>
        {service.price ? (
          <span className="num">
            {t("priceExVat", {
              amount: formatMoney(locale, Number(service.price.amount), service.price.currency),
            })}
          </span>
        ) : null}
        {when ? <span>{when}</span> : null}
        {service.project ? <span>{t("project", { name: service.project.name })}</span> : null}
      </span>
    </li>
  );
}
