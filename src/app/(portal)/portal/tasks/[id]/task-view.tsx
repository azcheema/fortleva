import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";

import { RichText } from "@/components/rich-text/render";
import { Callout, Page, PageHeader, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { readPortalTask, type PortalComment } from "@/modules/work";
import { portalReadOrNull, type PortalPrincipal } from "@/portal";

import { PortalFrame } from "../../portal-frame";
import { PortalTaskDone } from "../../task-done";
import { CategoryChip, PortalTasksEmpty, TaskMeta, isWaitingOnYou } from "../../task-list";
import { PortalCommentComposer } from "./comment-composer";

/**
 * ONE SHARED TASK AND ITS CONVERSATION, AS A COMPONENT (Phase 3 slice 75;
 * founder decision C41: the conversation lives on the task's own page) —
 * everything `/portal/tasks/[id]` is, minus the decision about who is
 * asking.
 *
 * A component and not a page for the reason `<PortalProjectView>` is:
 * View-as-Contact renders it too, at `/view-as/tasks/[id]`, under a
 * synthesised principal, and `e2e/view-as.spec.ts` compares the two
 * renderings byte for byte. So nothing here reaches for a request
 * context — the contact's name comes in as a prop, their language and
 * time zone are the whole request's — and the task is resolved INSIDE
 * from the id, so the two routes cannot hand it two different tasks.
 *
 * WHAT IS ON IT: the task as the list shows it (its title, its category,
 * its facts line, the agency's answer on an answered request, the reader's
 * own "I've done my part" where it applies — the row's components, so the
 * page and the row cannot drift), then the conversation: the task's
 * CLIENT_VISIBLE comments oldest first, each signed by the client's own
 * person or "Your agency" (C42 — never a member's name), then the box to
 * write in. Nothing else: no description (not on UI.md §11's list), no
 * assignee, no history.
 *
 * DATES ARE ABSOLUTE ("12 Sep 2026, 14:05"), never "two hours ago": a
 * relative time would differ between the contact's render and the
 * View-as render a minute later, and the byte comparison would measure
 * the clock.
 *
 * ONE READ, through `portalReadOrNull`: a task that is not this client's,
 * not shared, cancelled, archived, or on a project switched off or
 * archived renders the plane's one uniform empty page.
 */
export async function PortalTaskView({
  principal,
  name,
  taskId,
}: {
  principal: PortalPrincipal;
  name: string;
  taskId: string;
}) {
  const t = await getTranslations("portal");
  const tStates = await getTranslations("states.portalTaskCategory");
  const format = await getFormatter();

  const page = await portalReadOrNull("readPortalTask", () => readPortalTask(principal, taskId));

  // Who wrote it, as the client may be told (C42): their own person, or
  // the agency — never a member.
  const authorLabel = (comment: PortalComment): string => {
    if (comment.author.kind === "agency") return t("comments.agency");
    const person = comment.author.name ?? t("comments.unknown");
    return comment.author.you ? t("comments.you", { name: person }) : person;
  };

  return (
    <PortalFrame name={name} principal={principal} nav="home">
      <Page>
        <div className="flex flex-col gap-6">
          <PageHeader
            title={page ? page.task.title : t("task.title")}
            badges={
              page ? <CategoryChip category={page.task.category} label={tStates(page.task.category)} /> : null
            }
            description={
              page ? (
                <span data-slot="portal-task-facts" className="flex flex-col gap-1">
                  <span>
                    {/* The project it belongs to, linking back to its page.
                        No prefetch: rendered on the member plane too. */}
                    <Link
                      href={`/portal/projects/${page.project.key}`}
                      prefetch={false}
                      className="text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                      {page.project.name}
                    </Link>
                  </span>
                  <TaskMeta task={page.task} />
                </span>
              ) : undefined
            }
            actions={
              <Button asChild variant="outline" size="sm">
                {/* No prefetch: rendered on the member plane too (View-as). */}
                <Link href={page ? `/portal/projects/${page.project.key}` : "/portal"} prefetch={false}>
                  {page ? t("task.back") : t("project.back")}
                </Link>
              </Button>
            }
          />

          {!page ? (
            <PortalTasksEmpty />
          ) : (
            <>
              {/* THE AGENCY'S ANSWER, on an answered request only — the
                  row's sentence, at the size a page can give it. */}
              {page.task.reply ? (
                <div data-slot="portal-task-reply">
                  <Callout tone="info" title={t("task.replyTitle")}>
                    {page.task.reply}
                  </Callout>
                </div>
              ) : null}

              {/* THE READER'S OWN TICK, where it would work — the row's
                  predicate and the row's control. */}
              {isWaitingOnYou(page.task) ? (
                <SectionCard contentClassName="p-4">
                  <PortalTaskDone
                    itemId={page.task.id}
                    markedDoneAt={page.task.markedDoneAt?.toISOString() ?? null}
                  />
                </SectionCard>
              ) : null}

              <SectionCard
                title={t("comments.title")}
                description={t("comments.description")}
                contentClassName="flex flex-col gap-4 p-4"
              >
                {page.commentsTruncated ? (
                  <Callout tone="info">{t("comments.truncated", { count: page.comments.length })}</Callout>
                ) : null}
                {page.comments.length > 0 ? (
                  <ol data-slot="portal-comments" className="flex flex-col gap-4">
                    {page.comments.map((comment) => (
                      <CommentRow
                        key={comment.id}
                        comment={comment}
                        author={authorLabel(comment)}
                        at={format.dateTime(comment.createdAt, { dateStyle: "medium", timeStyle: "short" })}
                        iso={comment.createdAt.toISOString()}
                        edited={comment.edited ? t("comments.edited") : null}
                      />
                    ))}
                  </ol>
                ) : (
                  <p data-slot="portal-comments-empty" className="text-sm text-muted-foreground">
                    {t("comments.empty")}
                  </p>
                )}
                {page.canComment ? <PortalCommentComposer itemId={page.task.id} /> : null}
              </SectionCard>
            </>
          )}
        </div>
      </Page>
    </PortalFrame>
  );
}

/** One comment. ONE text expression per span — the byte comparison's rule (slice 70's lesson). */
function CommentRow({
  comment,
  author,
  at,
  iso,
  edited,
}: {
  comment: PortalComment;
  author: string;
  at: string;
  iso: string;
  edited: string | null;
}) {
  return (
    <li
      data-slot="portal-comment"
      data-author={comment.author.kind}
      className="flex flex-col gap-1 border-b border-border pb-4 last:border-b-0 last:pb-0"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        <span className="text-sm font-medium text-foreground">{author}</span>
        <time dateTime={iso}>{at}</time>
        {edited ? <span>{edited}</span> : null}
      </div>
      <RichText doc={comment.body} className="text-sm" />
    </li>
  );
}
