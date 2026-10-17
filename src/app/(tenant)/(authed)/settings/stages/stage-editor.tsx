"use client";

import { ArrowDownIcon, ArrowUpIcon, CircleCheckIcon, FlagIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";

import { AutoForm } from "@/components/auto-form";
import { DataTable, Field, FormMessage, InlineEdit, RowActions, type RowAction } from "@/components/semantic";
import { Badge } from "@/components/ui/badge";
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
import { afterClosingLayers } from "@/lib/after-closing-layers";
import {
  MAX_STAGE_NAME_LENGTH,
  STAGE_KINDS,
  binHeir,
  canMove,
  defaultKindAllowed,
  defaultRefusal,
  removalRefusal,
  removalTargets,
  type StageKind,
  type StageLike,
} from "@/lib/stage-rules";

import {
  addStageAction,
  moveStageAction,
  removeStageAction,
  renameStageAction,
  setDefaultStageAction,
  setStageApprovalAction,
  type AddStageState,
  type StageScope,
} from "./actions";

/**
 * THE STAGE TABLE (slice 123, C99 (a)) — one component for the workspace
 * default (/settings/stages) and a project's own (/projects/[key]/stages),
 * so the two editors cannot drift. The menu offers only what
 * `@/lib/stage-rules` allows; the server re-checks every rule under its
 * lock, so a stale page is told why rather than obeyed.
 *
 * The NAME is a record property, so it is an <InlineEdit> in its own
 * <AutoForm> (MANDATE 1, the work-types precedent). A stage still wearing
 * Fortleva's default name shows it in the viewer's language; saving a name
 * makes it the workspace's own text from then on (DATA_MODEL §6.14).
 */

export type StageRowView = {
  id: string;
  /** Resolved for the viewer: a renamed stage's own text, else the default's translation. */
  name: string;
  category: StageKind;
  isDefault: boolean;
  requiresApproval: boolean;
  /** Tasks in it (board and archive, not the bin) — null on the workspace default, which holds none. */
  tasks: number | null;
  /** Deleted tasks in it (the bin) — they move with a removal too; null on the workspace default. */
  binned: number | null;
};

const asLike = (rows: readonly StageRowView[]): StageLike[] =>
  rows.map((r) => ({
    id: r.id,
    name: r.name,
    seedKey: null,
    category: r.category,
    isDefault: r.isDefault,
    requiresApproval: r.requiresApproval,
  }));

export function StageTable({
  scope,
  rows,
  canEdit,
}: {
  scope: StageScope;
  rows: StageRowView[];
  canEdit: boolean;
}) {
  const t = useTranslations("stageEditor");
  const tKind = useTranslations("states.stateCategory");
  const tCommon = useTranslations("common");
  const { run } = useRun();
  const [removing, setRemoving] = useState<StageRowView | null>(null);
  const like = asLike(rows);
  const project = scope.kind === "project";

  const actionsFor = (row: StageRowView): RowAction[] => {
    if (!canEdit) return [];
    const items: RowAction[] = [];
    if (canMove(like, row.id, "up")) {
      items.push({
        key: "up",
        label: t("menu.moveUp"),
        icon: ArrowUpIcon,
        onSelect: () => run(() => moveStageAction({ scope, id: row.id, dir: "up" })),
      });
    }
    if (canMove(like, row.id, "down")) {
      items.push({
        key: "down",
        label: t("menu.moveDown"),
        icon: ArrowDownIcon,
        onSelect: () => run(() => moveStageAction({ scope, id: row.id, dir: "down" })),
      });
    }
    // Only a Backlog or To do stage can carry the mark at all; one that
    // needs approval says why it cannot (`canStartHere`).
    if (!row.isDefault && defaultKindAllowed(row.category)) {
      const refused = defaultRefusal(row);
      items.push({
        key: "default",
        label: t("menu.makeDefault"),
        icon: FlagIcon,
        ...(refused
          ? { disabled: true, disabledReason: t("cannotStartHere") }
          : { onSelect: () => run(() => setDefaultStageAction({ scope, id: row.id })) }),
      });
    }
    // Where new tasks start is never gated, so its menu cannot turn the
    // gate on — it says why instead.
    items.push({
      key: "approval",
      label: row.requiresApproval ? t("menu.approvalOff") : t("menu.approvalOn"),
      icon: CircleCheckIcon,
      ...(row.isDefault && !row.requiresApproval
        ? { disabled: true, disabledReason: t("cannotGateStart") }
        : { onSelect: () => run(() => setStageApprovalAction({ scope, id: row.id, on: !row.requiresApproval })) }),
    });
    const binned = row.binned ?? 0;
    const refusal = removalRefusal(like, row.id, (row.tasks ?? 0) + binned, binned);
    const firstTarget = removalTargets(like, row.id)[0]?.id ?? null;
    // Where its deleted tasks go: with the first other stage of its kind,
    // else — the last Backlog stage — where new tasks start (C104).
    const binTo = binned > 0 ? rows.find((r) => r.id === (firstTarget ?? binHeir(like, row.id)?.id)) : undefined;
    if (refusal) {
      items.push({
        key: "remove",
        label: t("menu.remove"),
        icon: Trash2Icon,
        disabled: true,
        disabledReason: t(`cannotRemove.${refusal}` as "cannotRemove.STAGE_LAST_OF_KIND"),
      });
    } else if (project && (row.tasks ?? 0) > 0) {
      // Its tasks need a new stage: the dialog asks which. Not danger-toned
      // itself — the dialog's button is the act.
      items.push({
        key: "remove",
        label: t("menu.removeMove"),
        icon: Trash2Icon,
        onSelect: () => afterClosingLayers(() => setRemoving(row)),
      });
    } else {
      items.push({
        key: "remove",
        label: t("menu.remove"),
        icon: Trash2Icon,
        tone: "danger",
        confirm: !project
          ? t("removeConfirmWorkspace", { name: row.name })
          : binTo
            ? t("removeConfirmProjectBin", { name: row.name, target: binTo.name })
            : t("removeConfirmProject", { name: row.name }),
        // A project's empty stage still sends a pick when one exists: tasks
        // in the BIN point at it too, and the server moves them there.
        onSelect: () => run(() => removeStageAction({ scope, id: row.id, targetId: project ? firstTarget : null })),
      });
    }
    return items;
  };

  return (
    <>
      <DataTable flush scrollLabel={t("title")}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("columns.name")}</TableHead>
              <TableHead priority="medium" className="w-[16ch]">
                {t("columns.kind")}
              </TableHead>
              {project ? (
                <TableHead priority="low" className="w-[10ch] text-right">
                  {t("columns.tasks")}
                </TableHead>
              ) : null}
              <TableHead pinned className="text-right">
                <span className="sr-only">{tCommon("actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const actions = actionsFor(row);
              return (
                <TableRow key={row.id} data-testid="stage-row" data-kind={row.category}>
                  <TableCell className="font-medium">
                    <div className="flex min-w-0 items-center gap-2">
                      <div className="min-w-0 flex-1">
                        {canEdit ? (
                          <AutoForm action={renameStageAction}>
                            <input type="hidden" name="scope" value={scope.kind} />
                            {scope.kind === "project" ? <input type="hidden" name="projectId" value={scope.projectId} /> : null}
                            <input type="hidden" name="id" value={row.id} />
                            <InlineEdit
                              kind="text"
                              name="name"
                              value={row.name}
                              label={t("columns.name")}
                              placeholder={t("add.name")}
                              density="table"
                              inputProps={{ required: true, maxLength: MAX_STAGE_NAME_LENGTH }}
                            />
                          </AutoForm>
                        ) : (
                          <span className="truncate">{row.name}</span>
                        )}
                      </div>
                      {row.isDefault ? (
                        <Badge variant="outline" data-testid="stage-default">
                          {t("badge.default")}
                        </Badge>
                      ) : null}
                      {row.requiresApproval ? (
                        <Badge variant="outline" data-testid="stage-approval">
                          {t("badge.approval")}
                        </Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell priority="medium" className="text-muted-foreground">
                    {tKind(row.category)}
                  </TableCell>
                  {project ? (
                    <TableCell priority="low" className="text-right tabular-nums text-muted-foreground">
                      {row.tasks ?? 0}
                    </TableCell>
                  ) : null}
                  <TableCell pinned className="text-right">
                    {actions.length > 0 ? <RowActions label={tCommon("actionsFor", { name: row.name })} items={actions} /> : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </DataTable>
      {removing && scope.kind === "project" ? (
        <RemoveDialog
          scope={scope}
          row={removing}
          targets={rows.filter((r) => removalTargets(like, removing.id).some((x) => x.id === r.id))}
          onClose={() => setRemoving(null)}
        />
      ) : null}
    </>
  );
}

/**
 * Removing a stage that has tasks: they move to another stage of the SAME
 * kind (design §3.3), so nothing a client sees changes. The first one is
 * picked for you.
 */
function RemoveDialog({
  scope,
  row,
  targets,
  onClose,
}: {
  scope: StageScope;
  row: StageRowView;
  targets: StageRowView[];
  onClose: () => void;
}) {
  const t = useTranslations("stageEditor.removeDialog");
  const tCommon = useTranslations("common");
  const focusReturn = useFocusReturn();
  const { run, pending } = useRun();
  const [target, setTarget] = useState(targets[0]?.id ?? "");
  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent {...focusReturn} className="sm:max-w-md" data-testid="remove-stage-dialog">
        <DialogHeader>
          <DialogTitle>{t("title", { name: row.name })}</DialogTitle>
          <DialogDescription>{t("description", { count: row.tasks ?? 0 })}</DialogDescription>
        </DialogHeader>
        <Field htmlFor="remove-stage-target" label={t("target")}>
          <NativeSelect
            id="remove-stage-target"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            data-testid="remove-stage-target"
          >
            {targets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
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
            disabled={pending || target === ""}
            data-testid="remove-stage-confirm"
            onClick={() => run(() => removeStageAction({ scope, id: row.id, targetId: target }), onClose)}
          >
            {pending ? t("submitting") : t("submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The add form under the table: a name and the kind it counts as. */
export function AddStageForm({ scope }: { scope: StageScope }) {
  const t = useTranslations("stageEditor.add");
  const tKind = useTranslations("states.stateCategory");
  const [state, action, pending] = useActionState<AddStageState, FormData>(addStageAction, null);
  return (
    <form action={action} className="flex flex-col gap-4" data-testid="add-stage-form">
      <input type="hidden" name="scope" value={scope.kind} />
      {scope.kind === "project" ? <input type="hidden" name="projectId" value={scope.projectId} /> : null}
      <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2">
        <Field htmlFor="stage-name" label={t("name")} required>
          <Input id="stage-name" name="name" required maxLength={MAX_STAGE_NAME_LENGTH} data-testid="stage-name" />
        </Field>
        <Field htmlFor="stage-kind" label={t("kind")} hint={t("kindHelp")}>
          <NativeSelect id="stage-kind" name="kind" defaultValue="IN_PROGRESS" data-testid="stage-kind">
            {STAGE_KINDS.map((k) => (
              <option key={k} value={k}>
                {tKind(k)}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={pending} data-testid="stage-submit">
          <PlusIcon />
          {pending ? t("adding") : t("submit")}
        </Button>
        <FormMessage state={state} className="text-xs" />
      </div>
    </form>
  );
}
