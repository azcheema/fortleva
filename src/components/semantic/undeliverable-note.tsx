import { MailWarningIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * "Emails to this address aren't being delivered" (Phase 5 slice 103, founder
 * decision C71 (d)) — the line under a person whose address Fortleva has
 * stopped mailing: it bounced for good, or its owner reported our mail as
 * spam. The same sentence for both: the reason may come from another
 * workspace's mail, and is not this one's to know. Caution, not danger —
 * nothing is broken that the reader cannot fix by correcting the address.
 *
 * `slot` names the place it is drawn (`data-slot`, for tests).
 */
export function UndeliverableNote({ text, slot, className }: { text: string; slot: string; className?: string }) {
  return (
    <span data-slot={slot} className={cn("flex min-w-0 items-start gap-1 text-xs text-(--tone-caution-fg)", className)}>
      <MailWarningIcon aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
      <span>{text}</span>
    </span>
  );
}
