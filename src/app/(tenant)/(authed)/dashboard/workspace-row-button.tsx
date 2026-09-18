"use client";

import { ChevronRightIcon, LoaderCircleIcon } from "lucide-react";
import { useFormStatus } from "react-dom";

import { cn } from "@/lib/utils";

/**
 * The picker row's submit, as a client component for ONE reason:
 * `useFormStatus`, which only reads the form it is rendered inside.
 *
 * Without it the row has no pending state at all, and the wait is not
 * short — the action writes, then `revalidatePath("/", "layout")` sweeps
 * every cached segment, then it redirects. PLAN §0's standing trap
 * measures that class of window at over two seconds on this codebase, and
 * a row that does nothing for two seconds reads as broken and gets
 * clicked again. Two clicks on the SAME row are harmless (the action
 * early-returns), but on two DIFFERENT rows the workspace you land in is
 * whichever write lands last — so the pending state is correctness, not
 * only polish.
 *
 * `aria-disabled`, never `disabled`: disabling the focused button drops
 * focus to `<body>` (PLAN §0), where no suppression guard applies. The
 * click is refused in the handler instead.
 */
export function WorkspaceRowButton({
  label,
  current,
  children,
}: {
  label: string;
  current: boolean;
  children: React.ReactNode;
}) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      aria-label={label}
      aria-current={current ? "page" : undefined}
      aria-disabled={pending || undefined}
      aria-busy={pending || undefined}
      onClick={(e) => {
        if (pending) e.preventDefault();
      }}
      className={cn(
        "row-h relative flex w-full items-center gap-3 px-4 text-left text-sm transition-colors duration-(--dur-instant) ease-out hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
        // Two channels, the same pair the rail uses: an --accent fill
        // AND a 2px --primary bar.
        current &&
          "bg-accent font-medium before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full before:bg-primary",
        pending && "opacity-70",
      )}
    >
      {children}
      {pending ? (
        <LoaderCircleIcon
          aria-hidden="true"
          className="size-4 shrink-0 animate-spin text-muted-foreground"
        />
      ) : (
        <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      )}
    </button>
  );
}
