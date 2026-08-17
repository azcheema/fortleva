import { SectionCard } from "@/components/semantic";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * A loading boundary INSIDE the project shell, so the h1, the entity
 * mark, the status badge and the tab strip the layout has already
 * rendered stay on screen while a tab loads. Without it the route-level
 * (authed)/loading.tsx greys out the whole page, including chrome that
 * is not being fetched at all.
 *
 * The shape matches the Overview tab it most often replaces: label bar
 * + value bar pairs, not a generic four-column table (§10.9).
 */
export default function ProjectLoading() {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="flex flex-col gap-6 lg:col-span-2">
        <SectionCard>
          <div className="flex flex-col gap-3">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="grid grid-cols-1 gap-1 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-3">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-full max-w-64" />
              </div>
            ))}
          </div>
        </SectionCard>
      </div>
      <div className="flex flex-col gap-6">
        <SectionCard>
          <div className="flex flex-col gap-3">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-8 w-full" />
          </div>
        </SectionCard>
      </div>
    </div>
  );
}
