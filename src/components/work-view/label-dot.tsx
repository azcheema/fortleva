import { labelColorStyle } from "@/lib/label-colors";

/**
 * A label's colour as a small DOT inside its neutral outline chip (slice
 * 123, C99 (b)) — never a filled chip: a chip is identity, never status,
 * and the one filled warm pill in a row means "Client can see"
 * (`label-chips.tsx`). Nothing for "no colour". Decorative: the name beside
 * it carries the meaning, so it is hidden from a screen reader.
 */
export function LabelDot({ color }: { color: string | null | undefined }) {
  const style = labelColorStyle(color);
  if (!style) return null;
  return (
    <span
      aria-hidden="true"
      data-slot="label-dot"
      data-color={color}
      className="inline-block size-2 shrink-0 rounded-full bg-(--entity)"
      style={style}
    />
  );
}
