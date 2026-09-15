"use client";

import { EyeIcon, LockIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { RelativeTime } from "@/components/relative-time";
import { RichText } from "@/components/rich-text/render";
import { RowActions, VisibilityBadge, visibilityRowCue, type RowAction } from "@/components/semantic";
import { cn } from "@/lib/utils";
import type { ItemSurface } from "@/lib/work-view";

import { deleteCommentAction, setCommentVisibilityAction, updateCommentAction } from "./actions";
import { LazyCommentEditor } from "./lazy-comment-editor";

/**
 * One posted comment (UI.md §5.4, slice 10): the author, when, its own
 * visibility chip and row cue — a comment is a class-B row, and the
 * chip is its OWN visibility, never the task's (an internal note sits
 * on a shared task wearing "Private to team") — the body (the static
 * renderer, `RichText`, run here from the one copy of the document the
 * row carries, which the in-place editor starts from too), and the
 * row's verbs in a `<RowActions>` menu (§5.12): edit in place, flip
 * visibility, delete behind the §5.9 question. Which verbs exist is
 * the SERVICE's answer, stamped on the row (`canEdit` / `canDelete` /
 * `canChangeVisibility`); this island never decides who may do what.
 *
 * Every change runs in a TRANSITION and `router.refresh()` is issued
 * inside it, so the state set after the await — the editor closing —
 * lands on exactly the render that commits the server's row (the
 * subtask island's rule): a successful edit never flashes the old
 * words between the save and the refresh. A failure is TOLD and the
 * panel is refreshed too — a comment a colleague deleted meanwhile must
 * not keep rendering with its menu — while the editor's text stays the
 * member's. The visibility flip is never optimistic (§10.4): the chip
 * holds the canonical value until the server answers. A deletion is
 * announced by a toast, not by a live region inside the row: the row
 * unmounts on the very render that would have spoken.
 */
export type CommentCardData = {
  id: string;
  authorName: string | null;
  visibility: "INTERNAL" | "CLIENT_VISIBLE";
  /** ISO — a Date does not cross the client boundary as one. */
  createdAt: string;
  editedAt: string | null;
  canEdit: boolean;
  canDelete: boolean;
  canChangeVisibility: boolean;
  /** The stored document — rendered here, and the in-place editor starts from it. */
  body: unknown;
};

export function CommentCard({
  comment,
  itemNumber,
  projectKey,
  surface,
  now,
}: {
  comment: CommentCardData;
  itemNumber: number;
  projectKey: string;
  surface: ItemSurface;
  /** The server's instant, for the relative time. */
  now: string;
}) {
  const t = useTranslations("projects.item.comments");
  const tRich = useTranslations("richText");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [announced, setAnnounced] = useState("");
  const address = { commentId: comment.id, itemNumber, projectKey, surface };
  const who = comment.authorName ?? tCommon("unknown");

  // The edit's submit: resolved only once the action has answered, and
  // the editor closes on the refresh's own render (see the header). The
  // editor is told to KEEP the text (false) either way — on success it
  // unmounts, on failure the words are still the member's.
  const save = (doc: unknown): Promise<boolean> =>
    new Promise((resolve) => {
      startTransition(async () => {
        const r = await updateCommentAction({ ...address, doc }).catch(() => ({
          ok: false as const,
          message: t("failed.edit"),
        }));
        if (r.ok) {
          setAnnounced(t("announce.edited"));
          setEditing(false);
        } else {
          toast.error(r.message);
        }
        router.refresh();
        resolve(false);
      });
    });

  const remove = () => {
    startTransition(async () => {
      const r = await deleteCommentAction(address).catch(() => ({ ok: false as const, message: t("failed.delete") }));
      if (r.ok) toast.success(t("announce.deleted"));
      else toast.error(r.message);
      router.refresh();
    });
  };

  const flip = () => {
    const visibility = comment.visibility === "INTERNAL" ? "CLIENT_VISIBLE" : "INTERNAL";
    startTransition(async () => {
      const r = await setCommentVisibilityAction({ ...address, visibility }).catch(() => ({
        ok: false as const,
        message: t("failed.visibility"),
      }));
      if (r.ok) {
        setAnnounced(t(r.value.visibility === "CLIENT_VISIBLE" ? "announce.madeVisible" : "announce.madePrivate"));
      } else {
        toast.error(r.message);
      }
      router.refresh();
    });
  };

  const items: RowAction[] = [];
  if (comment.canEdit) items.push({ key: "edit", label: tCommon("edit"), icon: PencilIcon, onSelect: () => setEditing(true) });
  if (comment.canChangeVisibility) {
    items.push(
      comment.visibility === "INTERNAL"
        ? { key: "visibility", label: t("makeVisible"), icon: EyeIcon, onSelect: flip }
        : { key: "visibility", label: t("makePrivate"), icon: LockIcon, onSelect: flip },
    );
  }
  if (comment.canDelete) {
    items.push({
      key: "delete",
      label: tCommon("delete"),
      icon: Trash2Icon,
      tone: "danger",
      confirm: t("confirmDelete"),
      onSelect: remove,
    });
  }

  return (
    <li
      id={`comment-${comment.id}`}
      data-testid="item-comment"
      data-comment-id={comment.id}
      data-visibility={comment.visibility}
      className={cn("-mx-2 flex flex-col gap-1 rounded-md px-2 py-2", visibilityRowCue(comment.visibility))}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="text-sm font-medium text-foreground">{who}</span>
        <RelativeTime at={comment.createdAt} now={now} />
        {comment.editedAt ? <span>{t("edited")}</span> : null}
        <VisibilityBadge value={comment.visibility} size="sm" />
        {items.length > 0 && !editing ? (
          <RowActions label={tCommon("actionsFor", { name: who })} items={items} className="ms-auto" />
        ) : null}
      </div>
      {editing ? (
        <LazyCommentEditor
          initialDoc={comment.body}
          placeholder={t("placeholder")}
          ariaLabel={t("editLabel")}
          toolbarLabel={tRich("toolbar.comment")}
          submitLabel={t("update")}
          cancelLabel={tCommon("cancel")}
          busy={isPending}
          autoFocus
          onSubmit={save}
          onCancel={() => {
            if (!isPending) setEditing(false);
          }}
          testId="comment-edit-editor"
        />
      ) : (
        <RichText doc={comment.body} data-testid="item-comment-body" className={cn("text-sm", isPending && "opacity-60")} />
      )}
      <span role="status" aria-live="polite" className="sr-only">
        {announced}
      </span>
    </li>
  );
}
