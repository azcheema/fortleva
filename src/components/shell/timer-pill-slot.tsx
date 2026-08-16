/**
 * Timer pill slot (UI.md §3.2, rule 9): a stable mount point in the
 * header, desktop right of the breadcrumb and above the tabs on mobile.
 * Renders nothing until the `time` module (Phase 2T) fills it — the
 * shell never needs to change for that, only this file's body.
 */
export function TimerPillSlot({ className }: { className?: string }) {
  return <div data-slot="timer-pill" className={className} aria-hidden="true" />;
}
