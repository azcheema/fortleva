import type { TimerPillState } from "@/app/(tenant)/(authed)/time/actions";

import { TimerPill } from "./timer-pill";

/**
 * Timer pill slot (UI.md §3.2, rule 9): a stable mount point in the
 * header, desktop right of the breadcrumb and above the tabs on mobile.
 * Filled by the `time` module: `timer` is the server snapshot the layout
 * took (null = no time:track or module off ⇒ the slot renders nothing);
 * the pill re-syncs itself from there on.
 */
export function TimerPillSlot({ className, timer }: { className?: string; timer: TimerPillState | null }) {
  if (!timer) return <div data-slot="timer-pill" className={className} aria-hidden="true" />;
  return (
    <div data-slot="timer-pill" className={className}>
      <TimerPill initial={timer} />
    </div>
  );
}
