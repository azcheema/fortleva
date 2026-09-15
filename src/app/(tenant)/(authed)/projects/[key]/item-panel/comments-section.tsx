import { getTranslations } from "next-intl/server";

import { SectionCard } from "@/components/semantic";
import { panelSurfaceOf } from "@/lib/work-view";
import { COMMENT_LIST_LIMIT, type ItemComments, type ResolvedItemDetail } from "@/modules/work";

import { CommentCard } from "./comment-card";
import { CommentComposer } from "./comment-composer";

/**
 * The item panel's Comments section (UI.md §5.4 / §5.6, slice 10),
 * between the attachments and the Activity section on both surfaces:
 * the task's live comments oldest first, each a `CommentCard` with its
 * own chip, cue and verbs, then the two-mode composer for a member who
 * holds `comment:create`. The rows are `getItemDetail`'s one scoped
 * read (comments.ts), so the section can never list the thread of a
 * task the panel refused, and each row already carries what the
 * reading member may do to it.
 *
 * A row's document crosses to the card ONCE, as its prop: the card
 * renders it with the static renderer (no editor) and the in-place
 * editor starts from the same copy — twenty comments cost no Tiptap,
 * and no body is serialised twice. A thread past the limit lists its
 * newest, counts the whole thread in the header and says so (paging a
 * thread is a later slice; two hundred comments on one task is not a
 * shape this product has met). With nothing posted and nothing to post
 * with, the section is one sentence — an `empty` with no verb is a
 * dead end (§5.8), and for a member who can comment the composer IS
 * the verb.
 */
export async function CommentsSection({
  item,
  itemKey,
  projectKey,
  surface,
  comments,
  canComment,
}: {
  item: Pick<ResolvedItemDetail, "id" | "number" | "visibility">;
  /** "ACME-12" — the composer's private hint names it. */
  itemKey: string;
  projectKey: string;
  surface: "board" | "backlog" | "page";
  comments: ItemComments;
  /** `comment:create` — whether the composer is rendered. */
  canComment: boolean;
}) {
  const t = await getTranslations("projects.item.comments");
  // The instant every relative time on this render is measured from,
  // taken AFTER the read (the Activity section's rule).
  const serverNow = new Date().toISOString();
  const rows = comments.rows;
  const itemSurface = panelSurfaceOf(surface);

  return (
    <SectionCard
      id="comments"
      title={t("title")}
      className="scroll-mt-16"
      actions={
        comments.total > 0 ? (
          <span className="num text-sm text-muted-foreground" data-testid="item-comment-count">
            {t("count", { count: comments.total })}
          </span>
        ) : null
      }
    >
      <div data-testid="item-comments" className="flex flex-col gap-4">
        {comments.truncated ? (
          <p className="text-xs text-muted-foreground">{t("truncated", { limit: COMMENT_LIST_LIMIT })}</p>
        ) : null}
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <ol className="flex flex-col gap-2" data-testid="item-comment-list">
            {rows.map((row) => (
              <CommentCard
                key={row.id}
                comment={{
                  id: row.id,
                  authorName: row.author.name,
                  visibility: row.visibility,
                  createdAt: row.createdAt.toISOString(),
                  editedAt: row.editedAt ? row.editedAt.toISOString() : null,
                  canEdit: row.canEdit,
                  canDelete: row.canDelete,
                  canChangeVisibility: row.canChangeVisibility,
                  body: row.body,
                }}
                itemNumber={item.number}
                projectKey={projectKey}
                surface={itemSurface}
                now={serverNow}
              />
            ))}
          </ol>
        )}
        {canComment ? (
          <CommentComposer
            // Keyed by the ITEM alone: a panel reused for another task
            // remounts the composer; a task made private under it does
            // NOT — the composer derives what it may post from the prop,
            // and a remount would wipe the member's draft.
            key={item.id}
            itemId={item.id}
            itemNumber={item.number}
            itemKey={itemKey}
            itemVisibility={item.visibility}
            projectKey={projectKey}
            surface={itemSurface}
          />
        ) : null}
      </div>
    </SectionCard>
  );
}
