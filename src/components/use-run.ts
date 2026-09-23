"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";

import type { FormResult } from "@/lib/server-actions";

/**
 * Run a server action and TOAST its typed result.
 *
 * The standing trap it exists for (AGENTS.md): an action failure must
 * never look like a revert. Every control that uses this stays bound to
 * the SERVER value — nothing here is optimistic — so a refused write
 * leaves the switch where the database left it and says why, instead of
 * flicking back and looking like a bug.
 *
 * **IT HAS MOVED TWICE FOR THE SAME REASON, so it lives here now.** It
 * was module-private to `projects/[key]/overview-forms.tsx`, came out to
 * `projects/[key]/use-run.ts` when the Portal tab wanted it, and moved
 * to `src/components` when the client Contacts tab became the third
 * feature to need it. A review of that third copy is what prompted the
 * move: there were by then FOUR hand-rolled versions of these nine lines
 * (`clients/[id]/overview-forms.tsx`, `clients/[id]/contacts/
 * contact-forms.tsx`, `members/member-admin.tsx`'s `useAdmin`, and a
 * fifth with a fallback message in `backlog/backlog-table.tsx`), and a
 * rule that lives in four copies is a rule that will hold in three.
 *
 * `useAdmin` and the backlog's variant are deliberately left alone: the
 * first tolerates a nullable result and the second carries a fallback
 * message, so folding them in would widen this signature for callers
 * that do not want it.
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
