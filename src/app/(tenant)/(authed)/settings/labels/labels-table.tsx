"use client";

import { CombineIcon, PlusIcon, TagIcon, Trash2Icon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";

import { AutoForm } from "@/components/auto-form";
import { DataTable, EmptyState, Field, FormMessage, InlineEdit, RowActions, type RowAction } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useFocusReturn } from "@/components/ui/use-focus-return";
import { useRun } from "@/components/use-run";
import { LabelDot } from "@/components/work-view/label-dot";
import { afterClosingLayers } from "@/lib/after-closing-layers";
import { LABEL_COLORS } from "@/lib/label-colors";
import { MAX_LABEL_NAME_LENGTH } from "@/lib/work-view";

import { createLabelAction, deleteLabelAction, mergeLabelAction, updateLabelAction, type LabelFormState } from "./actions";

/**
 * The workspace's labels (slice 123, C99 (b)): the name and the colour are
 * record properties, each an <InlineEdit> in its own <AutoForm> (MANDATE 1);
 * Merge and Delete live in the row menu. Delete is danger-toned and asks
 * (it comes off every task); Merge opens a dialog that asks which label
 * survives, and its button is the act.
 */

export type LabelRowView = { id: string; name: string; color: string | null; tasks: number };

export function LabelsTable({ rows }: { rows: LabelRowView[] }) {
  const t = useTranslations("settings.labels");
  const tColor = useTranslations("labelColors");
  const tCommon = useTranslations("common");
  const { run } = useRun();
  const [merging, setMerging] = useState<LabelRowView | null>(null);

  const colorOptions = [
    { value: "", label: tColor("none") },
    ...LABEL_COLORS.map((c) => ({ value: c, label: tColor(c) })),
  ];

  if (rows.length === 0) {
    return (
      <div className="px-4">
        <EmptyState
          variant="empty"
          icon={TagIcon}
          title={t("empty")}
          body={t("emptyBody")}
          action={
            <Button asChild size="sm">
              <Link href="#new-label">
                <PlusIcon />
                {t("add.submit")}
              </Link>
            </Button>
          }
        />
      </div>
    );
  }

  const actionsFor = (row: LabelRowView): RowAction[] => [
    ...(rows.length > 1
      ? [
          {
            key: "merge",
            label: t("menu.merge"),
            icon: CombineIcon,
            onSelect: () => afterClosingLayers(() => setMerging(row)),
          } satisfies RowAction,
        ]
      : []),
    {
      key: "delete",
      label: t("menu.delete"),
      icon: Trash2Icon,
      tone: "danger",
      confirm: t("deleteConfirm", { name: row.name, count: row.tasks }),
      onSelect: () => run(() => deleteLabelAction({ id: row.id })),
    },
  ];

  return (
    <>
      <DataTable flush scrollLabel={t("title")}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("columns.name")}</TableHead>
              <TableHead priority="medium" className="w-[18ch]">
                {t("columns.color")}
              </TableHead>
              <TableHead priority="low" className="w-[10ch] text-right">
                {t("columns.tasks")}
              </TableHead>
              <TableHead pinned className="text-right">
                <span className="sr-only">{tCommon("actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id} data-testid="label-row" data-color={row.color ?? ""}>
                <TableCell className="font-medium">
                  <div className="flex min-w-0 items-center gap-2">
                    <LabelDot color={row.color} />
                    <div className="min-w-0 flex-1">
                      <AutoForm action={updateLabelAction}>
                        <input type="hidden" name="id" value={row.id} />
                        <InlineEdit
                          kind="text"
                          name="name"
                          value={row.name}
                          label={t("columns.name")}
                          placeholder={t("add.name")}
                          density="table"
                          inputProps={{ required: true, maxLength: MAX_LABEL_NAME_LENGTH }}
                        />
                      </AutoForm>
                    </div>
                  </div>
                </TableCell>
                <TableCell priority="medium" className="text-muted-foreground">
                  <AutoForm action={updateLabelAction}>
                    <input type="hidden" name="id" value={row.id} />
                    <InlineEdit
                      kind="select"
                      name="color"
                      value={row.color ?? ""}
                      options={colorOptions}
                      label={t("columns.color")}
                      placeholder={tColor("none")}
                      density="table"
                    />
                  </AutoForm>
                </TableCell>
                <TableCell priority="low" className="text-right tabular-nums text-muted-foreground">
                  {row.tasks}
                </TableCell>
                <TableCell pinned className="text-right">
                  <RowActions label={tCommon("actionsFor", { name: row.name })} items={actionsFor(row)} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DataTable>
      {merging ? (
        <MergeDialog from={merging} others={rows.filter((r) => r.id !== merging.id)} onClose={() => setMerging(null)} />
      ) : null}
    </>
  );
}

/** Merge one label into another: the tasks wearing it wear the other, and it is gone. */
function MergeDialog({ from, others, onClose }: { from: LabelRowView; others: LabelRowView[]; onClose: () => void }) {
  const t = useTranslations("settings.labels.mergeDialog");
  const tCommon = useTranslations("common");
  const focusReturn = useFocusReturn();
  const { run, pending } = useRun();
  const [into, setInto] = useState(others[0]?.id ?? "");
  const intoName = others.find((o) => o.id === into)?.name ?? "";
  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent {...focusReturn} className="sm:max-w-md" data-testid="merge-label-dialog">
        <DialogHeader>
          <DialogTitle>{t("title", { name: from.name })}</DialogTitle>
          <DialogDescription>{t("description", { name: from.name, count: from.tasks })}</DialogDescription>
        </DialogHeader>
        <Field htmlFor="merge-label-into" label={t("into")}>
          <NativeSelect id="merge-label-into" value={into} onChange={(e) => setInto(e.target.value)} data-testid="merge-label-into">
            {others.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
            {tCommon("cancel")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={pending || into === ""}
            data-testid="merge-label-confirm"
            onClick={() => run(() => mergeLabelAction({ fromId: from.id, intoId: into }), onClose)}
          >
            {pending ? t("submitting") : t("submit", { name: intoName })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The create form under the table. */
export function CreateLabelForm() {
  const t = useTranslations("settings.labels.add");
  const tColor = useTranslations("labelColors");
  const [state, action, pending] = useActionState<LabelFormState, FormData>(createLabelAction, null);
  return (
    <form action={action} className="flex flex-col gap-4" data-testid="label-form">
      <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2">
        <Field htmlFor="label-name" label={t("name")} required>
          <Input id="label-name" name="name" required maxLength={MAX_LABEL_NAME_LENGTH} data-testid="label-name" />
        </Field>
        <Field htmlFor="label-color" label={t("color")}>
          <NativeSelect id="label-color" name="color" defaultValue="" data-testid="label-color">
            <option value="">{tColor("none")}</option>
            {LABEL_COLORS.map((c) => (
              <option key={c} value={c}>
                {tColor(c)}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={pending} data-testid="label-submit">
          <PlusIcon />
          {pending ? t("adding") : t("submit")}
        </Button>
        <FormMessage state={state} className="text-xs" />
      </div>
    </form>
  );
}
