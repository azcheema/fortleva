"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";

import type { FormResult } from "@/lib/server-actions";

/**
 * Run a project server action and TOAST its typed result.
 *
 * The standing trap it exists for (AGENTS.md): an action failure must
 * never look like a revert. Every control that uses this stays bound to
 * the SERVER value — nothing here is optimistic — so a refused write
 * leaves the switch where the database left it and says why, instead of
 * flicking back and looking like a bug.
 *
 * Shared by the Overview forms and the Portal tab since 2026-09-21; it
 * was module-private to `overview-forms.tsx` until the portal controls
 * moved to their own route.
 */
export const useRun = () => {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<FormResult>, onOk?: (r: FormResult) => void) =>
    start(async () => {
      const r = await fn();
      if (r.ok) {
        toast.success(r.message);
        onOk?.(r);
      } else toast.error(r.message);
      router.refresh();
    });
  return { pending, run };
};
