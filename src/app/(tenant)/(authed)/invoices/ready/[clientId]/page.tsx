import type { Metadata } from "next";
import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";

import { AuthzError } from "@/authz/errors";
import { EmptyState, Page, PageHeader, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { withTenant } from "@/db";
import { isUuid } from "@/db/context";
import { formatDurationSeconds } from "@/lib/format";
import { requireTenantContext } from "@/members/tenant-context";
import { formatFixed, HOURS_PAGE_MAX, hoursQuantity, readClientHours, type ClientHours, type ReadyHour } from "@/modules/invoicing";
import { lineAmount } from "@/modules/invoicing/money";
import { readPreferences } from "@/preferences/service";

import { ReadyHours, type MarkedHourRow, type ReadyHourRow } from "./ready-hours";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("invoices.ready");
  return { title: t("title") };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const one = (v: string | string[] | undefined): string => (typeof v === "string" ? v : "");

/**
 * /invoices/ready/[clientId] (Phase 4 slice 110; founder decision C80 (a)) —
 * one client's billable hours not yet invoiced: choose them, choose how they
 * become lines, Create invoice (or, from a draft's "Add hours…", `?draft=`,
 * Add to draft); mark hours billed elsewhere or not to be invoiced, and undo.
 * `invoice:view` + `invoice:generate_from_time`, the client in DIRECT scope
 * (`readClientHours`). The filters are a plain GET form: the URL is the state.
 */
export default async function ClientHoursPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { clientId } = await params;
  const sp = await searchParams;
  const { membership, actor } = await requireTenantContext();
  const ctx = { tenantId: membership.tenantId, actor };
  const t = await getTranslations("invoices.hours");
  const tCommon = await getTranslations("common");
  const locale = await getLocale();
  const format = await getFormatter();

  const filter = {
    from: DAY.test(one(sp.from)) ? one(sp.from) : null,
    to: DAY.test(one(sp.to)) ? one(sp.to) : null,
    // Absent (never chosen): the draft's own project, when there is a draft.
    projectId: sp.project === undefined ? undefined : isUuid(one(sp.project)) ? one(sp.project) : null,
    currency: /^[A-Z]{3}$/.test(one(sp.currency)) ? one(sp.currency) : null,
    draftId: isUuid(one(sp.draft)) ? one(sp.draft) : null,
  };

  let data: ClientHours | null = null;
  if (isUuid(clientId)) {
    try {
      data = await readClientHours(ctx, clientId, filter);
    } catch (e) {
      if (!(e instanceof AuthzError)) throw e;
    }
  }
  if (!data) {
    // Out of scope, unknown and forbidden read alike: nothing about the
    // client is said to a member who may not see it.
    return (
      <Page>
        <PageHeader title={t("back")} />
        <div className="mt-6">
          <SectionCard>
            <EmptyState variant="forbidden" title={tCommon("forbiddenTitle")} body={t("noPermission")} />
          </SectionCard>
        </div>
      </Page>
    );
  }

  const prefs = await withTenant(membership.tenantId, { type: "member", id: membership.memberId }, (tx) => readPreferences(tx, membership.tenantId));
  const hours = (seconds: number) => formatDurationSeconds(locale, seconds, prefs.durationStyle);
  const dateLabel = (iso: string) => format.dateTime(new Date(`${iso}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" });
  const what = (h: ReadyHour) => (h.task ? `${h.task.ref} ${h.task.title}` : h.note?.trim() || t("projectWork"));
  const rows: ReadyHourRow[] = data.hours.map((h) => ({
    id: h.id,
    dateLabel: dateLabel(h.date),
    projectId: h.project.id,
    projectKey: h.project.key,
    projectName: h.project.name,
    what: what(h),
    memberId: h.member.id,
    memberName: h.member.name,
    tracked: hours(h.rawSeconds),
    billed: hours(h.billedSeconds),
    billedSeconds: h.billedSeconds,
    rate: h.rate === null ? null : formatFixed(h.rate, 2),
    taskId: h.taskId,
    sharedTaskTitle: h.sharedTaskTitle,
    serviceId: h.agreement?.id ?? null,
    visibleAgreementName: h.visibleAgreementName,
    needsReview: h.needsReview,
  }));
  const marked: MarkedHourRow[] = data.marked.map((m) => ({
    id: m.id,
    dateLabel: dateLabel(m.date),
    projectKey: m.project.key,
    what: what(m),
    memberName: m.member.name,
    billed: hours(m.billedSeconds),
    mark: m.mark,
    amount: m.rate === null ? null : formatFixed(lineAmount(hoursQuantity(m.billedSeconds), m.rate), 2),
    currency: m.currency,
  }));
  const currency = data.currency ?? data.currencies[0] ?? prefs.currencyDefault;
  const projectOptions = data.projects.map((p) => ({ id: p.id, label: `${p.key} ${p.name}` }));
  const draft = data.draft;
  const back = draft ? `/invoices/${draft.id}` : "/invoices#ready-to-invoice";

  return (
    <Page>
      <PageHeader
        title={t("title", { client: data.client.name })}
        description={draft ? t("descriptionDraft") : t("description")}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href={back}>
              <ArrowLeftIcon aria-hidden />
              {draft ? t("backToDraft") : t("back")}
            </Link>
          </Button>
        }
      />
      <div className="mt-6 flex flex-col gap-4">
        {data.client.archived ? <p className="text-sm text-(--tone-caution-fg)">{t("archivedClient")}</p> : null}
        {draft ? <p className="text-sm text-muted-foreground">{t("draftNote", { currency: draft.currency })}</p> : null}
        <SectionCard title={t("filters.title")}>
          <form method="get" className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end" data-testid="hours-filter">
            {draft ? <input type="hidden" name="draft" value={draft.id} /> : null}
            <div className="flex flex-col gap-1">
              <Label htmlFor="hours-from">{t("filters.from")}</Label>
              <Input id="hours-from" type="date" name="from" defaultValue={filter.from ?? ""} className="w-full sm:w-44" />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="hours-to">{t("filters.to")}</Label>
              <Input id="hours-to" type="date" name="to" defaultValue={filter.to ?? ""} className="w-full sm:w-44" />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <Label htmlFor="hours-project">{t("filters.project")}</Label>
              <NativeSelect id="hours-project" name="project" defaultValue={data.projectId ?? ""} className="w-full sm:w-56">
                <option value="">{t("filters.allProjects")}</option>
                {projectOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </NativeSelect>
            </div>
            {!draft && data.currencies.length > 1 ? (
              <div className="flex flex-col gap-1">
                <Label htmlFor="hours-currency">{t("filters.currency")}</Label>
                <NativeSelect id="hours-currency" name="currency" defaultValue={currency} className="w-full sm:w-28">
                  {data.currencies.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            ) : null}
            <Button type="submit" variant="outline">
              {t("filters.apply")}
            </Button>
          </form>
        </SectionCard>
        <ReadyHours
          key={`${filter.from}|${filter.to}|${data.projectId}|${currency}`}
          clientId={data.client.id}
          rows={rows}
          more={data.more}
          marked={marked}
          markedMore={data.markedMore}
          texts={data.texts}
          currency={currency}
          draft={draft ? { id: draft.id } : null}
          can={data.can}
          maxRows={HOURS_PAGE_MAX}
          filtered={Boolean(filter.from || filter.to || data.projectId)}
        />
      </div>
    </Page>
  );
}
