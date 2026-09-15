"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import {
  VISIBILITY_VALUES,
  VisibilityBadge,
  VisibilityIcon,
  visibilityChipClass,
  type VisibilityValue,
} from "@/components/semantic";
import { cn } from "@/lib/utils";
import type { ItemSurface } from "@/lib/work-view";

import { createCommentAction } from "./actions";
import { LazyCommentEditor } from "./lazy-comment-editor";

/**
 * The two-mode composer (UI.md §5.6, slice 10). "Internal note" is the
 * default — the Comment model's, the database's and the founder's
 * (decision 2, 2026-09-12) — and "Reply to client" is a MODE of the same
 * composer, offered only on a task the client can see: the mode maps
 * 1:1 to the comment's visibility, so the toggle is a radio group whose
 * chosen option wears the read chip's own classes (`visibilityChipClass`
 * — §10.4: the write control is never less legible than the read one),
 * and a hint under the field says who will see the words BEFORE they
 * are posted, as the upload form does — wired to the field with
 * `aria-describedby`, so it is read before ⌘Enter posts. On a private
 * task there is no toggle at all — the badge says "Private to team" and
 * the hint "Follows ACME-12" — because a client reply there is what the
 * database refuses. A task made private UNDER an open composer (the
 * poll, a colleague) is handled by derivation, not by a remount: the
 * toggle disappears, the hint changes, and the post goes INTERNAL
 * whatever the mode was — the draft is never wiped (the composer is
 * keyed by the item alone, comments-section.tsx).
 *
 * The post runs in a TRANSITION with `router.refresh()` inside it, so
 * the editor clears and the announcement speaks on the render that
 * commits the server's row (the subtask island's rule). A refusal is
 * TOLD and the words stay in the field. The mode is kept between posts.
 */
const HINT_ID = "comment-composer-hint";

export function CommentComposer({
  itemId,
  itemNumber,
  itemKey,
  itemVisibility,
  projectKey,
  surface,
}: {
  itemId: string;
  itemNumber: number;
  /** "ACME-12" — the private hint names it. */
  itemKey: string;
  itemVisibility: VisibilityValue;
  projectKey: string;
  surface: ItemSurface;
}) {
  const t = useTranslations("projects.item.comments");
  const tRich = useTranslations("richText");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [mode, setMode] = useState<VisibilityValue>("INTERNAL");
  const [announced, setAnnounced] = useState("");
  const shared = itemVisibility === "CLIENT_VISIBLE";
  // A pick that is no longer offerable is not posted (see the header).
  const visibility: VisibilityValue = shared ? mode : "INTERNAL";

  const post = (doc: unknown): Promise<boolean> =>
    new Promise((resolve) => {
      startTransition(async () => {
        const r = await createCommentAction({ itemId, itemNumber, projectKey, surface, doc, visibility }).catch(
          () => ({ ok: false as const, message: t("failed.post") }),
        );
        if (!r.ok) {
          toast.error(r.message);
          resolve(false);
          return;
        }
        setAnnounced(t(r.value.visibility === "CLIENT_VISIBLE" ? "announce.postedVisible" : "announce.posted"));
        router.refresh();
        resolve(true);
      });
    });

  const toggle = shared ? (
    <div role="radiogroup" aria-label={t("mode.label")} className="flex flex-wrap items-center gap-1">
      {VISIBILITY_VALUES.map((v) => {
        const selected = mode === v;
        return (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={selected}
            data-testid={`comment-mode-${v}`}
            onClick={() => setMode(v)}
            className={cn(
              "inline-flex h-7 items-center gap-1 border px-2 text-xs whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              selected
                ? visibilityChipClass(v)
                : "rounded-sm border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <VisibilityIcon value={v} />
            {t(`mode.${v}`)}
          </button>
        );
      })}
    </div>
  ) : (
    <VisibilityBadge value="INTERNAL" size="sm" />
  );

  return (
    <div className="flex flex-col gap-2" data-testid="comment-composer">
      <p id={HINT_ID} className="text-xs text-muted-foreground">
        {!shared
          ? t("hint.private", { key: itemKey })
          : visibility === "CLIENT_VISIBLE"
            ? t("hint.client")
            : t("hint.internal")}
      </p>
      <LazyCommentEditor
        initialDoc={null}
        placeholder={t("placeholder")}
        ariaLabel={t("label")}
        ariaDescribedBy={HINT_ID}
        toolbarLabel={tRich("toolbar.comment")}
        submitLabel={visibility === "CLIENT_VISIBLE" ? t("postVisible") : t("post")}
        busy={isPending}
        onSubmit={post}
        footerStart={toggle}
        testId="comment-editor"
      />
      <span role="status" aria-live="polite" className="sr-only">
        {announced}
      </span>
    </div>
  );
}
