import { getTranslations } from "next-intl/server";

import { DataTable, Page } from "@/components/semantic";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level pending UI. The skeleton is the SHAPE of the page that is
 * coming, not a generic spinner: a title block, then a table whose row
 * height comes from the same --row-h token <DataTable> hands the real
 * <TableRow>, so the placeholder and the settled table share a rhythm.
 */
const ROWS = [
  ["w-44", "w-16", "w-10", "w-24"],
  ["w-56", "w-20", "w-10", "w-16"],
  ["w-36", "w-16", "w-8", "w-28"],
  ["w-48", "w-20", "w-10", "w-20"],
  ["w-40", "w-16", "w-8", "w-24"],
  ["w-52", "w-20", "w-10", "w-16"],
] as const;

export default async function AuthedLoading() {
  const t = await getTranslations("common");
  return (
    <Page>
      <div role="status" aria-label={t("loading")} aria-busy="true">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="mt-2 h-4 w-80" />
        <DataTable className="mt-6">
          <div className="hairline-b flex h-8 items-center gap-6 px-2">
            <Skeleton className="h-2.5 w-20" />
            <Skeleton className="h-2.5 w-14" />
            <Skeleton className="h-2.5 w-10" />
            <Skeleton className="h-2.5 w-16" />
          </div>
          <div className="divide-y divide-border">
            {ROWS.map((widths, i) => (
              <div key={i} className="row-h flex items-center gap-6 px-2">
                {widths.map((w, j) => (
                  <Skeleton key={j} className={`h-3 ${w}`} />
                ))}
              </div>
            ))}
          </div>
        </DataTable>
      </div>
    </Page>
  );
}
