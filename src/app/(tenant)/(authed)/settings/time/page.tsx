import type { Metadata } from "next";
import { CircleCheckIcon, CircleDashedIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";

import { effectivePermissions } from "@/authz/authorize";
import { AuthzError } from "@/authz/errors";
import { DataTable, Disclosure, EmptyState, Page, PageHeader, SectionCard } from "@/components/semantic";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { withTenant } from "@/db";
import { requireTenantContext } from "@/members/tenant-context";
import { getCurrentNoticeTexts, listNoticeAcknowledgments, listWorkTypes, type NoticeTexts } from "@/modules/time";

import { NoticeBody } from "../../time/notice-gate";
import { NoticePublishForm } from "./notice-admin";
import { CreateWorkTypeForm, WorkTypesTable, type WorkTypeRowView } from "./work-types";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("timeSettings") };
}

/**
 * /settings/time (PLAN.md 2T screens; SECURITY.md §9.7.5; DATA_MODEL.md
 * §6.15 D5): the staff notice — current version, purposes, who has
 * acknowledged it, the text, and publishing a new version
 * (settings:edit; everyone re-acknowledges) — and the work-types
 * manager (work_type:manage). settings:view sees everything read-only.
 */
export default async function TimeSettingsPage() {
  const { membership, actor } = await requireTenantContext();
  const ctx = { tenantId: membership.tenantId, actor };
  const t = await getTranslations("settings.time");
  const tCommon = await getTranslations("common");
  const format = await getFormatter();

  let notice: NoticeTexts | null = null;
  let acks: Awaited<ReturnType<typeof listNoticeAcknowledgments>> | null = null;
  try {
    [notice, acks] = await Promise.all([getCurrentNoticeTexts(ctx), listNoticeAcknowledgments(ctx)]);
  } catch (e) {
    if (!(e instanceof AuthzError)) throw e;
  }
  if (!notice || !acks) {
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

  const [held, workTypes] = await Promise.all([
    withTenant(membership.tenantId, { type: "member", id: membership.memberId }, (tx) =>
      effectivePermissions(tx, actor.memberId),
    ),
    // The picker list needs time:track; a settings reader without it
    // simply does not get the work-types card.
    listWorkTypes(ctx, { includeArchived: true }).catch((e: unknown) => {
      if (e instanceof AuthzError) return null;
      throw e;
    }),
  ]);
  const canPublish = held.has("settings:edit");
  const canManageTypes = held.has("work_type:manage");

  const acknowledged = acks.members.filter((m) => m.acknowledgedAt !== null).length;
  const publishedLabel = notice.publishedAt ? format.dateTime(notice.publishedAt, { dateStyle: "medium" }) : null;
  const rows: WorkTypeRowView[] = (workTypes ?? []).map((w) => ({
    id: w.id,
    name: w.name,
    defaultBillable: w.defaultBillable,
    archived: w.archivedAt !== null,
  }));

  return (
    <Page width="form">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          canManageTypes ? (
            <Button asChild size="sm" variant="outline">
              <Link href="#new-work-type">
                <PlusIcon />
                {t("workTypes.add.submit")}
              </Link>
            </Button>
          ) : null
        }
      />

      <div className="mt-6 flex flex-col gap-4">
        <SectionCard
          title={t("notice.title")}
          description={
            notice.version !== null && publishedLabel
              ? t("notice.description", { version: notice.version, date: publishedLabel })
              : t("notice.none")
          }
          contentClassName="flex flex-col gap-4"
        >
          {notice.purposes.length > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">{t("notice.purposes")}</span>
              {notice.purposes.map((p) => (
                <Badge key={p} variant="outline">
                  {t.has(`notice.purpose.${p}` as "notice.purpose.billing") ? t(`notice.purpose.${p}` as "notice.purpose.billing") : p}
                </Badge>
              ))}
            </div>
          ) : null}

          {notice.texts.length > 0 ? (
            <Disclosure label={t("notice.showText")}>
              <div className="mt-2 flex flex-col gap-6">
                {notice.texts.map((x) => (
                  <div key={x.id} data-testid={`notice-text-${x.locale}`}>
                    <p className="eyebrow text-muted-foreground">{tCommon(`languageName.${x.locale}` as "languageName.en")}</p>
                    <h3 className="mt-1 text-sm font-semibold">{x.title}</h3>
                    <NoticeBody body={x.body} />
                  </div>
                ))}
              </div>
            </Disclosure>
          ) : null}
        </SectionCard>

        <SectionCard
          title={t("notice.acks")}
          description={
            notice.version !== null
              ? t("notice.acksSummary", { acknowledged, total: acks.members.length, version: notice.version })
              : t("notice.none")
          }
          contentClassName="p-0"
        >
          <DataTable flush density="compact" scrollLabel={t("notice.acks")}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("notice.columns.member")}</TableHead>
                  <TableHead className="w-[24ch]">{t("notice.columns.acknowledged")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {acks.members.map((m) => (
                  <TableRow key={m.memberId} data-testid="notice-ack-row" data-acknowledged={m.acknowledgedAt ? "1" : "0"}>
                    <TableCell className="font-medium">{m.name}</TableCell>
                    <TableCell className="num">
                      {m.acknowledgedAt ? (
                        <span className="inline-flex items-center gap-1.5">
                          <CircleCheckIcon aria-hidden="true" className="size-3.5 text-(--tone-success-line)" />
                          {format.dateTime(m.acknowledgedAt, { dateStyle: "medium", timeStyle: "short" })}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                          <CircleDashedIcon aria-hidden="true" className="size-3.5" />
                          {t("notice.notYet")}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </DataTable>
        </SectionCard>

        {canPublish ? (
          <SectionCard title={t("notice.publish.title")} description={t("notice.publish.description")}>
            {/* Two long editors nobody has asked for yet wait behind the one
                disclosure (UI.md §5.14); the page leads with status, not a wall. */}
            <Disclosure label={t("notice.publish.open")}>
              <NoticePublishForm texts={notice.texts} nextVersion={(notice.version ?? 0) + 1} />
            </Disclosure>
          </SectionCard>
        ) : null}

        {workTypes ? (
          <SectionCard title={t("workTypes.title")} description={t("workTypes.description")} contentClassName="p-0">
            <WorkTypesTable rows={rows} canManage={canManageTypes} />
            {canManageTypes ? (
              <div id="new-work-type" className="scroll-mt-16 border-t border-border p-4">
                <h3 className="mb-3 text-sm font-semibold">{t("workTypes.add.title")}</h3>
                <CreateWorkTypeForm />
              </div>
            ) : null}
          </SectionCard>
        ) : null}
      </div>
    </Page>
  );
}
