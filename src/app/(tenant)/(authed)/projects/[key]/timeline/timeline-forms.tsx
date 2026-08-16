"use client";

import { ArrowDownIcon, ArrowUpIcon, MoreHorizontalIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useActionState, useEffect, useRef, useTransition } from "react";
import { toast } from "sonner";

import { AutoForm } from "@/components/auto-form";
import { FormMessage } from "@/components/form-message";
import { InlineConfirm } from "@/components/inline-confirm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { VisibilityBadge } from "@/components/visibility-badge";
import { isoDate, type FormResult } from "@/lib/server-actions";
import type { MilestoneRow, VersionRow } from "@/projects/service";

import {
  createMilestoneAction,
  createVersionAction,
  reorderMilestoneAction,
  setMilestoneStatusAction,
  shipVersionAction,
  updateMilestoneAction,
  updateVersionAction,
} from "../actions";

const useRun = () => {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<FormResult>, quiet = false) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) toast.error(r.message);
      else if (!quiet) toast.success(r.message);
      router.refresh();
    });
  return { pending, run };
};

// ── Milestones ──────────────────────────────────────────────────────

/**
 * One milestone row: name/due/visibility auto-save (manage_versions),
 * status actions, and the keyboard twin of drag — up/down arrows plus a
 * "Move to…" menu (UI.md §7.1). Rank is never rendered.
 */
export function MilestoneItem({
  projectKey,
  milestone,
  index,
  siblings,
  editable,
}: {
  projectKey: string;
  milestone: MilestoneRow;
  index: number;
  /** All milestones in display order (ids only used for anchors). */
  siblings: { id: string; name: string }[];
  editable: boolean;
}) {
  const t = useTranslations("projects.timeline");
  const format = useFormatter();
  const { pending, run } = useRun();
  const m = milestone;
  const first = index === 0;
  const last = index === siblings.length - 1;
  const move = (target: Parameters<typeof reorderMilestoneAction>[2]) =>
    run(() => reorderMilestoneAction(m.id, projectKey, target), true);
  const setStatus = (status: string) => run(() => setMilestoneStatusAction(m.id, projectKey, status), true);
  const done = m.status === "DONE";
  const cancelled = m.status === "CANCELLED";

  const meta = (
    <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <Badge variant={done ? "default" : "outline"}>{t(`statuses.${m.status}`)}</Badge>
      <VisibilityBadge visibility={m.visibility} />
      {done && m.completedAt
        ? t("completedOn", { date: format.dateTime(m.completedAt, { dateStyle: "medium" }) })
        : m.dueAt
          ? t("dueOn", { date: format.dateTime(m.dueAt, { dateStyle: "medium" }) })
          : null}
    </span>
  );

  if (!editable) {
    return (
      <li className="flex flex-col gap-1 px-3 py-2">
        <span className={done || cancelled ? "text-muted-foreground line-through" : "font-medium"}>{m.name}</span>
        {meta}
      </li>
    );
  }

  return (
    <li className="flex items-start gap-2 px-3 py-2">
      <div className="flex flex-col">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t("moveUp")}
          disabled={first || pending}
          onClick={() => move({ beforeId: siblings[index - 1]!.id })}
        >
          <ArrowUpIcon />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t("moveDown")}
          disabled={last || pending}
          onClick={() => move({ afterId: siblings[index + 1]!.id })}
        >
          <ArrowDownIcon />
        </Button>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <AutoForm action={updateMilestoneAction} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_9rem_11rem]">
          <input type="hidden" name="milestoneId" value={m.id} />
          <input type="hidden" name="projectKey" value={projectKey} />
          <Input
            name="name"
            defaultValue={m.name}
            required
            aria-label={t("milestoneName")}
            className={done || cancelled ? "line-through" : ""}
          />
          <Input name="dueAt" type="date" defaultValue={isoDate(m.dueAt)} aria-label={t("due")} />
          <VisibilityNativeSelect value={m.visibility} />
        </AutoForm>
        {meta}
      </div>
      <div className="flex items-center gap-1">
        {m.status === "PLANNED" || m.status === "PAUSED" ? (
          <Button type="button" variant="outline" size="xs" disabled={pending} onClick={() => setStatus("IN_PROGRESS")}>
            {t("start")}
          </Button>
        ) : null}
        {!done && !cancelled ? (
          <Button type="button" variant="outline" size="xs" disabled={pending} onClick={() => setStatus("DONE")}>
            {t("complete")}
          </Button>
        ) : (
          <Button type="button" variant="ghost" size="xs" disabled={pending} onClick={() => setStatus("PLANNED")}>
            {t("reopen")}
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon-xs" aria-label={t("more")} disabled={pending}>
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem disabled={first} onSelect={() => move({ position: "top" })}>
              {t("moveTop")}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={last} onSelect={() => move({ position: "bottom" })}>
              {t("moveBottom")}
            </DropdownMenuItem>
            {m.status === "IN_PROGRESS" ? (
              <DropdownMenuItem onSelect={() => setStatus("PAUSED")}>{t("statuses.PAUSED")}</DropdownMenuItem>
            ) : null}
            {!cancelled ? (
              <DropdownMenuItem variant="destructive" onSelect={() => setStatus("CANCELLED")}>
                {t("cancel")}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

function VisibilityNativeSelect({ value, id }: { value: "INTERNAL" | "CLIENT_VISIBLE"; id?: string }) {
  const t = useTranslations("visibility");
  return (
    <NativeSelect id={id} name="visibility" defaultValue={value} aria-label={t("label")}>
      <option value="INTERNAL">{t("internal")}</option>
      <option value="CLIENT_VISIBLE">{t("clientVisible")}</option>
    </NativeSelect>
  );
}

/** Title-only creation (UI.md rule 2): name, Enter adds the next; due/visibility optional. */
export function CreateMilestoneForm({ projectId, projectKey }: { projectId: string; projectKey: string }) {
  const t = useTranslations("projects.timeline");
  const tVis = useTranslations("visibility");
  const [state, action, pending] = useActionState<FormResult | null, FormData>(createMilestoneAction, null);
  const formRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (state?.ok) {
      formRef.current?.reset();
      nameRef.current?.focus();
    }
  }, [state]);
  return (
    <form ref={formRef} action={action} className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_9rem_11rem_auto]">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="projectKey" value={projectKey} />
      <div className="flex flex-col gap-1">
        <Label htmlFor="ms-name" className="text-xs text-muted-foreground">
          {t("milestoneName")}
        </Label>
        <Input id="ms-name" ref={nameRef} name="name" required placeholder={t("milestonePlaceholder")} disabled={pending} />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="ms-due" className="text-xs text-muted-foreground">
          {t("due")}
        </Label>
        <Input id="ms-due" name="dueAt" type="date" disabled={pending} />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="ms-vis" className="text-xs text-muted-foreground">
          {tVis("label")}
        </Label>
        <VisibilityNativeSelect id="ms-vis" value="INTERNAL" />
      </div>
      <Button type="submit" size="sm" disabled={pending}>
        {t("addMilestone")}
      </Button>
      {state && !state.ok ? <FormMessage state={state} className="sm:col-span-4" /> : null}
    </form>
  );
}

// ── Versions ────────────────────────────────────────────────────────

export function VersionItem({
  projectKey,
  version,
  editable,
}: {
  projectKey: string;
  version: VersionRow;
  editable: boolean;
}) {
  const t = useTranslations("projects.timeline");
  const format = useFormatter();
  const { pending, run } = useRun();
  const v = version;
  const shipped = v.status === "SHIPPED";
  const badge = shipped ? (
    <Badge>{t("shipped", { date: v.shippedAt ? format.dateTime(v.shippedAt, { dateStyle: "medium" }) : "" })}</Badge>
  ) : (
    <Badge variant="outline">{t("draft")}</Badge>
  );

  if (!editable) {
    return (
      <li className="flex flex-col gap-1 px-3 py-2">
        <span className="flex items-center gap-2">
          <span className="font-mono text-sm font-medium">{v.version}</span>
          {v.title ? <span>{v.title}</span> : null}
          {badge}
        </span>
        {v.releaseNotes ? <p className="text-sm whitespace-pre-wrap text-muted-foreground">{v.releaseNotes}</p> : null}
      </li>
    );
  }

  return (
    <li className="flex items-start gap-2 px-3 py-2">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <AutoForm action={updateVersionAction} className="grid grid-cols-1 gap-2 sm:grid-cols-[8rem_1fr]">
          <input type="hidden" name="versionId" value={v.id} />
          <input type="hidden" name="projectKey" value={projectKey} />
          {shipped ? (
            <span className="flex h-8 items-center font-mono text-sm font-medium">{v.version}</span>
          ) : (
            <Input name="version" defaultValue={v.version} required aria-label={t("version")} className="font-mono" />
          )}
          <Input name="title" defaultValue={v.title ?? ""} aria-label={t("versionTitle")} placeholder={t("versionTitle")} />
          <Textarea
            name="releaseNotes"
            defaultValue={v.releaseNotes ?? ""}
            rows={2}
            aria-label={t("releaseNotes")}
            placeholder={t("releaseNotes")}
            className="sm:col-span-2"
          />
        </AutoForm>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">{badge}</span>
      </div>
      {!shipped ? (
        <InlineConfirm
          label={t("ship")}
          question={t("shipConfirm")}
          variant="default"
          pending={pending}
          onConfirm={() => run(() => shipVersionAction(v.id, projectKey, v.version))}
        />
      ) : null}
    </li>
  );
}

export function CreateVersionForm({ projectId, projectKey }: { projectId: string; projectKey: string }) {
  const t = useTranslations("projects.timeline");
  const [state, action, pending] = useActionState<FormResult | null, FormData>(createVersionAction, null);
  const formRef = useRef<HTMLFormElement>(null);
  const versionRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (state?.ok) {
      formRef.current?.reset();
      versionRef.current?.focus();
    }
  }, [state]);
  return (
    <form ref={formRef} action={action} className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[8rem_1fr_auto]">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="projectKey" value={projectKey} />
      <div className="flex flex-col gap-1">
        <Label htmlFor="v-version" className="text-xs text-muted-foreground">
          {t("version")}
        </Label>
        <Input
          id="v-version"
          ref={versionRef}
          name="version"
          required
          maxLength={64}
          placeholder={t("versionPlaceholder")}
          className="font-mono"
          disabled={pending}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="v-title" className="text-xs text-muted-foreground">
          {t("versionTitle")}
        </Label>
        <Input id="v-title" name="title" disabled={pending} />
      </div>
      <Button type="submit" size="sm" disabled={pending}>
        {t("addVersion")}
      </Button>
      {state && !state.ok ? <FormMessage state={state} className="sm:col-span-3" /> : null}
    </form>
  );
}
