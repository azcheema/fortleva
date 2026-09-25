import { MaximizeIcon, PaperclipIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { getLocale, getTimeZone, getTranslations } from "next-intl/server";

import { Callout, EmptyState, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { DocumentListItem } from "@/documents/service";
import { isoDateOf } from "@/lib/duration";
import { formatDay, formatDuration, type DurationStyle } from "@/lib/format";
import type { WeekStart } from "@/lib/week";
import { childTypeOf } from "@/lib/enum-map";
import { isEndableRequest, panelItemHref, panelSurfaceOf } from "@/lib/work-view";
import type {
  ItemActivityPage,
  ItemComments,
  ItemDetailCaps,
  ItemLabels,
  MilestoneEntry,
  ResolvedItemDetail,
  ResolvedItemSubtasks,
  ResolvedWorkflowState,
} from "@/modules/work";

import { DocumentsTable } from "../../../files/documents-table";
import { UploadForm } from "../../../files/upload-form";
import type { TimerPillState } from "../../../time/actions";
import { ActivitySection } from "./activity-section";
import { AssigneeField } from "./assignee-field";
import { CommentsSection } from "./comments-section";
import { DescriptionField } from "./description-field";
import { DueDateField } from "./due-date-field";
import { EstimateField } from "./estimate-field";
import { LabelsField } from "./labels-field";
import { MilestoneField } from "./milestone-field";
import { PriorityField } from "./priority-field";
import { RequestBand } from "./request-band";
import { StateField } from "./state-field";
import { SubtasksSection } from "./subtasks-section";
import { TimerControl } from "./timer-control";
import { VisibilityField } from "./visibility-field";

/**
 * ONE item panel, rendered in two places (UI.md §5.4): the side-peek
 * (`?item=KEY-123`, a sheet) and the full page (`/projects/KEY/items/12`).
 * Everything below the header is identical by construction — a second
 * copy is how the two drift apart.
 *
 * Read-first: every property is its value as text until you edit it
 * (Mandate 1). State, Assignee, Priority, Estimate, Due date,
 * Visibility, Milestone and Labels each have a `<PropertyPicker>` island
 * behind them (§5.2 `S A P E D V M L`); the Subtasks section (slice 9) sits between the
 * description and the attachments; the Activity section (slice 8)
 * closes the panel; the rest of the rail and comments grow onto this
 * shell in the slices after it.
 */

export type ItemPanelCaps = {
  viewDocuments: boolean;
  uploadDocuments: boolean;
  deleteDocuments: boolean;
  changeDocumentVisibility: boolean;
};

export async function ItemPanel({
  item,
  itemKey,
  projectId,
  projectKey,
  documents,
  caps,
  returnTo,
  durationStyle,
  weekStart,
  showIsoWeek,
  error,
  surface,
  fullPageHref,
  itemCaps,
  states,
  members,
  contacts,
  milestones,
  labels,
  activity,
  subtasks,
  comments,
  timer,
}: {
  item: ResolvedItemDetail;
  /** "ACME-12" — the human key the header shows. */
  itemKey: string;
  /** The project's id — the Subtasks section's create names it. */
  projectId: string;
  projectKey: string;
  documents: DocumentListItem[];
  caps: ItemPanelCaps;
  /** This panel's own URL — actions revalidate/bounce back into it. */
  returnTo: string;
  durationStyle: DurationStyle;
  /** REQUIRED — the tenant's `ui.weekStart`: the due-date calendar starts its weeks here. */
  weekStart: WeekStart;
  /** REQUIRED — the tenant's `ui.showIsoWeek`: the due-date calendar shows week numbers. */
  showIsoWeek: boolean;
  /** A failed download/delete bounces back as `?error=` (the Files-tab
   * contract) — the panel must show it, or a failure looks like nothing
   * happened (the standing rule). */
  error?: string;
  /**
   * WHICH surface this is, not merely how it looks. The property
   * pickers' MFA step-up return address is derived from it
   * (`panelSurfaceOf` → `itemReturnTo`), so "the page rendered with the
   * backlog's return address" — the bug the old hardcoded backlog path
   * was — cannot be expressed.
   * The look follows from it (`variant`, below).
   */
  surface: "board" | "backlog" | "page";
  /**
   * The full item page — REQUIRED on every surface: the peek links out
   * to it, and the Activity section's older pages live on it whichever
   * surface renders the section (the page passes its own URL).
   */
  fullPageHref: string;
  /** What this member may do here — `getItemDetail`'s answer (`ItemDetailCaps`), never the caller's. */
  itemCaps: ItemDetailCaps;
  /** The project's states, by rank, names already resolved. */
  states: ResolvedWorkflowState[];
  /** The Assignee picker's rows — `getItemDetail`'s, so the full page has them too. */
  members: readonly { id: string; name: string }[];
  /** The Assignee picker's CLIENT rows — the item's client's contacts who can hold a task; empty is ordinary. */
  contacts: readonly { id: string; name: string }[];
  /** The Milestone picker's rows — the project's phases by rank, `getItemDetail`'s for the same reason. */
  milestones: readonly MilestoneEntry[];
  /** The task's labels and its vocabulary — `getItemDetail`'s (slice 12). */
  labels: ItemLabels;
  /** The Activity section's page — `getItemDetail`'s, behind the same scope check as the item; it carries its own cursor. */
  activity: ItemActivityPage;
  /** The Subtasks section's rows — `getItemDetail`'s, behind the same scope check as the item. */
  subtasks: ResolvedItemSubtasks;
  /** The Comments section's rows — `getItemDetail`'s, each with the reading member's own caps (slice 10). */
  comments: ItemComments;
  /**
   * REQUIRED — `loadPanelTimer`'s answer: the member's timer as the pill
   * sees it, or `null` where no timer control belongs (no `time:track`,
   * or an archived project). An archived TASK is decided here.
   */
  timer: TimerPillState | null;
}) {
  // The sheet owns the dialog title; the page owns the document's h1.
  const variant = surface === "page" ? "page" : "peek";
  // `edit` gates the description and the properties; `approve` whether a
  // gated state is a legal target; `changeVisibility` whether the chip is
  // a control (§10.4); `create` the Subtasks add row; `comment` the
  // composer.
  const {
    edit: canEdit,
    approve: canApprove,
    changeVisibility: canChangeVisibility,
    create: canCreate,
    comment: canComment,
    endRequest: canEndRequest,
  } = itemCaps;
  const t = await getTranslations("projects.item");
  const tStates = await getTranslations("states");
  const tFiles = await getTranslations("files");
  const tCommon = await getTranslations("common");
  const locale = await getLocale();
  // The zone the request resolved (Member.timezone → tenant ui.timezone
  // → Europe/Stockholm). The due-date picker's "today" is taken in it —
  // never in the browser's zone, which is the wrong-day trap.
  const timeZone = await getTimeZone();
  const internal = item.visibility === "INTERNAL";

  // `parentKey` is built here because a template literal as a JSX CHILD
  // is what react/jsx-no-literals reports (props are exempt); the href
  // is hoisted only to keep the pair together. The link stays on THIS
  // surface (slice 9, the subtask rows' rule): from a peek it is the
  // parent's peek over the same list, from the page the parent's page.
  const parentKey = item.parent ? `${projectKey}-${item.parent.number}` : null;
  const parentHref = item.parent ? panelItemHref(surface, returnTo, projectKey, item.parent.number) : null;

  // h2, not h1: the project shell above already owns the page's single
  // h1 (its header), and the craft audit fails any stop with two — this
  // panel is a tab-level surface, exactly like the board and the backlog.
  const title =
    variant === "peek" ? (
      <SheetTitle>{item.title}</SheetTitle>
    ) : (
      <h2 className="text-lg font-semibold tracking-tight">{item.title}</h2>
    );

  // The visibility chip left this row for the rail (slice 7): it is the
  // `V` picker's own rest state there, and a chip that appears twice on
  // one panel is a chip that can disagree with itself.
  const archivedNote = item.archivedAt ? (
    <span className="text-xs text-muted-foreground">{tCommon("archived")}</span>
  ) : null;
  // `T` on this task (2T): a start/stop control beside the full-page link.
  // An archived task takes no new time, so it gets no control — and no
  // item-scope `T`, which leaves the global one (stop / go to /time) live.
  const timerControl = timer && !item.archivedAt ? <TimerControl key={item.id} itemId={item.id} initial={timer} /> : null;
  const fullPageLink =
    variant === "peek" ? (
      <Button asChild variant="ghost" size="sm" className="ms-auto">
        <Link href={fullPageHref} data-testid="item-full-page">
          <MaximizeIcon />
          {t("openFullPage")}
        </Link>
      </Button>
    ) : null;

  const header = (
    <>
      <span className="num-id text-xs text-muted-foreground">{itemKey}</span>
      {title}
      {variant === "peek" ? <SheetDescription className="sr-only">{t("sheetDescription")}</SheetDescription> : null}
      {archivedNote || timerControl || fullPageLink ? (
        <div className="flex flex-wrap items-center gap-2">
          {archivedNote}
          {timerControl}
          {fullPageLink}
        </div>
      ) : null}
    </>
  );

  // Read-first property list (UI.md §10.15 pattern 7). The eight pickers
  // are siblings in rail order, each keyed by the ITEM: `PeekShell` never
  // remounts between items, so without the key an optimistic value — or
  // an open popover — would survive a navigation from one task to the
  // next; and the `?` overlay lists a scope's keys in registration order,
  // which is this DOM order (S A P E D V M L — the order §2 rule 3 spells
  // the keys in). Six of the eight are UNCONDITIONAL; `M` and `L` are the
  // two that are not, and each row says why.
  //
  // ONE row geometry for a trigger and for text: every label and every
  // value is at least the trigger's 32px (`restBoxClass`'s `h-8`), so a
  // label sits level with its value whichever kind the value is — mixing
  // a 32px trigger with a 20px text line put each picker's label 6px
  // above its value and gave the rail rows of two heights. A label and a
  // TEXT value pad their one 20px line out to those 32px rather than
  // centring in them, so a value that wraps (a long parent title) grows
  // downward and stays level with its label on its FIRST line. A PICKER
  // value is centred in the same 32px — which is also where a read-only
  // island's plain text lands.
  // Coining a label from the picker needs the word's right AND this task's.
  const canCreateLabel = canEdit && itemCaps.manageLabels;
  const railLabel = "min-h-8 py-1.5 text-muted-foreground";
  const railText = "min-h-8 py-1.5";
  const railPicker = "flex min-h-8 items-center";
  /**
   * THE REQUEST BAND (C29), drawn only where both hold: the row is a
   * live client request (`isEndableRequest` — the one rule the board's
   * and the backlog's menus read too: not archived, since `triageItem`
   * refuses an archived row, and neither CANCELLED, already ended, nor
   * DONE, not stopping; TRIAGE included, because a SNOOZED request
   * drops out of the lane and this is its only door), and this member
   * may speak to a client in the agency's name (`work_item:triage` AND
   * `work_item:triage_decline`, both of which `triageItem` demands —
   * UI.md §3.1, hidden and never disabled).
   *
   * Built here rather than inline because the panel renders its rail at
   * TWO stops — the peek's sheet and the full page's card — and a
   * control that appeared on only one of them would be a door that
   * exists depending on how you opened the task.
   */
  const requestBand =
    canEndRequest && isEndableRequest(item) ? (
      <RequestBand
        itemId={item.id}
        itemNumber={item.number}
        itemTitle={item.title}
        // The verb follows it — "Decline" in TRIAGE, "Cancel and reply"
        // once the work was agreed — and so does what the toast says.
        stateCategory={item.stateCategory}
        projectKey={projectKey}
        surface={surface}
      />
    ) : null;

  const rail = (
    // `data-slot="item-rail"` is a PRODUCT hook, not a test id: the request
    // band hands focus to the rail's first control (State) when the request
    // it offered to end has ended and the band goes (request-band.tsx).
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm" data-testid="item-properties" data-slot="item-rail">
        <dt className={railLabel}>{t("properties.state")}</dt>
        <dd className={railPicker}>
          <StateField
            key={item.id}
            itemId={item.id}
            itemNumber={item.number}
            projectKey={projectKey}
            surface={surface}
            kind={item.kind}
            stateId={item.stateId}
            stateName={item.stateName}
            stateCategory={item.stateCategory}
            states={states}
            canEdit={canEdit}
            canApprove={canApprove}
          />
        </dd>
        <dt className={railLabel}>{t("properties.assignee")}</dt>
        <dd className={railPicker}>
          <AssigneeField
            key={item.id}
            itemId={item.id}
            itemNumber={item.number}
            projectKey={projectKey}
            surface={surface}
            assigneeMemberId={item.assigneeMemberId}
            assigneeContactId={item.assigneeContactId}
            assigneeName={item.assigneeName ?? item.assigneeContactName}
            visibility={item.visibility}
            portalEnabled={item.portalEnabled}
            members={members}
            contacts={contacts}
            canEdit={canEdit}
            canChangeVisibility={itemCaps.changeVisibility}
          />
        </dd>
        <dt className={railLabel}>{t("properties.type")}</dt>
        <dd className={railText}>
          {tStates(`workItemType.${item.type}`)}
          {item.kind !== "TASK" ? ` · ${tStates(`workItemKind.${item.kind}`)}` : ""}
        </dd>
        <dt className={railLabel}>{t("properties.priority")}</dt>
        <dd className={railPicker}>
          <PriorityField
            key={item.id}
            itemId={item.id}
            itemNumber={item.number}
            projectKey={projectKey}
            surface={surface}
            priority={item.priority}
            canEdit={canEdit}
          />
        </dd>
        <dt className={railLabel}>{t("properties.estimate")}</dt>
        <dd className={railPicker}>
          <EstimateField
            key={item.id}
            itemId={item.id}
            itemNumber={item.number}
            projectKey={projectKey}
            surface={surface}
            estimateMinutes={item.estimateMinutes}
            // Formatted HERE with the helper the island formats with, so
            // the trigger's first paint and its adopted value agree.
            estimateLabel={
              item.estimateMinutes != null ? formatDuration(locale, item.estimateMinutes, durationStyle) : null
            }
            durationStyle={durationStyle}
            canEdit={canEdit}
          />
        </dd>
        <dt className={railLabel}>{t("properties.startDate")}</dt>
        {/* @db.Date columns are UTC midnight: `formatDay` formats in UTC,
            or the day shifts west of UTC (the backlog's review finding). */}
        <dd className={`${railText} num`}>{item.startDate ? formatDay(locale, item.startDate) : "—"}</dd>
        <dt className={railLabel}>{t("properties.dueDate")}</dt>
        <dd className={railPicker}>
          <DueDateField
            key={item.id}
            itemId={item.id}
            itemNumber={item.number}
            projectKey={projectKey}
            surface={surface}
            dueDate={item.targetDate ? isoDateOf(item.targetDate) : null}
            // The server's label, the same one the action returns, so it
            // never flickers between Node's and the browser's ICU.
            dueLabel={item.targetDate ? formatDay(locale, item.targetDate) : null}
            timeZone={timeZone}
            weekStart={weekStart}
            showIsoWeek={showIsoWeek}
            canEdit={canEdit}
          />
        </dd>
        <dt className={railLabel}>{t("properties.visibility")}</dt>
        <dd className={railPicker}>
          <VisibilityField
            key={item.id}
            itemId={item.id}
            itemNumber={item.number}
            projectKey={projectKey}
            surface={surface}
            visibility={item.visibility}
            canChangeVisibility={canChangeVisibility}
          />
        </dd>
        {item.parent && parentHref ? (
          <>
            <dt className={railLabel}>{t("properties.parent")}</dt>
            <dd className={railText}>
              <Link href={parentHref} className="underline-offset-4 hover:underline" data-testid="item-parent-link">
                <span className="num-id">{parentKey}</span> <span>{item.parent.title}</span>
              </Link>
            </dd>
          </>
        ) : null}
        {/* A project that uses no phases gets no row: an always-present
            "Milestone —" would be noise on every task of every project
            that files nothing under one, and there would be nothing for
            `M` to open. A row the member cannot edit still shows the
            phase the item IS under, as text — `milestones` is empty for
            them (the read is gated on `work_item:edit`). */}
        {item.milestone || milestones.length > 0 ? (
          <>
            <dt className={railLabel}>{t("properties.milestone")}</dt>
            <dd className={railPicker}>
              <MilestoneField
                key={item.id}
                itemId={item.id}
                itemNumber={item.number}
                projectKey={projectKey}
                surface={surface}
                milestoneId={item.milestone?.id ?? null}
                milestoneName={item.milestone?.name ?? null}
                milestoneStatus={item.milestone?.status ?? null}
                milestones={milestones}
                canEdit={canEdit}
              />
            </dd>
          </>
        ) : null}
        {/* Same shape as the milestone row: a row where there is a label
            to show or a word to reach — the task's own, a vocabulary to
            pick from (empty for a member who cannot edit), or the right
            to coin one — with `canCreate` folded ONCE for the row and the
            island alike. */}
        {labels.applied.length > 0 || labels.offered.length > 0 || canCreateLabel ? (
          <>
            <dt className={railLabel}>{t("properties.labels")}</dt>
            <dd className={railPicker}>
              <LabelsField
                key={item.id}
                itemId={item.id}
                itemNumber={item.number}
                projectKey={projectKey}
                surface={surface}
                applied={labels.applied}
                offered={labels.offered}
                canEdit={canEdit}
                canCreate={canCreateLabel}
              />
            </dd>
          </>
        ) : null}
        {item.checklistTotal > 0 ? (
          <>
            <dt className={railLabel}>{t("properties.checklist")}</dt>
            <dd className={`${railText} num`}>{t("properties.checklistValue", { done: item.checklistDone, total: item.checklistTotal })}</dd>
          </>
        ) : null}
    </dl>
  );

  return (
    <div className="flex flex-col">
      {/* The sheet owns its own header slot; on the page the identity and
          the rail sit in a card, as every other tab-level surface does. */}
      {variant === "peek" ? (
        <>
          <SheetHeader>{header}</SheetHeader>
          <div className="px-4 pb-4">
            {requestBand}
            {rail}
          </div>
        </>
      ) : (
        <div className="pb-4">
          <SectionCard>
            <div className="flex flex-col gap-2 pb-4">{header}</div>
            {requestBand}
            {rail}
          </SectionCard>
        </div>
      )}

      <div className={variant === "peek" ? "px-4 pb-4" : "pb-4"}>
        <DescriptionField
          // Keyed by the ITEM, so a panel reused for a different task
          // remounts the editor instead of rebinding the save to the new
          // task while the old task's text is still on screen.
          key={item.id}
          itemId={item.id}
          itemNumber={item.number}
          projectId={projectId}
          projectKey={projectKey}
          surface={panelSurfaceOf(surface)}
          doc={item.description}
          token={item.descriptionToken}
          visibility={item.visibility}
          editable={canEdit}
          // ⌘⇧O makes a CHILD, so it is offered on exactly the items the
          // Subtasks section is rendered for, under the same cap.
          childLevel={childTypeOf(item.type)}
          canCreate={canCreate}
        />
      </div>

      {/* The lowest level has no children (`childTypeOf`): no section,
          rather than an empty one offering a verb the database would
          refuse. */}
      {childTypeOf(item.type) !== null ? (
        <div className={variant === "peek" ? "px-4 pb-4" : "pb-4"}>
          <SubtasksSection
            item={item}
            itemKey={itemKey}
            projectId={projectId}
            projectKey={projectKey}
            surface={surface}
            returnTo={returnTo}
            subtasks={subtasks}
            canCreate={canCreate}
          />
        </div>
      ) : null}

      <div className={variant === "peek" ? "px-4 pb-4" : ""}>
        {error ? (
          <Callout tone="danger" role="alert" className="mb-4">
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="min-w-0 flex-1">{error}</span>
              <Button asChild variant="ghost" size="icon-sm">
                <Link href={returnTo} aria-label={tCommon("close")}>
                  <XIcon />
                </Link>
              </Button>
            </span>
          </Callout>
        ) : null}
        <SectionCard title={t("attachments.title")}>
          {!caps.viewDocuments ? (
            <EmptyState variant="forbidden" icon={PaperclipIcon} title={t("attachments.noAccess")} />
          ) : (
            <div className="flex flex-col gap-4">
              {documents.length === 0 ? (
                <EmptyState
                  variant="empty"
                  icon={PaperclipIcon}
                  title={t("attachments.empty")}
                  body={internal ? t("attachments.emptyDescription") : t("attachments.emptyDescriptionVisible")}
                  action={
                    caps.uploadDocuments ? (
                      <Button asChild size="sm">
                        <Link href="#upload-file">{tFiles("upload.title")}</Link>
                      </Button>
                    ) : null
                  }
                />
              ) : (
                <DocumentsTable
                  documents={documents}
                  returnTo={returnTo}
                  canDelete={caps.deleteDocuments}
                  canChangeVisibility={caps.changeDocumentVisibility}
                />
              )}
              {caps.uploadDocuments ? (
                <UploadForm
                  // Re-mount when the item's visibility changes under the
                  // open panel (the 12 s poll): the safety-critical select
                  // must never contradict its own hint (standing trap).
                  key={`${item.id}:${item.visibility}`}
                  target={{ attachedToType: "WORK_ITEM", attachedToId: item.id, returnTo }}
                  visibilityEnabled={!internal}
                  defaultVisibility={item.visibility}
                  visibilityHint={internal ? t("attachments.followsItem", { key: itemKey }) : undefined}
                />
              ) : null}
            </div>
          )}
        </SectionCard>
      </div>

      <div className={variant === "peek" ? "px-4 pb-4" : "pt-4"}>
        <CommentsSection
          item={item}
          itemKey={itemKey}
          projectKey={projectKey}
          surface={surface}
          comments={comments}
          canComment={canComment}
        />
      </div>

      <div className={variant === "peek" ? "px-4 pb-4" : "pt-4"}>
        <ActivitySection
          activity={activity}
          pageHref={fullPageHref}
          states={states}
          durationStyle={durationStyle}
        />
      </div>
    </div>
  );
}
