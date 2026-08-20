"use client";

import { PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import {
  DataTable,
  InlineEdit,
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
import { formatDurationHm } from "@/lib/format";
import type { FormResult } from "@/lib/server-actions";
import type { ItemList } from "@/modules/work";
import { cn } from "@/lib/utils";

import {
  assignItemAction,
  createItemAction,
  deleteItemAction,
  renameItemAction,
  setItemArchivedAction,
  setItemEstimateAction,
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

/** Hours in, minutes out: accepts "2", "1,5", "1.5". */
const parseHours = (raw: string): number | null | undefined => {
  const s = raw.trim();
  if (s === "") return null;
  const n = Number(s.replace(",", "."));
  if (!Number.isFinite(n) || n < 0 || n > 10_000) return undefined;
  return Math.round(n * 60);
};

export function BacklogTable({
  projectId,
  projectKey,
  locale,
  data,
}: {
  projectId: string;
  projectKey: string;
  locale: string;
  data: ItemList;
}) {
  const t = useTranslations("projects.backlog");
  const tCommon = useTranslations("common");
  const { run } = useRun(t("actionFailed"));
  const stateOptions = data.states
    .filter((s) => !s.isHidden)
    .map((s) => ({ value: s.id, label: s.name }));
  const assigneeOptions = [
    { value: "", label: t("unassigned") },
    ...data.members.map((m) => ({ value: m.id, label: m.name })),
  ];

  return (
    <DataTable flush scrollLabel={t("scrollLabel")}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[10ch]">{t("columns.key")}</TableHead>
            <TableHead>{t("columns.title")}</TableHead>
            <TableHead priority="medium" className="w-[14ch]">{t("columns.state")}</TableHead>
            <TableHead priority="low" className="w-[16ch]">{t("columns.assignee")}</TableHead>
            <TableHead priority="low" className="w-[9ch] text-right">{t("columns.estimate")}</TableHead>
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
                  {projectKey}-{item.number}
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
                <TableCell>
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
                <TableCell>
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
                <TableCell className="text-right">
                  <InlineEdit
                    kind="text"
                    name="estimateHours"
                    density="table"
                    fit
                    align="end"
                    value={item.estimateMinutes != null ? String(item.estimateMinutes / 60) : ""}
                    label={t("estimateLabel")}
                    placeholder={t("estimatePlaceholder")}
                    readOnly={!data.caps.canEdit}
                    hiddenInput={false}
                    display={
                      item.estimateMinutes != null ? (
                        <span className="num text-sm">{formatDurationHm(locale, item.estimateMinutes)}</span>
                      ) : null
                    }
                    onCommit={(next) => {
                      const minutes = parseHours(next);
                      if (minutes === undefined) {
                        toast.error(t("invalidEstimate"));
                        return;
                      }
                      if (minutes !== item.estimateMinutes)
                        run(() => setItemEstimateAction(item.id, projectKey, minutes));
                    }}
                  />
                </TableCell>
                <TableCell>
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
      <TableCell colSpan={6}>
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
