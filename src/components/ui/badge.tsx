import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * 20px pill, 11px/500 label, 12px icon. The tone variants are the six
 * of the semantic set (§2.5): a tinted chip is <tone>-100 fill with
 * <tone>-800 text in light (>= 7.1:1) and <tone>-950 / <tone>-300 in
 * dark. Prefer <StatusBadge> over reaching for a variant by hand — it
 * is the single source of truth for enum -> tone + icon + shape.
 *
 * One prohibition is product-wide: a FILLED WARM PILL means "Client can
 * see" and nothing else. `caution` is therefore a tint, never a solid.
 */
const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 rounded-full border border-transparent px-2 text-2xs whitespace-nowrap transition-[background-color,border-color,color] duration-(--dur-instant) ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary-hover",
        secondary: "bg-secondary text-secondary-foreground [a]:hover:bg-accent",
        destructive: "bg-destructive text-destructive-foreground [a]:hover:bg-destructive-hover",
        outline: "border-input text-foreground [a]:hover:bg-accent",
        ghost: "text-muted-foreground [a]:hover:bg-accent [a]:hover:text-foreground",
        link: "text-primary underline-offset-4 hover:underline",
        neutral: "bg-(--tone-neutral-bg) text-(--tone-neutral-fg)",
        brand: "bg-(--tone-brand-bg) text-(--tone-brand-fg)",
        caution: "bg-(--tone-caution-bg) text-(--tone-caution-fg)",
        success: "bg-(--tone-success-bg) text-(--tone-success-fg)",
        danger: "bg-(--tone-danger-bg) text-(--tone-danger-fg)",
        quiet: "border-transparent bg-transparent text-(--tone-quiet-fg)",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
