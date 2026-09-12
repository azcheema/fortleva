"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { Sheet, SheetContent } from "@/components/ui/sheet";

/**
 * The item side-peek's shell (UI.md §5.4, started minimal in 2W-B): a
 * right sheet the server renders INTO — the content stays a server
 * component; this wrapper only owns open/close. Closing navigates back
 * to the surface's own URL (the peek IS the `?item=` param, so every
 * peek is a link and Back closes it too).
 */
export function PeekShell({
  returnHref,
  children,
}: {
  returnHref: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) startTransition(() => router.push(returnHref, { scroll: false }));
      }}
    >
      <SheetContent
        side="right"
        data-testid="item-peek"
        className="overflow-y-auto data-[side=right]:w-full sm:data-[side=right]:max-w-xl"
      >
        {children}
      </SheetContent>
    </Sheet>
  );
}
