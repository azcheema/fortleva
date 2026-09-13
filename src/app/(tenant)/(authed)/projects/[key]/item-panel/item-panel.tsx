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
import type { ResolvedItemDetail, ResolvedWorkflowState } from "@/modules/work";

import { DocumentsTable } from "../../../files/documents-table";
import { UploadForm } from "../../../files/upload-form";
import { AssigneeField } from "./assignee-field";
import { DescriptionField } from "./description-field";
import { DueDateField } from "./due-date-field";
import { EstimateField } from "./estimate-field";
import { PriorityField } from "./priority-field";
import { StateField } from "./state-field";
import { VisibilityField } from "./visibility-field";

/**
 * ONE item panel, rendered in two places (UI.md §5.4): the side-peek
 * (`?item=KEY-123`, a sheet) and the full page (`/projects/KEY/items/12`).
 * Everything below the header is identical by construction — a second
 * copy is how the two drift apart.
 *
 * Read-first: every property is its value as text until you edit it
 * (Mandate 1). State, Assignee, Priority, Estimate, Due date and
 * Visibility each have a `<PropertyPicker>` island behind them (§5.2
 * `S A P E D V`); the rest of the rail, subtasks, comments and the
 * Activity tab grow onto this shell in the slices after it.
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
  canEdit,
  states,
  canApprove,
  canChangeVisibility,
  members,
}: {
  item: ResolvedItemDetail;
  /** "ACME-12" — the human key the header shows. */
  itemKey: string;
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
  /** Peek only: the link out to the full page. */
  fullPageHref?: string;
  /** `work_item:edit` — whether the description and the properties are editable here. */
  canEdit: boolean;
  /** The project's states, by rank, names already resolved. */
  states: ResolvedWorkflowState[];
  /** `work_item:approve` — whether a gated state is a legal target. */
  canApprove: boolean;
  /** `work_item:change_visibility` — whether the Visibility chip is a control (§10.4). */
  canChangeVisibility: boolean;
  /** The Assignee picker's rows — `getItemDetail`'s, so the full page has them too. */
  members: readonly { id: string; name: string }[];
}) {
  // The sheet owns the dialog title; the page owns the document's h1.
  const variant = surface === "page" ? "page" : "peek";
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
  // is hoisted only to keep the pair together.
  const parentKey = item.parent ? `${projectKey}-${item.parent.number}` : null;
  const parentHref = item.parent ? `/projects/${projectKey}/items/${item.parent.number}` : null;

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
  const fullPageLink =
    variant === "peek" && fullPageHref ? (
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
      {archivedNote || fullPageLink ? (
        <div className="flex flex-wrap items-center gap-2">
          {archivedNote}
          {fullPageLink}
        </div>
      ) : null}
    </>
  );

  // Read-first property list (UI.md §10.15 pattern 7). The six pickers
  // are UNCONDITIONAL siblings in rail order, each keyed by the ITEM:
  // `PeekShell` never remounts between items, so without the key an
  // optimistic value — or an open popover — would survive a navigation
  // from one task to the next; and the `?` overlay lists a scope's keys
  // in registration order, which is this DOM order (S A P E D V — the
  // order §2 rule 3 spells the keys in).
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
  const railLabel = "min-h-8 py-1.5 text-muted-foreground";
  const railText = "min-h-8 py-1.5";
  const railPicker = "flex min-h-8 items-center";
  const rail = (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm" data-testid="item-properties">
        <dt className={railLabel}>{t("properties.state")}</dt>
        <dd className={railPicker}>
          <StateField
            key={item.id}
            itemId={item.id}
            itemNumber={item.number}
            projectKey={projectKey}
            surface={surface}
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
            assigneeName={item.assigneeName}
            members={members}
            canEdit={canEdit}
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
        {item.milestone ? (
          <>
            <dt className={railLabel}>{t("properties.milestone")}</dt>
            <dd className={railText}>{item.milestone.name}</dd>
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
          <div className="px-4 pb-4">{rail}</div>
        </>
      ) : (
        <div className="pb-4">
          <SectionCard>
            <div className="flex flex-col gap-2 pb-4">{header}</div>
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
          projectKey={projectKey}
          doc={item.description}
          token={item.descriptionToken}
          visibility={item.visibility}
          editable={canEdit}
        />
      </div>

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
    </div>
  );
}
