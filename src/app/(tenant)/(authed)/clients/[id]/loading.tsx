import { getTranslations } from "next-intl/server";

import { SectionCard } from "@/components/semantic";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Pending UI for the client TABS only.
 *
 * Without this file the route-level `(authed)/loading.tsx` owns the
 * boundary, and it replaces the whole page — greying out the h1, the
 * entity tile, the status badge and the tab strip that this segment's
 * layout has already rendered and will keep. The boundary belongs
 * BELOW the header, so the identity of the thing you are looking at
 * survives a tab change.
 *
 * The shape is the shape of the page that is coming (§10.9): the tabs
 * here are label-over-value pairs on a two-column grid, not a
 * four-column table, so the skeleton is label bars over field bars at
 * the same rhythm the settled card uses.
 */
const FIELDS = [
  "w-28",
  "w-40",
  "w-24",
  "w-32",
  "w-36",
  "w-44",
  "w-20",
  "w-28",
] as const;

export default async function ClientTabLoading() {
  const t = await getTranslations("common");
  return (
    <div
      role="status"
      aria-label={t("loading")}
      aria-busy="true"
      className="flex flex-col gap-6"
    >
      <SectionCard>
        <Skeleton className="h-4 w-28" />
        <div className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          {FIELDS.map((w, i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <Skeleton className="h-2.5 w-16" />
              <Skeleton className={`h-4 ${w}`} />
            </div>
          ))}
        </div>
      </SectionCard>
      <SectionCard>
        <Skeleton className="h-4 w-24" />
        <div className="mt-4 flex flex-col gap-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-4/5" />
        </div>
      </SectionCard>
    </div>
  );
}
