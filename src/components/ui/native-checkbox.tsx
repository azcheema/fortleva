import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A styled native <input type="checkbox">, the twin of <NativeSelect>
 * and for the same reason: it fires a real `change` event, which is
 * what <AutoForm> listens for. The Radix <Checkbox> renders a button
 * plus a bubble input and does NOT emit a bubbling change event, so an
 * auto-saving form built on it would silently stop saving.
 *
 * Geometry matches <Checkbox> exactly — 16x16, 4px radius, 1px --input
 * boundary (3:1), --primary fill when checked — so the two are
 * indistinguishable on screen and a form may mix them freely.
 *
 * `accent-color` paints the native check, which keeps the control
 * fully native (indeterminate state, form reset, autofill) instead of
 * re-implementing the tick.
 */
function NativeCheckbox({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type="checkbox"
      data-slot="native-checkbox"
      className={cn(
        "size-4 shrink-0 rounded-sm border border-input accent-primary transition-[border-color] duration-(--dur-instant) ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:border-border disabled:accent-bg-disabled",
        className,
      )}
      {...props}
    />
  );
}

export { NativeCheckbox };
