"use client";

import { LockOpenIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";

import { useVaultDeadline } from "./use-vault-deadline";

/**
 * "Open. Locks itself at 14:32" (C52 (a)), and the lock itself: when the
 * window ends the page refreshes, and the server — which is what decides —
 * draws the door. Nothing of the open vault stays on a screen nobody is
 * using.
 *
 * The deadline is measured on the SERVER's clock (`msLeft`, computed where
 * `locksAt` was), laid on this browser's at first receipt: a browser clock
 * that runs ahead would otherwise refresh early, be told the vault is
 * still open, and refresh again in a loop. When it is checked — on mount
 * (a replayed page), at the deadline, every 15 s, and whenever the member
 * comes back — is `useVaultDeadline`'s, the one rule this and ⌘K's login
 * rows share (slice 97). It refreshes once. The time shown is formatted by
 * next-intl in the member's zone (never the process's — AGENTS.md's
 * hydration trap).
 */
export function VaultLockTimer({ locksAt, msLeft }: { locksAt: string; msLeft: number }) {
  const t = useTranslations("vault.lock");
  const format = useFormatter();
  const router = useRouter();

  useVaultDeadline({ key: locksAt, msLeft }, () => router.refresh());

  return (
    <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="vault-lock">
      <LockOpenIcon aria-hidden="true" className="size-3.5" />
      {t("openUntil", { time: format.dateTime(new Date(locksAt), { hour: "numeric", minute: "2-digit" }) })}
    </p>
  );
}
