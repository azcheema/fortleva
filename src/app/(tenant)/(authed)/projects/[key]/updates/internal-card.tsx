import { useLocale, useTranslations } from "next-intl";

import { SectionCard } from "@/components/semantic";
import { formatDurationSeconds, formatMoney, formatPercent, type DurationStyle } from "@/lib/format";
import type { InternalView } from "@/modules/work/updates";

/**
 * THE STAFF-ONLY TWIN OF A PUBLISHED POST — per-member hours, cost and
 * margin, budget burn — frozen at publish onto the class-A
 * `ProjectUpdateInternalSnapshot`. Never rendered on the portal plane:
 * it takes `InternalView`, a type the portal projection cannot
 * produce, and `getUpdate` has already gated each part on the code that
 * gates its live source, so a null here means "not yours to see" as
 * much as "not recorded".
 */
export function InternalCard({
  internal,
  currency,
  durationStyle,
}: {
  internal: InternalView;
  currency: string | null;
  durationStyle: DurationStyle;
}) {
  const t = useTranslations("projects.updates.detail");
  const locale = useLocale();
  const hours = (seconds: number) => formatDurationSeconds(locale, seconds, durationStyle);
  const money = (amount: string, cur: string | null) => (cur ? formatMoney(locale, Number(amount), cur) : amount);
  const empty = internal.byMember === null && internal.cost === null && internal.budget === null;

  return (
    <SectionCard title={t("internalTitle")} description={t("internalHint")} size="sm" id="internal-card">
      {empty ? (
        <p className="text-sm text-muted-foreground">{t("noInternal")}</p>
      ) : (
        <div className="flex flex-col gap-4 text-sm">
          {internal.byMember ? (
            <div className="flex flex-col gap-1">
              <p className="eyebrow text-muted-foreground">{t("byMember")}</p>
              {internal.byMember.length === 0 ? (
                <p className="text-muted-foreground">{hours(0)}</p>
              ) : (
                <ul className="flex flex-col gap-0.5">
                  {internal.byMember.map((m) => (
                    <li key={m.memberId} className="flex items-center justify-between gap-3">
                      <span className="truncate">{m.name}</span>
                      <span className="num shrink-0">{hours(m.seconds)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
          {internal.cost ? (
            <div className="flex flex-col gap-1">
              <p className="eyebrow text-muted-foreground">{t("cost")}</p>
              <dl className="grid grid-cols-3 gap-2">
                <div>
                  <dt className="text-xs text-muted-foreground">{t("costValue")}</dt>
                  <dd className="num">{money(internal.cost.value, internal.cost.currency ?? currency)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t("costCost")}</dt>
                  <dd className="num">{money(internal.cost.cost, internal.cost.currency ?? currency)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t("costMargin")}</dt>
                  <dd className="num">
                    {money(internal.cost.margin, internal.cost.currency ?? currency)}
                    {internal.cost.marginPercent !== null
                      ? ` (${formatPercent(locale, internal.cost.marginPercent / 100)})`
                      : ""}
                  </dd>
                </div>
              </dl>
              {internal.cost.uncostedSeconds > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t("uncosted", { hours: hours(internal.cost.uncostedSeconds) })}
                </p>
              ) : null}
            </div>
          ) : null}
          {internal.budget ? (
            <div className="flex flex-col gap-1">
              <p className="eyebrow text-muted-foreground">{t("budget")}</p>
              <p className="num">
                {t("budgetUsed", {
                  used:
                    internal.budget.kind === "HOURS"
                      ? hours(internal.budget.usedSeconds)
                      : internal.budget.usedAmount
                        ? money(internal.budget.usedAmount, internal.budget.currency ?? currency)
                        : hours(internal.budget.usedSeconds),
                  amount:
                    internal.budget.kind === "HOURS"
                      ? hours(Math.round(Number(internal.budget.amount) * 3600))
                      : money(internal.budget.amount, internal.budget.currency ?? currency),
                  percent: formatPercent(locale, internal.budget.usedPercent / 100),
                })}
              </p>
              <p className="text-xs text-muted-foreground">{t("budgetPeriod", { key: internal.budget.periodKey })}</p>
            </div>
          ) : null}
        </div>
      )}
    </SectionCard>
  );
}
