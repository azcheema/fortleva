"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { toast } from "sonner";

import { InlineConfirm } from "@/components/semantic";

import { signOutDeviceAction, signOutOtherDevicesAction } from "./devices-actions";

/**
 * The two verbs of "Your devices" (slice 84). Both ask first, in place
 * (`InlineConfirm`) — a session signed out is a person made to sign in
 * again — and `tone: "danger"` gives the "Yes" its destructive weight. A
 * refusal is toasted, never a silent revert.
 */
export function SignOutDevice({ sessionId, label }: { sessionId: string; label: string }) {
  const t = useTranslations("account.devices");
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <InlineConfirm
      label={t("signOut")}
      question={t("signOutQuestion", { device: label })}
      pending={pending}
      variant="ghost"
      tone="danger"
      onConfirm={() =>
        start(async () => {
          const r = await signOutDeviceAction(sessionId).catch(() => ({ ok: false as const, message: t("failed") }));
          if (r.ok) toast.success(t("signedOut", { device: label }));
          else toast.error(r.message);
          router.refresh();
        })
      }
    />
  );
}

export function SignOutOthers() {
  const t = useTranslations("account.devices");
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <InlineConfirm
      label={t("signOutOthers")}
      question={t("signOutOthersQuestion")}
      pending={pending}
      variant="outline"
      tone="danger"
      onConfirm={() =>
        start(async () => {
          const r = await signOutOtherDevicesAction().catch(() => ({ ok: false as const, message: t("failed") }));
          if (r.ok) toast.success(t("signedOutOthers", { count: r.value }));
          else toast.error(r.message);
          router.refresh();
        })
      }
    />
  );
}
