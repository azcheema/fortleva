"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback } from "react";
import { toast } from "sonner";

import type { VaultRefusalCode } from "./vault-call";

/**
 * One way to say a vault refusal: a toast in the member's words, and —
 * where the page itself is now wrong — a refresh. A stale factor means the
 * vault has locked itself, so the refresh draws the door; a credential
 * that is gone leaves the list; a session that ended goes to sign-in.
 */
export function useVaultFailure(
  /** Whose words: the staff vault's, or the client's logins page (slice 91), where "vault" is not a word they know. */
  namespace: "vault.errors" | "portal.logins.errors" = "vault.errors",
): (code: VaultRefusalCode) => void {
  const t = useTranslations(namespace);
  const router = useRouter();
  return useCallback(
    (code: VaultRefusalCode) => {
      toast.error(t(code));
      if (code === "MFA_REQUIRED" || code === "NOT_FOUND" || code === "SIGNED_OUT") router.refresh();
    },
    [t, router],
  );
}
