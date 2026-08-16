import { cn } from "@/lib/utils"

/**
 * Height is driven by the same --row-h token <DataTable> hands to
 * <TableRow>, so the loading shape cannot drift from the loaded shape.
 * A single 1.6s shimmer pass, off entirely under reduced motion (the
 * base layer clamps the duration; `motion-reduce` removes the pass so
 * the surface simply sits still rather than flickering once).
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "relative overflow-hidden rounded-sm bg-muted",
        "after:absolute after:inset-0 after:-translate-x-full after:animate-[shimmer_1.6s_ease-out_1] after:bg-linear-to-r after:from-transparent after:via-accent after:to-transparent motion-reduce:after:hidden",
        className
      )}
      {...props}
    />
  )
}

export { Skeleton }
