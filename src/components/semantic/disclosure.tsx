import { ChevronRightIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The one progressive-disclosure trigger in the product.
 *
 * Three screens grew their own `<details>` during the refinement pass —
 * client Overview's "Add details", project Overview's blank-field
 * disclosure and the role card's "Permissions" — at three sizes, with
 * three hover treatments. A disclosure is a control, so it wears the
 * control box: a 28px ghost trigger with a transparent border that
 * becomes `--input` on hover, control padding, and the standard
 * `outline` focus ring (§9 — never a ring shadow).
 *
 * `<details>`/`<summary>` rather than a button plus state: it is
 * keyboard-operable, announced as an expandable group and, crucially,
 * findable by the browser's find-in-page — which a React-state
 * disclosure is not. It also renders identically on the server, so a
 * card that opens it by default costs no JavaScript.
 */
export function Disclosure({
  label,
  open,
  contentClassName,
  className,
  children,
}: {
  /** From t(). The trigger's visible text and its accessible name. */
  label: string;
  open?: boolean;
  contentClassName?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <details data-slot="disclosure" open={open} className={cn("group/disclosure", className)}>
      <summary
        data-slot="disclosure-trigger"
        className="inline-flex h-7 w-fit cursor-pointer list-none items-center gap-1.5 rounded-md border border-transparent px-2.5 text-sm text-muted-foreground transition-[color,background-color,border-color] duration-(--dur-instant) ease-out select-none hover:border-input hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden"
      >
        <ChevronRightIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 transition-transform duration-(--dur-instant) ease-out group-open/disclosure:rotate-90"
        />
        {label}
      </summary>
      <div className={cn("mt-3", contentClassName)}>{children}</div>
    </details>
  );
}
