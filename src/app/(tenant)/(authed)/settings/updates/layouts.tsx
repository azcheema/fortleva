"use client";

import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useLayoutEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { AutoForm } from "@/components/auto-form";
import { Callout, DataTable, Field, RowActions, type RowAction } from "@/components/semantic";
import { Pending } from "@/components/semantic/field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeCheckbox } from "@/components/ui/native-checkbox";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useFocusReturn } from "@/components/ui/use-focus-return";
import {
  UPDATE_CUSTOM_TITLE_MAX,
  UPDATE_METRIC_GROUPS,
  UPDATE_SECTION_KEYS,
  type UpdateFixedSectionKey,
  type UpdateMetricGroup,
  type UpdateMetricsInclude,
} from "@/modules/work/update-body";
import { LAYOUT_CUSTOM_MAX, LAYOUT_NAME_MAX, STANDARD_LAYOUT, type LayoutHeading } from "@/modules/work/update-layout";

import {
  deleteUpdateLayoutAction,
  makeDefaultUpdateLayoutAction,
  saveUpdateLayoutAction,
  setDefaultUpdateLayoutAction,
} from "./actions";

/**
 * THE WORKSPACE'S PROGRESS-UPDATE LAYOUTS (Phase 5 slice 105; founder decision
 * C73 (c), (d), (g)). The default select auto-saves (`AutoForm`); a layout is
 * a compound value — a name, its headings in order, its numbers — so it is
 * edited in ONE dialog with a Save button, as the composer saves a draft.
 *
 * KEYBOARD AND FOCUS (the design review's L9). The dialog opens from a menu
 * item or a button with no `DialogTrigger`, so `useFocusReturn` is spread on
 * its content and nothing inside has `autoFocus` (AGENTS.md's standing trap).
 * A button that would stop applying — Move up on the first row, Move down on
 * the last, "Add your own heading" at three — is `aria-disabled`, never
 * `disabled`, so it keeps the focus it may hold; and a move keeps focus on
 * the moved row's button, an added heading takes it into its name, a removed
 * one hands it to "Add" (a layout effect, after React has moved the rows).
 */

/** Next's redirect from a server action (a signed-out session) rejects the call — never a failure to report. */
const isRedirect = (e: unknown): boolean => {
  const digest = typeof e === "object" && e !== null ? (e as { digest?: unknown }).digest : undefined;
  return typeof digest === "string" && digest.startsWith("NEXT_REDIRECT");
};

export type LayoutRowView = {
  readonly id: string;
  readonly name: string;
  readonly sections: readonly LayoutHeading[];
  readonly metrics: UpdateMetricsInclude;
  readonly isDefault: boolean;
  readonly projectCount: number;
};

/** "New updates start from": Fortleva standard or one of the layouts. */
export function DefaultLayoutForm({ rows, canEdit }: { rows: readonly LayoutRowView[]; canEdit: boolean }) {
  const t = useTranslations("settings.updates.default");
  const current = rows.find((r) => r.isDefault);
  const currentId = current?.id ?? "";
  // CONTROLLED, never re-keyed (the code review's M1): a key that changed with
  // the default remounted the select under a keyboard member's focus after
  // every save — dropping it to <body> — and wiped the form's "Saved" tick.
  // It mirrors the server's default, adjusted during render when that changes
  // from elsewhere (a row's "Make default"): React's pattern for state derived
  // from a prop. `AutoForm` reads the form in the capture phase, when the
  // browser has already set the new value.
  const [value, setValue] = useState(currentId);
  const [seen, setSeen] = useState(currentId);
  if (seen !== currentId) {
    setSeen(currentId);
    setValue(currentId);
  }
  if (!canEdit) {
    return (
      <p className="text-sm">
        <span className="text-muted-foreground">{t("label")}: </span>
        {current?.name ?? t("standard")}
      </p>
    );
  }
  return (
    // A refused save puts the select back on the saved default, beside the
    // toast — never a page claiming a default the workspace does not have.
    <AutoForm action={setDefaultUpdateLayoutAction} onError={() => setValue(currentId)}>
      <Field htmlFor="u-default-layout" label={t("label")} hint={t("hint")}>
        <NativeSelect
          id="u-default-layout"
          name="defaultLayoutId"
          value={value}
          onChange={(e) => setValue(e.currentTarget.value)}
          data-testid="default-layout"
        >
          <option value="">{t("standard")}</option>
          {rows.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </NativeSelect>
      </Field>
    </AutoForm>
  );
}

export function LayoutsSection({ rows, canEdit }: { rows: readonly LayoutRowView[]; canEdit: boolean }) {
  const t = useTranslations("settings.updates.layouts");
  const tSections = useTranslations("updates.sections");
  const tInclude = useTranslations("projects.updates.composer.include");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const [, start] = useTransition();
  // null = closed; "new" = a new layout; otherwise the layout being edited.
  const [editing, setEditing] = useState<LayoutRowView | "new" | null>(null);

  const headingName = (h: LayoutHeading) => (h.key === "CUSTOM" ? h.title : tSections(h.key));
  const numbersOf = (m: UpdateMetricsInclude) => {
    const on = UPDATE_METRIC_GROUPS.filter((g) => m[g]);
    return on.length === 0 ? t("noNumbers") : on.map((g) => tInclude(g)).join(", ");
  };

  const tPage = useTranslations("settings.updates");
  // ONE "New layout" button, outside the empty-or-table switch (the code
  // review's L3): the dialog hands focus back to it, and it never unmounts
  // when the first layout appears or the last one goes. A deleted row's menu
  // does unmount, so a delete moves focus here first.
  const newRef = useRef<HTMLButtonElement>(null);
  const act = (fn: () => Promise<{ ok: boolean; message: string }>, onDone?: () => void) =>
    start(async () => {
      let r: { ok: boolean; message: string };
      try {
        r = await fn();
      } catch (e) {
        // A signed-out session's redirect REJECTS the call and then navigates
        // by itself — said nothing about (`reply-address-card.tsx`'s rule).
        if (isRedirect(e)) return;
        r = { ok: false, message: tPage("failed") };
      }
      if (r.ok) {
        toast.success(r.message);
        onDone?.();
      } else toast.error(r.message);
      router.refresh();
    });

  const actionsFor = (row: LayoutRowView): RowAction[] =>
    canEdit
      ? [
          { key: "edit", label: t("actions.edit"), onSelect: () => setEditing(row) },
          ...(row.isDefault
            ? []
            : [{ key: "default", label: t("actions.makeDefault"), onSelect: () => act(() => makeDefaultUpdateLayoutAction({ id: row.id })) }]),
          {
            key: "delete",
            label: t("actions.delete"),
            tone: "danger" as const,
            // The zero case is its own message (AGENTS.md: the parity test
            // reads a plural branch's first word as an argument).
            confirm:
              row.projectCount === 0
                ? t("deleteQuestion", { name: row.name })
                : t("deleteQuestionUsed", { name: row.name, count: row.projectCount }),
            onSelect: () => act(() => deleteUpdateLayoutAction({ id: row.id }), () => newRef.current?.focus()),
          },
        ]
      : [];

  return (
    <>
      {canEdit ? (
        <div className="flex justify-end border-b border-border px-4 py-3">
          <Button ref={newRef} size="sm" variant="outline" onClick={() => setEditing("new")} data-testid="new-layout">
            <PlusIcon />
            {t("new")}
          </Button>
        </div>
      ) : null}
      {rows.length === 0 ? (
        // Plain sentences, not an `empty` EmptyState (UI.md §5.8: that one
        // must carry its verb): the verb is the page's single "New layout"
        // button above — a second copy here would unmount under the focus the
        // dialog returns to it (the code review's L3) — and a reader who
        // cannot create sees what Fortleva does without one (the fix-pass
        // review's low; the subtasks entry's precedent).
        <div className="flex flex-col gap-1 px-4 py-4" data-testid="layouts-empty">
          <p className="text-sm font-medium text-foreground">{t("empty")}</p>
          <p className="text-sm text-muted-foreground">{t("emptyBody")}</p>
        </div>
      ) : (
        <>
          <DataTable flush scrollLabel={t("title")}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.name")}</TableHead>
                  <TableHead priority="medium">{t("columns.headings")}</TableHead>
                  <TableHead priority="low">{t("columns.numbers")}</TableHead>
                  <TableHead priority="medium" className="w-[12ch]">
                    {t("columns.projects")}
                  </TableHead>
                  <TableHead pinned className="text-right">
                    <span className="sr-only">{tCommon("actions")}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const actions = actionsFor(row);
                  return (
                    <TableRow key={row.id} data-testid="layout-row">
                      <TableCell className="font-medium">
                        <span className="inline-flex items-center gap-2">
                          {row.name}
                          {row.isDefault ? <Badge variant="neutral">{t("defaultBadge")}</Badge> : null}
                        </span>
                      </TableCell>
                      <TableCell priority="medium" className="text-muted-foreground">
                        {row.sections.map(headingName).join(" · ")}
                      </TableCell>
                      <TableCell priority="low" className="text-muted-foreground">
                        {numbersOf(row.metrics)}
                      </TableCell>
                      <TableCell priority="medium" className="text-muted-foreground tabular-nums">
                        {t("projectCount", { count: row.projectCount })}
                      </TableCell>
                      <TableCell pinned className="text-right">
                        {actions.length > 0 ? <RowActions label={tCommon("actionsFor", { name: row.name })} items={actions} /> : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </DataTable>
        </>
      )}
      {editing !== null ? (
        <LayoutDialog
          key={editing === "new" ? "new" : editing.id}
          initial={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}

type Entry = {
  readonly uid: string;
  readonly key: UpdateFixedSectionKey | "CUSTOM";
  readonly title: string;
  readonly included: boolean;
};

let uidSeq = 0;
const nextUid = () => `h${++uidSeq}`;

/** The dialog's rows: the layout's headings in order, then the fixed ones it leaves out (unticked). */
function entriesOf(initial: LayoutRowView | null): Entry[] {
  const sections = initial?.sections ?? STANDARD_LAYOUT.sections;
  const out: Entry[] = sections.map((h) => ({
    uid: nextUid(),
    key: h.key,
    title: h.key === "CUSTOM" ? h.title : "",
    included: true,
  }));
  for (const key of UPDATE_SECTION_KEYS) {
    if (!sections.some((h) => h.key === key)) out.push({ uid: nextUid(), key, title: "", included: false });
  }
  return out;
}

function LayoutDialog({ initial, onClose }: { initial: LayoutRowView | null; onClose: () => void }) {
  const t = useTranslations("settings.updates.dialog");
  const tPage = useTranslations("settings.updates");
  const tSections = useTranslations("updates.sections");
  const tInclude = useTranslations("projects.updates.composer.include");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const focusReturn = useFocusReturn();
  const [pending, start] = useTransition();
  const [name, setName] = useState(initial?.name ?? "");
  const [entries, setEntries] = useState<Entry[]>(() => entriesOf(initial));
  const [metrics, setMetrics] = useState<UpdateMetricsInclude>(initial?.metrics ?? STANDARD_LAYOUT.metrics);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  // Where focus goes once React has laid the rows out again: a row's control
  // by `data-focus`, or the Add button. A ref, read after the rows change —
  // every verb that sets it also changes them.
  const focusNext = useRef<string | null>(null);

  useLayoutEffect(() => {
    const target = focusNext.current;
    if (target === null) return;
    focusNext.current = null;
    if (target === "add") addRef.current?.focus();
    else listRef.current?.querySelector<HTMLElement>(`[data-focus="${target}"]`)?.focus();
  }, [entries]);

  const customs = entries.filter((e) => e.key === "CUSTOM").length;
  const labelOf = (e: Entry) => (e.key === "CUSTOM" ? e.title.trim() || t("untitled") : tSections(e.key));

  const move = (uid: string, dir: -1 | 1) => {
    const i = entries.findIndex((e) => e.uid === uid);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= entries.length) return;
    const next = [...entries];
    [next[i], next[j]] = [next[j]!, next[i]!];
    focusNext.current = `${uid}:${dir < 0 ? "up" : "down"}`;
    setEntries(next);
  };
  const patch = (uid: string, change: Partial<Entry>) =>
    setEntries((prev) => prev.map((e) => (e.uid === uid ? { ...e, ...change } : e)));
  const add = () => {
    if (customs >= LAYOUT_CUSTOM_MAX) return;
    const uid = nextUid();
    focusNext.current = `${uid}:title`;
    setEntries((prev) => [...prev, { uid, key: "CUSTOM", title: "", included: true }]);
  };
  const remove = (uid: string) => {
    focusNext.current = "add";
    setEntries((prev) => prev.filter((e) => e.uid !== uid));
  };

  const save = () => {
    if (pending) return;
    const trimmed = name.trim();
    if (trimmed === "") return setError(t("nameRequired"));
    const own = entries.filter((e) => e.key === "CUSTOM");
    if (own.some((e) => e.title.trim() === "")) return setError(t("titleRequired"));
    const folded = own.map((e) => e.title.trim().toLocaleLowerCase());
    if (new Set(folded).size !== folded.length) return setError(t("titleTwice"));
    setError(null);
    const sections = entries
      .filter((e) => e.included)
      .map((e) => (e.key === "CUSTOM" ? { key: "CUSTOM", title: e.title.trim() } : { key: e.key }));
    start(async () => {
      let r: Awaited<ReturnType<typeof saveUpdateLayoutAction>>;
      try {
        r = await saveUpdateLayoutAction({ id: initial?.id ?? null, name: trimmed, sections, metrics });
      } catch (e) {
        if (isRedirect(e)) return; // signed out: the app navigates by itself
        r = { ok: false, message: tPage("failed") };
      }
      if (!r.ok) {
        // A refusal keeps the dialog and every field as typed (AGENTS.md: a
        // failure must never look like a revert).
        setError(r.message);
        return;
      }
      toast.success(initial ? tPage("saved") : tPage("created"));
      onClose();
      router.refresh();
    });
  };

  return (
    <Dialog open onOpenChange={(open) => (!open && !pending ? onClose() : undefined)}>
      <DialogContent {...focusReturn} className="flex max-h-svh flex-col sm:max-w-lg" data-testid="layout-dialog">
        <DialogHeader>
          <DialogTitle>{initial ? t("editTitle") : t("newTitle")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto pr-1">
          <Field htmlFor="layout-name" label={t("name")} required>
            <Input
              id="layout-name"
              value={name}
              maxLength={LAYOUT_NAME_MAX}
              placeholder={t("namePlaceholder")}
              onChange={(e) => setName(e.target.value)}
              data-testid="layout-name"
            />
          </Field>

          <div className="flex flex-col gap-2">
            <p id="layout-headings-label" className="text-sm font-medium text-foreground">
              {t("headings")}
            </p>
            <ol ref={listRef} aria-labelledby="layout-headings-label" className="flex flex-col gap-1.5">
              {entries.map((e, i) => {
                const heading = labelOf(e);
                const first = i === 0;
                const last = i === entries.length - 1;
                // "Your heading 2": each title field named by its place among
                // the workspace's own (the code review's nit).
                const ownNumber = entries.slice(0, i + 1).filter((x) => x.key === "CUSTOM").length;
                return (
                  <li key={e.uid} className="flex items-center gap-2 rounded-md border border-border px-2 py-1" data-testid="layout-heading">
                    {e.key === "CUSTOM" ? (
                      <Input
                        value={e.title}
                        maxLength={UPDATE_CUSTOM_TITLE_MAX}
                        placeholder={t("ownHeadingPlaceholder")}
                        aria-label={t("ownHeadingNumbered", { n: ownNumber })}
                        onChange={(ev) => patch(e.uid, { title: ev.target.value })}
                        data-focus={`${e.uid}:title`}
                        data-testid="layout-own-heading"
                        className="h-7 min-w-0 flex-1"
                      />
                    ) : (
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <NativeCheckbox
                          id={`layout-${e.uid}`}
                          checked={e.included}
                          // DONE is always in a layout (C73 (g)): "What got
                          // done" fills it. Never focused, so disabling it
                          // drops no focus.
                          disabled={e.key === "DONE"}
                          onChange={(ev) => patch(e.uid, { included: ev.currentTarget.checked })}
                          data-testid={`layout-include-${e.key}`}
                        />
                        <Label htmlFor={`layout-${e.uid}`} className={e.included ? undefined : "text-muted-foreground"}>
                          {heading}
                        </Label>
                        {e.key === "DONE" ? <span className="truncate text-xs text-muted-foreground">{t("doneAlways")}</span> : null}
                      </div>
                    )}
                    <div className="flex shrink-0 items-center gap-0.5">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={t("moveUp", { heading })}
                        aria-disabled={first || undefined}
                        onClick={() => (first ? undefined : move(e.uid, -1))}
                        data-focus={`${e.uid}:up`}
                      >
                        <ArrowUpIcon />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={t("moveDown", { heading })}
                        aria-disabled={last || undefined}
                        onClick={() => (last ? undefined : move(e.uid, 1))}
                        data-focus={`${e.uid}:down`}
                      >
                        <ArrowDownIcon />
                      </Button>
                      {e.key === "CUSTOM" ? (
                        <Button type="button" variant="ghost" size="icon-xs" aria-label={t("remove", { heading })} onClick={() => remove(e.uid)}>
                          <XIcon />
                        </Button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ol>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                ref={addRef}
                type="button"
                variant="outline"
                size="sm"
                aria-disabled={customs >= LAYOUT_CUSTOM_MAX || undefined}
                aria-describedby="layout-add-limit"
                onClick={add}
                data-testid="layout-add-heading"
              >
                <PlusIcon />
                {t("add")}
              </Button>
              <span id="layout-add-limit" className="text-xs text-muted-foreground">
                {t("addLimit", { max: LAYOUT_CUSTOM_MAX })}
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-sm font-medium text-foreground">{t("numbers")}</p>
            <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
              {UPDATE_METRIC_GROUPS.map((group: UpdateMetricGroup) => (
                <label key={group} className="flex items-center gap-2">
                  <NativeCheckbox
                    checked={metrics[group]}
                    onChange={(ev) => setMetrics({ ...metrics, [group]: ev.currentTarget.checked })}
                    data-testid={`layout-number-${group}`}
                  />
                  {tInclude(group)}
                </label>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{t("numbersHint")}</p>
          </div>
        </div>
        {error ? (
          <Callout tone="danger" role="alert">
            <span data-testid="layout-error">{error}</span>
          </Callout>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={() => (pending ? undefined : onClose())}>
            {tCommon("cancel")}
          </Button>
          <Button type="button" size="sm" aria-disabled={pending || undefined} onClick={save} data-testid="layout-save">
            {pending ? <Pending label={tCommon("loading")} /> : initial ? t("save") : t("create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
