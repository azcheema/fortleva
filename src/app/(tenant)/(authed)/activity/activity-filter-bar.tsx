"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useOptimistic, useTransition } from "react";

import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { activityHref, type ActivityParams } from "@/lib/activity-plan";

/**
 * The Activity page's filters (slice 133; C110 (c) — design §3.2): a project
 * and a client, native selects as the Tasks page's, each drawn when there are
 * two or more to choose from — one of the two at a time. The parameters are
 * the server's APPLIED ones, and a change goes back to today's window (a
 * filtered week is a new view).
 * The shown value moves at once (`useOptimistic` inside the transition).
 */
export function ActivityFilterBar({
  applied,
  projects,
  clients,
}: {
  applied: ActivityParams;
  projects: readonly { readonly key: string; readonly name: string }[];
  clients: readonly { readonly id: string; readonly name: string }[];
}) {
  const t = useTranslations("activity");
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [shown, setShown] = useOptimistic(applied);

  const go = (patch: Partial<ActivityParams>) => {
    const next: ActivityParams = { ...shown, ...patch, until: null, skip: 0 };
    startTransition(() => {
      setShown(next);
      router.push(activityHref(next), { scroll: false });
    });
  };

  if (projects.length < 2 && clients.length < 2) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-3" role="group" aria-label={t("filters")} data-testid="activity-filters">
      {projects.length > 1 ? (
        <div className="flex min-w-0 items-center gap-2">
          <Label htmlFor="activity-project" className="text-sm text-muted-foreground">
            {t("projectFilter")}
          </Label>
          <NativeSelect
            id="activity-project"
            className="w-auto max-w-full"
            value={shown.project ?? ""}
            // One of the two at a time: a project of another client than the
            // one chosen would only ever show an empty page.
            onChange={(e) => go({ project: e.target.value === "" ? null : e.target.value, client: null })}
            data-testid="activity-project-filter"
          >
            <option value="">{t("allProjects")}</option>
            {projects.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
          </NativeSelect>
        </div>
      ) : null}
      {clients.length > 1 ? (
        <div className="flex min-w-0 items-center gap-2">
          <Label htmlFor="activity-client" className="text-sm text-muted-foreground">
            {t("clientFilter")}
          </Label>
          <NativeSelect
            id="activity-client"
            className="w-auto max-w-full"
            value={shown.client ?? ""}
            onChange={(e) => go({ client: e.target.value === "" ? null : e.target.value, project: null })}
            data-testid="activity-client-filter"
          >
            <option value="">{t("allClients")}</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </NativeSelect>
        </div>
      ) : null}
    </div>
  );
}
