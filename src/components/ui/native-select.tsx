import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A styled native <select>: keyboard-native, works inside auto-saving
 * forms (fires a real change event) and needs no client JS. The Radix
 * Select stays for rich pickers; this is for plain enum fields.
 *
 * Trigger geometry is identical to <Input> so a form of mixed fields
 * lines up on the 4px grid.
 */
function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        "h-8 w-full min-w-0 rounded-md border border-input bg-card px-2 py-1 text-sm text-foreground transition-[border-color,background-color] duration-(--dur-instant) ease-out hover:border-input-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:border-border disabled:bg-bg-disabled disabled:text-fg-disabled aria-invalid:border-destructive",
        className,
      )}
      {...props}
    />
  );
}

export { NativeSelect };
