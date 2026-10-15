import { FileUpIcon } from "lucide-react";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";

import { AuthzError } from "@/authz/errors";
import { handleAuthzRedirect } from "@/authz/redirects";
import { EmptyState, SectionCard } from "@/components/semantic";
import { requireTenantContext } from "@/members/tenant-context";
import { resolveStates } from "@/modules/work";
import { listImports, readImportForm } from "@/modules/work/import/service";

import { loadProject } from "../data";
import { ImportFlow } from "./import-flow";
import { ImportHistory, type ImportHistoryRow } from "./import-history";

/**
 * /projects/[key]/import — bring tasks in from a spreadsheet or a Trello
 * board (Phase 6 slice 121; founder decision C97). Not a tab: reached from
 * the backlog (its footer link and its empty state), with the Backlog tab
 * lit (`also` in the layout). The page gate is the service's —
 * `work_item:create` + `work_item:edit` + scope — and a member without it
 * sees a `forbidden` state, never the flow.
 */
export default async function ProjectImportPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const project = await loadProject(key);
  const { membership, actor } = await requireTenantContext();
  const ctx = { tenantId: membership.tenantId, actor };
  const t = await getTranslations("projects.import");
  const back = `/projects/${project.key}/backlog`;

  let form: Awaited<ReturnType<typeof readImportForm>>;
  try {
    form = await readImportForm(ctx, project.id);
  } catch (e) {
    handleAuthzRedirect(e, `/projects/${project.key}/import`);
    if (!(e instanceof AuthzError)) throw e;
    return (
      <SectionCard>
        <EmptyState variant="forbidden" icon={FileUpIcon} title={t("forbidden.title")} body={t("forbidden.body")} />
      </SectionCard>
    );
  }
  // In sequence, after the form: its own transaction.
  const imports = await listImports(ctx, project.id);
  const tStates = await getTranslations("projects.states.seed");
  const format = await getFormatter();
  const states = resolveStates(
    form.states.map((s) => ({ ...s, isHidden: false, wipLimit: null })),
    (seedKey) => tStates(seedKey),
  ).map((s) => ({
    id: s.id,
    name: s.name,
    category: s.category as (typeof form.states)[number]["category"],
    isDefault: s.isDefault,
    requiresApproval: s.requiresApproval,
  }));
  const history: ImportHistoryRow[] = imports.map((j) => ({
    id: j.id,
    source: j.source,
    fileName: j.fileName,
    startedAt: format.dateTime(j.startedAt, { dateStyle: "medium", timeStyle: "short" }),
    startedBy: j.startedBy,
    status: j.status,
    created: j.created,
    updated: j.updated,
    undone: j.undone,
    restored: j.restored,
    canUndo: j.canUndo,
    canRestore: j.canRestore,
  }));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">{t("title")}</h2>
        <Link className="text-sm text-muted-foreground underline-offset-2 hover:underline" href={back}>
          {t("back")}
        </Link>
      </div>
      {form.project.archived ? (
        <SectionCard>
          <EmptyState variant="forbidden" icon={FileUpIcon} title={t("title")} body={t("archived")} />
        </SectionCard>
      ) : (
        <ImportFlow
          projectId={project.id}
          projectKey={project.key}
          states={states}
          members={form.members}
          labels={form.labels}
          caps={{ approve: form.caps.approve, manageLabels: form.caps.manageLabels }}
          timezone={form.timezone}
        />
      )}
      {history.length > 0 ? <ImportHistory projectKey={project.key} rows={history} /> : null}
    </div>
  );
}
