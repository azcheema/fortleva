import { cn } from "@/lib/utils";

/**
 * The §5.11 resting control box, shared by `InlineEdit`'s rest button
 * and `PropertyPicker`'s trigger — the two controls whose rest state IS
 * the value as text (Founder Mandate 1).
 *
 * It lives in `lib` rather than being exported from `inline-edit.tsx`
 * because that module is `"use client"`, and a client module's exported
 * constant interpolated into a SERVER component's `className` becomes a
 * throwing client reference — the standing trap, and the same reason
 * `src/lib/work-view/params.ts` carries no directive. Keeping the
 * geometry here means slice 6's four pickers cannot each invent their
 * own.
 *
 * The output is byte-identical to the string `inline-edit.tsx` carried
 * before it moved: do not tidy a class, a value or an order here, or
 * every InlineEdit stop in the visual sweep shifts.
 */
export const restBoxClass = (o: {
  density?: "default" | "table";
  fit?: boolean;
  align?: "start" | "end";
}): string =>
  cn(
    "flex min-w-0 items-center gap-1.5 rounded-md border bg-clip-padding px-2.5 text-sm",
    o.fit ? "w-fit max-w-full" : "w-full",
    o.density === "table" ? "h-7" : "h-8",
    o.align === "end" && "justify-end text-right",
  );
