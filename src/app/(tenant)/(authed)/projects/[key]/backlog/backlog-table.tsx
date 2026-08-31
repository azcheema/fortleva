"use client";

import { PaperclipIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import {
  DataTable,
  InlineEdit,
  PriorityIndicator,
  RowActions,
  VisibilityInlineEdit,
  visibilityRowCue,
  type RowAction,
} from "@/components/semantic";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { isoDateOf, parseEstimateMinutes } from "@/lib/duration";
import { PRIORITIES, type Priority } from "@/lib/enum-map";
import { durationInputText, formatDate, formatDuration, type DurationStyle } from "@/lib/format";
import type { FormResult } from "@/lib/server-actions";
import type { ItemList } from "@/modules/work";
import { cn } from "@/lib/utils";

import { canEnterState } from "../board/board-model";

import {
  assignItemAction,
  createItemAction,
  deleteItemAction,
  renameItemAction,
  setItemArchivedAction,
  setItemDueDateAction,
  setItemEstimateAction,
  setItemPriorityAction,
  setItemStateAction,
  setItemVisibilityAction,
} from "./actions";

/**
 * The minimal ordered task list (2W core slice). Every property is an
 * <InlineEdit> — text at rest, the control on click (founder mandate
 * 1); every mutation runs in a transition with a toast on failure so a
 * failed action never looks like a revert. The virtualised backlog,
 * filter chips, group-by and multiselect arrive with the 2W UX finish.
 */

const useRun = (locale: string) => {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<FormResult>, quiet = true) =>
    start(async () => {
      const r = await fn().catch(() => ({ ok: false as const, message: locale }));
      if (!r.ok) toast.error(r.message);
      else if (!quiet) toast.success(r.message);
      router.refresh();
    });
  return { pending, run };
};

export function BacklogTable({
  projectId,
  projectKey,
  locale,
  data,
  durationStyle,
  listHref,
}: {
  projectId: string;
  projectKey: string;
  locale: string;
  data: ItemList;
  /** The tenant's `ui.durationStyle` — REQUIRED (standing trap: state a
   * shared component must reflect is never a default). */
  durationStyle: DurationStyle;
  /** The list's own URL (archived toggle included) — the peek links
   * append `item=` to it so closing the peek lands back here. */
  listHref: string;
}) {
  const t = useTranslations("projects.backlog");
  const tCommon = useTranslations("common");
  const tPriority = useTranslations("states.priority");
  const { run } = useRun(t("actionFailed"));
  // The same one rule as every board surface (2W-R): TRIAGE and — for a
  // non-approver — a gated state are not offered; an item ALREADY in a
  // filtered state keeps it via the current-value fallback below, so it
  // stays displayable and reopenable.
  const stateOptions = data.states
    .filter((s) => !s.isHidden && canEnterState(s, data.caps.canApprove))
    .map((s) => ({ value: s.id, label: s.name }));
  const assigneeOptions = [
    { value: "", label: t("unassigned") },
    ...data.members.map((m) => ({ value: m.id, label: m.name })),
  ];
  // "" means NONE so the resting cell shows the muted placeholder, the
  // same convention as the assignee's "" = unassigned.
  const priorityOptions = PRIORITIES.map((p) => ({
    value: p === "NONE" ? "" : p,
    label: tPriority(p),
  }));

  return (
    <DataTable flush scrollLabel={t("scrollLabel")}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[10ch]">{t("columns.key")}</TableHead>
            <TableHead>{t("columns.title")}</TableHead>
            <TableHead priority="medium" className="w-[14ch]">{t("columns.state")}</TableHead>
            <TableHead priority="low" className="w-[13ch]">{t("columns.priority")}</TableHead>
            <TableHead priority="low" className="w-[16ch]">{t("columns.assignee")}</TableHead>
            <TableHead priority="low" className="w-[9ch] text-right">{t("columns.estimate")}</TableHead>
            <TableHead priority="low" className="w-[12ch]">{t("columns.due")}</TableHead>
            <TableHead priority="medium" className="w-[13ch]">{t("columns.visibility")}</TableHead>
            <TableHead className="w-0 text-right">
              <span className="sr-only">{t("columns.actions")}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.items.map((item) => {
            const done = item.stateCategory === "DONE" || item.stateCategory === "CANCELLED";
            const actions: RowAction[] = [
              item.archivedAt
                ? {
                    key: "restore",
                    label: t("actions.restore"),
                    onSelect: () => run(() => setItemArchivedAction(item.id, projectKey, false), false),
                  }
                : {
                    key: "archive",
                    label: t("actions.archive"),
                    onSelect: () => run(() => setItemArchivedAction(item.id, projectKey, true), false),
                  },
              ...(data.caps.canDelete
                ? [
                    {
                      key: "delete",
                      label: t("actions.delete"),
                      tone: "danger" as const,
                      confirm: t("actions.confirmDelete"),
                      onSelect: () => run(() => deleteItemAction(item.id, projectKey), false),
                    },
                  ]
                : []),
            ];
            return (
              <TableRow key={item.id} className={cn(visibilityRowCue(item.visibility))}>
                <TableCell className="num-id text-muted-foreground">
                  {/* The key IS the link to the item's peek (UI.md §5.4:
                      every peek is a link); the paperclip says the task
                      carries delivered files without opening it. */}
                  <span className="flex items-center gap-1.5">
                    <Link
                      className="underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      href={`${listHref}${listHref.includes("?") ? "&" : "?"}item=${projectKey}-${item.number}`}
                    >
                      {projectKey}-{item.number}
                    </Link>
                    {item.attachmentCount > 0 ? (
                      <span
                        data-testid="attachment-count"
                        className="num inline-flex items-center gap-0.5 text-xs"
                        title={t("attachments", { count: item.attachmentCount })}
                      >
                        <PaperclipIcon aria-hidden="true" className="size-3" />
                        <span className="sr-only">{t("attachments", { count: item.attachmentCount })}</span>
                        {item.attachmentCount}
                      </span>
                    ) : null}
                  </span>
                </TableCell>
                <TableCell className="min-w-56">
                  <InlineEdit
                    kind="text"
                    name="title"
                    density="table"
                    value={item.title}
                    label={t("titleLabel")}
                    placeholder={t("titleLabel")}
                    readOnly={!data.caps.canEdit}
                    hiddenInput={false}
                    display={
                      <span className={cn("text-sm", done ? "text-muted-foreground line-through" : "font-medium", item.archivedAt ? "opacity-100 text-muted-foreground" : "")}>
                        {item.title}
                      </span>
                    }
                    onCommit={(next) => {
                      if (next.trim() && next !== item.title)
                        run(() => renameItemAction(item.id, projectKey, next));
                    }}
                  />
                </TableCell>
                <TableCell priority="medium">
                  <InlineEdit
                    kind="select"
                    name="stateId"
                    density="table"
                    fit
                    value={item.stateId}
                    label={t("stateLabel")}
                    placeholder={t("stateLabel")}
                    options={stateOptions.some((o) => o.value === item.stateId)
                      ? stateOptions
                      : [{ value: item.stateId, label: item.stateName }, ...stateOptions]}
                    readOnly={!data.caps.canEdit}
                    hiddenInput={false}
                    display={<span className="text-sm">{item.stateName}</span>}
                    onCommit={(next) => {
                      if (next !== item.stateId) run(() => setItemStateAction(item.id, projectKey, next));
                    }}
                  />
                </TableCell>
                <TableCell priority="low" data-testid="backlog-priority">
                  <InlineEdit
                    kind="select"
                    name="priority"
                    density="table"
                    fit
                    value={item.priority === "NONE" ? "" : item.priority}
                    label={t("priorityLabel")}
                    placeholder={tPriority("NONE")}
                    options={priorityOptions}
                    readOnly={!data.caps.canEdit}
                    hiddenInput={false}
                    display={
                      item.priority !== "NONE" ? (
                        <PriorityIndicator value={item.priority as Priority} showLabel />
                      ) : null
                    }
                    onCommit={(next) => {
                      const chosen = next === "" ? "NONE" : next;
                      if (chosen !== item.priority)
                        run(() => setItemPriorityAction(item.id, projectKey, chosen));
                    }}
                  />
                </TableCell>
                <TableCell priority="low">
                  <InlineEdit
                    kind="select"
                    name="assigneeMemberId"
                    density="table"
                    fit
                    value={item.assigneeMemberId ?? ""}
                    label={t("assigneeLabel")}
                    placeholder={t("unassigned")}
                    options={assigneeOptions}
                    readOnly={!data.caps.canEdit}
                    hiddenInput={false}
                    display={
                      item.assigneeName ? (
                        <span className="text-sm">{item.assigneeName}</span>
                      ) : null
                    }
                    onCommit={(next) => {
                      if (next !== (item.assigneeMemberId ?? ""))
                        run(() => assignItemAction(item.id, projectKey, next));
                    }}
                  />
                </TableCell>
                <TableCell priority="low" className="text-right" data-testid="backlog-estimate">
                  <InlineEdit
                    kind="text"
                    name="estimate"
                    density="table"
                    fit
                    align="end"
                    // The edit seed is the locale-blind "1h 30m" the parser
                    // reads back in every style (format.ts round-trip rule).
                    value={item.estimateMinutes != null ? durationInputText(item.estimateMinutes * 60) : ""}
                    label={t("estimateLabel")}
                    placeholder={t("estimatePlaceholder")}
                    readOnly={!data.caps.canEdit}
                    hiddenInput={false}
                    display={
                      item.estimateMinutes != null ? (
                        <span className="num text-sm">{formatDuration(locale, item.estimateMinutes, durationStyle)}</span>
                      ) : null
                    }
                    onCommit={(next) => {
                      const minutes = parseEstimateMinutes(next);
                      if (minutes === undefined) {
                        toast.error(t("invalidEstimate"));
                        return;
                      }
                      if (minutes !== item.estimateMinutes)
                        run(() => setItemEstimateAction(item.id, projectKey, minutes));
                    }}
                  />
                </TableCell>
                <TableCell priority="low" data-testid="backlog-due">
                  <InlineEdit
                    kind="date"
                    name="dueDate"
                    density="table"
                    fit
                    value={item.targetDate ? isoDateOf(item.targetDate) : ""}
                    label={t("dueLabel")}
                    placeholder={t("duePlaceholder")}
                    readOnly={!data.caps.canEdit}
                    hiddenInput={false}
                    // The browser refuses what isIsoDate would (year range),
                    // so a typo year never sits in the cell looking saved.
                    inputProps={{ min: "1970-01-01", max: "2100-12-31" }}
                    display={
                      item.targetDate ? (
                        <span className="num text-sm">
                          {/* @db.Date = UTC midnight: format in UTC or the
                              day shifts west of UTC (review HIGH). */}
                          {formatDate(locale, item.targetDate, {
                            year: "numeric",
                            month: "short",
                            day: "numeric",
                            timeZone: "UTC",
                          })}
                        </span>
                      ) : null
                    }
                    onCommit={(next) => {
                      const current = item.targetDate ? isoDateOf(item.targetDate) : "";
                      if (next !== current)
                        run(() => setItemDueDateAction(item.id, projectKey, next === "" ? null : next));
                    }}
                  />
                </TableCell>
                <TableCell priority="medium">
                  <VisibilityInlineEdit
                    value={item.visibility}
                    density="table"
                    fit
                    readOnly={!data.caps.canChangeVisibility}
                    hiddenInput={false}
                    onCommit={(next) => {
                      if (next !== item.visibility)
                        run(() => setItemVisibilityAction(item.id, projectKey, next), false);
                    }}
                  />
                </TableCell>
                <TableCell className="text-right">
                  {data.caps.canEdit ? (
                    <RowActions
                      label={tCommon("actionsFor", { name: `${projectKey}-${item.number}` })}
                      items={actions}
                    />
                  ) : null}
                </TableCell>
              </TableRow>
            );
          })}
          {data.caps.canCreate ? (
            <CreateRow projectId={projectId} projectKey={projectKey} />
          ) : null}
        </TableBody>
      </Table>
    </DataTable>
  );
}

/** Title-only create (UI rules 2 + 3): AT REST this row is a button —
 * an always-mounted input in a resting row is the defect the founder
 * mandate exists to prevent (and the visual audit fails on it).
 * Activating swaps in the focused field; Enter creates and STAYS open
 * for the next title; Escape or an empty blur returns to rest.
 * Deliberately not a <form action> — we clear the value on success,
 * React never resets it mid-flight. */
function CreateRow({ projectId, projectKey }: { projectId: string; projectKey: string }) {
  const t = useTranslations("projects.backlog");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = () => {
    const value = title.trim();
    if (!value || pending) return;
    start(async () => {
      const r = await createItemAction(projectId, projectKey, value).catch(() => ({
        ok: false as const,
        message: t("actionFailed"),
      }));
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      setTitle("");
      inputRef.current?.focus();
      router.refresh();
    });
  };

  return (
    <TableRow id="new-task" className="scroll-mt-16">
      <TableCell className="text-muted-foreground" aria-hidden="true">
        <PlusIcon className="size-3.5" />
      </TableCell>
      <TableCell colSpan={8}>
        {editing ? (
          <Input
            ref={inputRef}
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape") {
                setTitle("");
                setEditing(false);
              }
            }}
            onBlur={() => {
              if (title.trim() === "" && !pending) setEditing(false);
            }}
            placeholder={t("createPlaceholder")}
            aria-label={t("createLabel")}
            disabled={pending}
            className="h-7 border-none bg-transparent px-1 shadow-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="flex h-7 w-full items-center rounded-md px-1 text-left text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {t("empty.action")}
          </button>
        )}
      </TableCell>
    </TableRow>
  );
}
