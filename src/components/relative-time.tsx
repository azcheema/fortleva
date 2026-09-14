"use client";

import { useFormatter } from "next-intl";

import { useServerNow } from "@/components/shell/use-server-now";

/**
 * "2 h ago" — for activity and the inbox only; everywhere else time is
 * absolute (UI.md §8). Measured from the SERVER's instant, never the
 * browser's, so the first render agrees on both sides (`useServerNow`)
 * and a laptop clock running fast cannot put a change "in 3 minutes".
 * The label does not tick: it is as fresh as the render that produced
 * it, which is the inbox's convention too, and a fresh server instant
 * re-seeds it. The exact stamp rides along in `dateTime` and `title`
 * for anyone who needs it.
 *
 * A client component so the inbox — a client list with optimistic
 * patches — can render it too; it holds no state of its own beyond the
 * clock hook, and with `live` off that hook does no work.
 */
export function RelativeTime({ at, now, className }: { at: string; now: string; className?: string }) {
  const format = useFormatter();
  const reference = useServerNow(now, false);
  const date = new Date(at);
  // Two clocks: the row was stamped by the process that WROTE it, the
  // reference by the one that renders. A stamp a few seconds ahead of
  // the reference reads as "now", never as "in 4 seconds" — a change
  // cannot be in the future of the page that shows it.
  const shown = date.getTime() > reference ? new Date(reference) : date;
  return (
    <time
      dateTime={at}
      title={format.dateTime(date, { dateStyle: "medium", timeStyle: "short" })}
      className={className}
    >
      {format.relativeTime(shown, reference)}
    </time>
  );
}
