import type { Tone } from "@/lib/tones";
import { TONE_CHIP, TONE_LINE } from "@/lib/tones";
import { cn } from "@/lib/utils";

/**
 * A vertical rail of dated events: milestone nodes and shipped
 * versions, in one column, connected by a 1px hairline.
 *
 * The rail is the same surface language as everything else — a
 * hairline in --border and a 24px node on --card — so the timeline
 * reads as part of the page rather than as a widget. The node carries
 * the state ICON (never a bare dot), which is what survives greyscale;
 * the tone is a second channel, never the only one.
 *
 * Geometry: node 24px, rail centred on it at left-3, 16px between
 * entries. The last entry draws no rail, so the column ends on the
 * node rather than trailing into whitespace.
 */
export function Timeline({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <ol data-slot="timeline" className={cn("flex flex-col", className)}>
      {children}
    </ol>
  );
}

export function TimelineItem({
  node,
  tone = "neutral",
  filled = false,
  last = false,
  contentClassName,
  className,
  children,
}: {
  /** The 12px glyph inside the node — a StatusIcon, or a step number. */
  node: React.ReactNode;
  tone?: Tone;
  /** Terminal states (done, shipped) fill their node; open ones outline it. */
  filled?: boolean;
  last?: boolean;
  /** Where visibilityRowCue() goes: the warm 2px edge belongs to the content. */
  contentClassName?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <li data-slot="timeline-item" className={cn("relative flex gap-3 pb-4 last:pb-0", className)}>
      {last ? null : (
        <span
          aria-hidden="true"
          className="absolute top-7 bottom-0 left-3 w-px -translate-x-1/2 bg-border"
        />
      )}
      <span
        aria-hidden="true"
        className={cn(
          "relative z-1 flex size-6 shrink-0 items-center justify-center rounded-full border",
          filled ? cn("border-transparent", TONE_CHIP[tone]) : cn("border-border bg-card", TONE_LINE[tone]),
        )}
      >
        {node}
      </span>
      <div className={cn("min-w-0 flex-1 pl-3", contentClassName)}>{children}</div>
    </li>
  );
}
