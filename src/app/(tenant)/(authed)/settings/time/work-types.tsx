"use client";

import { PlusIcon, TagIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useActionState, useTransition } from "react";
import { toast } from "sonner";

import { AutoForm } from "@/components/auto-form";
import { DataTable, Disclosure, EmptyState, Field, FormMessage, InlineEdit, RowActions, type RowAction } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import {
  createWorkTypeAction,
  setWorkTypeArchivedAction,
  updateWorkTypeAction,
  type TimeSettingsFormState,
} from "./actions";

/**
 * Work types (DATA_MODEL.md §6.15 D5): a tenant-editable lookup, never
 * rate-bearing. Name and default-billable are record properties, so
 * each is an <InlineEdit> inside its own <AutoForm> (MANDATE 1; one form
 * per cell — a form may not span cells). Archive is reversible and
 * lives in the row menu with restore under a disclosure (UI.md rule 12).
 */

export type WorkTypeRowView = {
  id: string;
  name: string;
  defaultBillable: boolean | null;
  archived: boolean;
};

type BillableChoice = "inherit" | "yes" | "no";
const choiceOf = (v: boolean | null): BillableChoice => (v === null ? "inherit" : v ? "yes" : "no");

export function WorkTypesTable({ rows, canManage }: { rows: WorkTypeRowView[]; canManage: boolean }) {
  const t = useTranslations("settings.time.workTypes");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const [, start] = useTransition();
  const live = rows.filter((r) => !r.archived);
  const archived = rows.filter((r) => r.archived);

  const billableOptions = [
    { value: "inherit", label: t("billable.inherit") },
    { value: "yes", label: t("billable.yes") },
    { value: "no", label: t("billable.no") },
  ];

  const setArchived = (row: WorkTypeRowView, value: boolean) =>
    start(async () => {
      const r = await setWorkTypeArchivedAction({ id: row.id, archived: value });
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
      router.refresh();
    });

  const actionsFor = (row: WorkTypeRowView): RowAction[] =>
    canManage
      ? row.archived
        ? [{ key: "restore", label: t("actions.restore"), onSelect: () => setArchived(row, false) }]
        : // Reversible (restore is one click away), so no question — RowActions
          // asks only for danger-toned items anyway (rowActionNeedsConfirm).
          [{ key: "archive", label: t("actions.archive"), onSelect: () => setArchived(row, true) }]
      : [];

  const table = (list: WorkTypeRowView[], label: string) => (
    <DataTable flush scrollLabel={label}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("columns.name")}</TableHead>
            <TableHead priority="medium" className="w-[22ch]">{t("columns.defaultBillable")}</TableHead>
            <TableHead className="text-right">
              <span className="sr-only">{tCommon("actions")}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {list.map((row) => {
            const actions = actionsFor(row);
            const editable = canManage && !row.archived;
            return (
              <TableRow key={row.id} data-testid="work-type-row" data-archived={row.archived ? "1" : "0"}>
                <TableCell className={row.archived ? "text-muted-foreground" : "font-medium"}>
                  {editable ? (
                    <AutoForm action={updateWorkTypeAction}>
                      <input type="hidden" name="id" value={row.id} />
                      <InlineEdit
                        kind="text"
                        name="name"
                        value={row.name}
                        label={t("editName")}
                        placeholder={t("add.name")}
                        density="table"
                        inputProps={{ required: true, maxLength: 80 }}
                      />
                    </AutoForm>
                  ) : (
                    row.name
                  )}
                </TableCell>
                <TableCell priority="medium" className="text-muted-foreground">
                  {editable ? (
                    <AutoForm action={updateWorkTypeAction}>
                      <input type="hidden" name="id" value={row.id} />
                      <InlineEdit
                        kind="select"
                        name="defaultBillable"
                        value={choiceOf(row.defaultBillable)}
                        options={billableOptions}
                        label={t("editBillable")}
                        placeholder={t("billable.inherit")}
                        density="table"
                      />
                    </AutoForm>
                  ) : (
                    t(`billable.${choiceOf(row.defaultBillable)}`)
                  )}
                </TableCell>
                <TableCell className="text-right">
                  {actions.length > 0 ? <RowActions label={tCommon("actionsFor", { name: row.name })} items={actions} /> : null}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </DataTable>
  );

  return (
    <>
      {live.length === 0 ? (
        <div className="px-4">
          {canManage ? (
            <EmptyState
              variant="empty"
              icon={TagIcon}
              title={t("empty")}
              body={t("emptyBody")}
              action={
                <Button asChild size="sm">
                  <Link href="#new-work-type">
                    <PlusIcon />
                    {t("add.submit")}
                  </Link>
                </Button>
              }
            />
          ) : (
            <p className="py-4 text-sm text-muted-foreground">{t("empty")}</p>
          )}
        </div>
      ) : (
        table(live, t("title"))
      )}
      {archived.length > 0 ? (
        <div className="border-t border-border px-4 py-2">
          <Disclosure label={t("archivedList", { count: archived.length })}>
            <div className="-mx-4 mt-2 border-t border-border">{table(archived, t("archivedList", { count: archived.length }))}</div>
          </Disclosure>
        </div>
      ) : null}
    </>
  );
}

export function CreateWorkTypeForm() {
  const t = useTranslations("settings.time.workTypes");
  const [state, action, pending] = useActionState<TimeSettingsFormState, FormData>(createWorkTypeAction, null);
  return (
    <form action={action} className="flex flex-col gap-4" data-testid="work-type-form">
      <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2">
        <Field htmlFor="work-type-name" label={t("add.name")} required>
          <Input id="work-type-name" name="name" required maxLength={80} data-testid="work-type-name" />
        </Field>
        <Field htmlFor="work-type-billable" label={t("add.defaultBillable")}>
          <NativeSelect id="work-type-billable" name="defaultBillable" defaultValue="inherit">
            <option value="inherit">{t("billable.inherit")}</option>
            <option value="yes">{t("billable.yes")}</option>
            <option value="no">{t("billable.no")}</option>
          </NativeSelect>
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={pending} data-testid="work-type-submit">
          <PlusIcon />
          {pending ? t("add.adding") : t("add.submit")}
        </Button>
        <FormMessage state={state} className="text-xs" />
      </div>
    </form>
  );
}
