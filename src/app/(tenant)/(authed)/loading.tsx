import { Skeleton } from "@/components/ui/skeleton";

/** Route-level pending UI for the member plane: header + three rows. */
export default function AuthedLoading() {
  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 md:px-8" aria-busy="true">
      <Skeleton className="h-7 w-56" />
      <Skeleton className="mt-2 h-4 w-80" />
      <div className="mt-6 flex flex-col gap-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    </div>
  );
}
