import { Trash2Icon } from "lucide-react";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";

import { AuthzError } from "@/authz/errors";
import { handleAuthzRedirect } from "@/authz/redirects";
import { EmptyState, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { requireTenantContext } from "@/members/tenant-context";
import { BIN_PAGE_SIZE, listDeletedItems, type BinPage } from "@/modules/work";

import { loadProject } from "../data";
import { BinTable, type BinRow } from "./bin-table";

/**
 * /projects/[key]/deleted — the project's bin (slice 126, founder decision
 * C102 (a)): its tasks deleted in the last 30 days, each with Bring back.
 * Not a tab: reached from the backlog's foot ("Deleted tasks", beside
 * "Import tasks"), with the Backlog tab lit (`also` in the layout). The
 * page gate is the service's — `work_item:delete` with the project in
 * scope — and a member without it sees a `forbidden` state.
 */
export default async function ProjectBinPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const project = await loadProject(key);
  const { membership, actor } = await requireTenantContext();
  const ctx = { tenantId: membership.tenantId, actor };
  const t = await getTranslations("projects.bin");
  const back = `/projects/${project.key}/backlog`;

  let bin: BinPage;
  try {
    bin = await listDeletedItems(ctx, project.id);
  } catch (e) {
    handleAuthzRedirect(e, `/projects/${project.key}/deleted`);
    if (!(e instanceof AuthzError)) throw e;
    return (
      <SectionCard>
        <EmptyState variant="forbidden" icon={Trash2Icon} title={t("forbidden.title")} body={t("forbidden.body")} />
      </SectionCard>
    );
  }
  const format = await getFormatter();
  const rows: BinRow[] = bin.entries.map((e) => ({
    id: e.id,
    number: e.number,
    title: e.title,
    deletedAt: format.dateTime(e.deletedAt, { dateStyle: "medium", timeStyle: "short" }),
    deletedBy: e.deletedBy,
    blocked: e.blocked,
  }));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">{t("title")}</h2>
        <Link className="text-sm text-muted-foreground underline-offset-2 hover:underline" href={back}>
          {t("back")}
        </Link>
      </div>
      {rows.length === 0 ? (
        <SectionCard>
          <EmptyState
            variant="empty"
            icon={Trash2Icon}
            title={t("empty.title")}
            body={t("empty.body")}
            action={
              <Button asChild size="sm" variant="outline">
                <Link href={back}>{t("back")}</Link>
              </Button>
            }
          />
        </SectionCard>
      ) : (
        <BinTable projectKey={project.key} rows={rows} more={bin.more ? BIN_PAGE_SIZE : null} />
      )}
    </div>
  );
}
