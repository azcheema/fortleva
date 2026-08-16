import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A styled native <select>: keyboard-native, works inside auto-saving
 * forms (fires a real change event) and needs no client JS. The Radix
 * Select stays for rich pickers; this is for plain enum fields.
 */
function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2 py-1 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30",
        className,
      )}
      {...props}
    />
  );
}

export { NativeSelect };
