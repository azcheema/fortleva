import type { Metadata } from "next";
import { MegaphoneIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";

import { AuthzError } from "@/authz/errors";
import { EmptyState, HealthChip, SectionCard } from "@/components/semantic";
import { UpdateView } from "@/components/updates/update-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/format";
import { requireTenantContext } from "@/members/tenant-context";
import { getUpdate, listUpdates, type UpdateDetail, type UpdateList } from "@/modules/work";

import { loadProject } from "../data";

/**
 * PROJECT → UPDATES (Phase 3, DATA_MODEL §6.16): the newest published
 * post pinned, then every post — drafts first, newest published after —
 * and the door to the composer. Every row links to its own page; a
 * draft's page IS the composer, a published post's page is the post
 * with its staff-only figures and its verbs.
 */
export async function generateMetadata({ params }: { params: Promise<{ key: string }> }): Promise<Metadata> {
  const { key } = await params;
  const [project, t] = await Promise.all([loadProject(key), getTranslations("projects.updates")]);
  return { title: `${project.key} · ${t("title")}` };
}

const STATUS_VARIANT = { DRAFT: "outline", PUBLISHED: "success", ARCHIVED: "neutral" } as const;

export default async function ProjectUpdatesPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const project = await loadProject(key);
  const { membership, actor } = await requireTenantContext();
  const ctx = { tenantId: membership.tenantId, actor };
  const t = await getTranslations("projects.updates");
  const tCommon = await getTranslations("common");
  const locale = await getLocale();

  let list: UpdateList | null = null;
  let latest: UpdateDetail | null = null;
  try {
    list = await listUpdates(ctx, project.id);
    if (list.latest) latest = await getUpdate(ctx, list.latest.id);
  } catch (e) {
    if (!(e instanceof AuthzError)) throw e;
  }

  if (!list) {
    return (
      <SectionCard>
        <EmptyState variant="forbidden" title={tCommon("forbiddenTitle")} body={t("noPermission")} />
      </SectionCard>
    );
  }

  const canWrite = list.caps.create && project.status !== "ARCHIVED";
  const base = `/projects/${project.key}/updates`;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-foreground">{t("title")}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{t("description")}</p>
        </div>
        {canWrite ? (
          <Button asChild size="sm">
            <Link href={`${base}/new`} data-testid="new-update">
              <PlusIcon />
              {t("new")}
            </Link>
          </Button>
        ) : null}
      </div>

      {list.updates.length === 0 ? (
        <SectionCard>
          <EmptyState
            variant={canWrite ? "empty" : "forbidden"}
            icon={MegaphoneIcon}
            title={t("empty.title")}
            body={t("empty.body")}
            action={
              canWrite ? (
                <Button asChild size="sm">
                  <Link href={`${base}/new`}>
                    <PlusIcon />
                    {t("new")}
                  </Link>
                </Button>
              ) : undefined
            }
          />
        </SectionCard>
      ) : (
        <>
          {latest ? (
            <SectionCard
              title={t("latest")}
              actions={
                <Button asChild variant="outline" size="xs">
                  <Link href={`${base}/${latest.id}`}>{tCommon("preview")}</Link>
                </Button>
              }
            >
              <UpdateView
                update={{
                  seq: latest.seq,
                  health: latest.health,
                  title: latest.title,
                  periodStart: latest.periodStart ? new Date(`${latest.periodStart}T00:00:00Z`) : null,
                  periodEnd: latest.periodEnd ? new Date(`${latest.periodEnd}T00:00:00Z`) : null,
                  publishedAt: latest.publishedAt,
                  body: latest.body,
                  metrics: latest.metrics,
                  editNote: latest.editNote,
                }}
              />
            </SectionCard>
          ) : null}

          <SectionCard title={t("list")} contentClassName="p-0">
            <ul className="divide-y divide-border" data-testid="updates-list">
              {list.updates.map((u) => {
                const name = u.title ?? (u.seq !== null ? t("seq", { seq: u.seq }) : t("untitled"));
                return (
                  <li key={u.id}>
                    <Link
                      href={`${base}/${u.id}`}
                      aria-label={t("open", { name })}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                    >
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="flex min-w-0 items-center gap-2">
                          {u.seq !== null ? (
                            <span className="num text-xs text-muted-foreground">{t("seq", { seq: u.seq })}</span>
                          ) : null}
                          <span className="truncate text-sm font-medium text-foreground">{u.title ?? t("untitled")}</span>
                        </span>
                        {u.excerpt ? <span className="truncate text-xs text-muted-foreground">{u.excerpt}</span> : null}
                      </span>
                      <HealthChip value={u.health} />
                      <Badge variant={STATUS_VARIANT[u.status]}>{t(`status.${u.status}`)}</Badge>
                      <span className="text-xs text-muted-foreground">
                        {formatDate(locale, u.publishedAt ?? u.updatedAt)}
                        {u.authorName ? ` · ${u.authorName}` : ""}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </SectionCard>
        </>
      )}
    </div>
  );
}
