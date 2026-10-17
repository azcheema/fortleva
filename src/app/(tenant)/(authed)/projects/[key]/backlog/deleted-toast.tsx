"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { isActionRedirect } from "@/lib/action-redirect";

import { restoreDeletedItemAction, type DeletedView } from "./actions";

/** How long "Task deleted" offers Undo — the timer's window: sonner's 4 s default is shorter than a slow refresh. */
const UNDO_WINDOW_MS = 30_000;
/** A task that comes back private says what stays private — a sentence too long for sonner's 4 s. */
export const PRIVATE_SENTENCE_MS = 12_000;

/**
 * "TASK DELETED" WITH UNDO (slice 126, founder decision C102 (a); UI.md
 * §5.9 "Undo toast where reversible") — the one toast the backlog row and
 * the board card show after a delete. Undo is the bin's own verb
 * (`restoreDeletedItemAction`, `via: "undo"`), so the task comes back as it
 * would from the bin: hidden from the client, and the answer says so.
 *
 * AN UNDO IS NEVER IGNORED: it is not guarded by the delete's pending
 * refresh, which can outlast the click by seconds (AGENTS.md's revalidating
 * transition trap) — a dropped undo would take the only quick way back with
 * it. AND IT ACTS ONCE: sonner keeps the button mounted through its exit
 * animation, so a second press would send a restore the server would only
 * answer "already back". AND IT NAMES ITS DELETION: the stamp the delete
 * returned, so an Undo pressed after a colleague brought the task back and
 * deleted it again is told so, and brings back nothing.
 */
export function useDeletedToast(projectKey: string): (itemId: string, deleted: DeletedView) => void {
  const t = useTranslations("projects.bin");
  const router = useRouter();
  return (itemId, deleted) => {
    let undone = false;
    toast.success(deleted.message, {
      duration: UNDO_WINDOW_MS,
      action: {
        label: t("undo"),
        onClick: () => {
          if (undone) return;
          undone = true;
          void (async () => {
            try {
              const r = await restoreDeletedItemAction(itemId, projectKey, "undo", deleted.deletedAt);
              if (!r.ok) toast.error(r.message);
              // Nothing came back: told, never drawn as a success (code review).
              else if (r.value.superseded) toast.info(r.value.message, { duration: PRIVATE_SENTENCE_MS });
              else toast.success(r.value.message, r.value.madePrivate ? { duration: PRIVATE_SENTENCE_MS } : undefined);
            } catch (err) {
              // A redirect (a session that ended) navigates on its own.
              if (isActionRedirect(err)) return;
              toast.error(t("failed"));
            }
            router.refresh();
          })();
        },
      },
    });
  };
}
