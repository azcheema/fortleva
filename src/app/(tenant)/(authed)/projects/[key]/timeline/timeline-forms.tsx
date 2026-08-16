"use client";

import { ArrowDownIcon, ArrowUpIcon, MoreHorizontalIcon, PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { AutoForm } from "@/components/auto-form";
import { InlineConfirm } from "@/components/inline-confirm";
import {
  Field,
  FormMessage,
  StatusBadge,
  StatusIcon,
  TimelineItem,
  VisibilityBadge,
  visibilityRowCue,
} from "@/components/semantic";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { STATUS_MAP } from "@/lib/enum-map";
import { isoDate, type FormResult } from "@/lib/server-actions";
import { cn } from "@/lib/utils";
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
 * One milestone node on the rail: name/due/visibility auto-save
 * (manage_versions), status actions, and the keyboard twin of drag —
 * up/down arrows plus a "Move to…" menu (UI.md §7.1). Rank is never
 * rendered.
 *
 * The node itself carries the state ICON, so the five milestone states
 * are told apart by silhouette before any hue is read; terminal states
 * fill their node and strike the name. The warm 2px edge on the
 * content block is the visibility row cue (§2.4) — it always travels
 * with the chip, never instead of it.
 */
export function MilestoneItem({
  projectKey,
  milestone,
  index,
  siblings,
  editable,
  last = false,
}: {
  projectKey: string;
  milestone: MilestoneRow;
  index: number;
  /** All milestones in display order (ids only used for anchors). */
  siblings: { id: string; name: string }[];
  editable: boolean;
  last?: boolean;
}) {
  const t = useTranslations("projects.timeline");
  const format = useFormatter();
  const { pending, run } = useRun();
  const m = milestone;
  const first = index === 0;
  const isLastSibling = index === siblings.length - 1;
  const move = (target: Parameters<typeof reorderMilestoneAction>[2]) =>
    run(() => reorderMilestoneAction(m.id, projectKey, target), true);
  const setStatus = (status: string) =>
    run(() => setMilestoneStatusAction(m.id, projectKey, status), true);
  const done = m.status === "DONE";
  const cancelled = m.status === "CANCELLED";
  const spec = STATUS_MAP.milestoneStatus[m.status];

  const node = <StatusIcon name={spec.icon} className="size-3.5" />;
  const date = done && m.completedAt
    ? t("completedOn", { date: format.dateTime(m.completedAt, { dateStyle: "medium" }) })
    : m.dueAt
      ? t("dueOn", { date: format.dateTime(m.dueAt, { dateStyle: "medium" }) })
      : null;

  const meta = (
    <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <StatusBadge domain="milestoneStatus" value={m.status} />
      <VisibilityBadge value={m.visibility} />
      {date ? <span className="num">{date}</span> : null}
    </span>
  );

  if (!editable) {
    return (
      <TimelineItem
        node={node}
        tone={spec.tone}
        filled={done || cancelled}
        last={last}
        contentClassName={cn("flex flex-col gap-1.5", visibilityRowCue(m.visibility))}
      >
        <span
          className={cn(
            "text-sm",
            done || cancelled ? "text-muted-foreground line-through" : "font-medium",
          )}
        >
          {m.name}
        </span>
        {meta}
      </TimelineItem>
    );
  }

  return (
    <TimelineItem
      node={node}
      tone={spec.tone}
      filled={done || cancelled}
      last={last}
      contentClassName={cn("flex flex-col gap-2", visibilityRowCue(m.visibility))}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <AutoForm
          action={updateMilestoneAction}
          className="grid min-w-0 flex-1 grid-cols-1 gap-2 sm:grid-cols-[1fr_9rem_11rem]"
        >
          <input type="hidden" name="milestoneId" value={m.id} />
          <input type="hidden" name="projectKey" value={projectKey} />
          <Input
            name="name"
            defaultValue={m.name}
            required
            aria-label={t("milestoneName")}
            className={done || cancelled ? "line-through" : ""}
          />
          <Input
            name="dueAt"
            type="date"
            defaultValue={isoDate(m.dueAt)}
            aria-label={t("due")}
            className="num"
          />
          <VisibilityNativeSelect value={m.visibility} />
        </AutoForm>
        <div className="flex shrink-0 items-center gap-1">
          {m.status === "PLANNED" || m.status === "PAUSED" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => setStatus("IN_PROGRESS")}
            >
              {t("start")}
            </Button>
          ) : null}
          {!done && !cancelled ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => setStatus("DONE")}
            >
              {t("complete")}
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => setStatus("PLANNED")}
            >
              {t("reopen")}
            </Button>
          )}
          {/* Grouped icon buttons are 28px, never 24 flush (SC 2.5.8). */}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("moveUp")}
            disabled={first || pending}
            onClick={() => move({ beforeId: siblings[index - 1]!.id })}
          >
            <ArrowUpIcon />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("moveDown")}
            disabled={isLastSibling || pending}
            onClick={() => move({ afterId: siblings[index + 1]!.id })}
          >
            <ArrowDownIcon />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t("more")}
                disabled={pending}
              >
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={first} onSelect={() => move({ position: "top" })}>
                {t("moveTop")}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={isLastSibling}
                onSelect={() => move({ position: "bottom" })}
              >
                {t("moveBottom")}
              </DropdownMenuItem>
              {m.status === "IN_PROGRESS" ? (
                <DropdownMenuItem onSelect={() => setStatus("PAUSED")}>
                  {t("statuses.PAUSED")}
                </DropdownMenuItem>
              ) : null}
              {!cancelled ? (
                <DropdownMenuItem variant="destructive" onSelect={() => setStatus("CANCELLED")}>
                  {t("cancel")}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {meta}
    </TimelineItem>
  );
}

/**
 * SAFETY-CRITICAL (DESIGN SPEC §2.4): the write control wears the same
 * warm fill as the read chip while it is set to CLIENT_VISIBLE, so an
 * editable milestone is never less legible than a read-only one.
 */
function VisibilityNativeSelect({ value, id }: { value: "INTERNAL" | "CLIENT_VISIBLE"; id?: string }) {
  const t = useTranslations("visibility");
  const [current, setCurrent] = useState(value);
  return (
    <NativeSelect
      id={id}
      name="visibility"
      value={current}
      data-visibility={current}
      aria-label={t("label")}
      className={cn(
        current === "CLIENT_VISIBLE" &&
          "border-vis-client-border bg-vis-client font-semibold text-vis-client-fg",
      )}
      onChange={(e) => setCurrent(e.target.value === "CLIENT_VISIBLE" ? "CLIENT_VISIBLE" : "INTERNAL")}
    >
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
    <form
      ref={formRef}
      action={action}
      className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_9rem_11rem_auto]"
    >
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="projectKey" value={projectKey} />
      <Field label={t("milestoneName")} htmlFor="ms-name">
        <Input
          id="ms-name"
          ref={nameRef}
          name="name"
          required
          placeholder={t("milestonePlaceholder")}
          disabled={pending}
        />
      </Field>
      <Field label={t("due")} htmlFor="ms-due">
        <Input id="ms-due" name="dueAt" type="date" className="num" disabled={pending} />
      </Field>
      <Field label={tVis("label")} htmlFor="ms-vis">
        <VisibilityNativeSelect id="ms-vis" value="INTERNAL" />
      </Field>
      <Button type="submit" disabled={pending}>
        <PlusIcon />
        {t("addMilestone")}
      </Button>
      {state && !state.ok ? <FormMessage state={state} className="sm:col-span-4" /> : null}
    </form>
  );
}

// ── Versions ────────────────────────────────────────────────────────

/**
 * A shipped (or draft) version, on the same rail as the milestones it
 * sits between: what actually went live, when, and the notes that went
 * with it. Shipped nodes are filled and carry package-check; drafts
 * stay outlined with file-pen.
 */
export function VersionItem({
  projectKey,
  version,
  editable,
  last = false,
}: {
  projectKey: string;
  version: VersionRow;
  editable: boolean;
  last?: boolean;
}) {
  const t = useTranslations("projects.timeline");
  const format = useFormatter();
  const { pending, run } = useRun();
  const v = version;
  const shipped = v.status === "SHIPPED";
  const spec = STATUS_MAP.versionStatus[v.status];
  const node = <StatusIcon name={spec.icon} className="size-3.5" />;

  const meta = (
    <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <StatusBadge domain="versionStatus" value={v.status} />
      {shipped && v.shippedAt ? (
        <span className="num">
          {t("shipped", { date: format.dateTime(v.shippedAt, { dateStyle: "medium" }) })}
        </span>
      ) : null}
    </span>
  );

  if (!editable) {
    return (
      <TimelineItem
        node={node}
        tone={spec.tone}
        filled={shipped}
        last={last}
        contentClassName="flex flex-col gap-1.5"
      >
        <span className="flex flex-wrap items-baseline gap-2">
          <span className="num font-mono text-sm font-medium">{v.version}</span>
          {v.title ? <span className="text-sm">{v.title}</span> : null}
        </span>
        {meta}
        {v.releaseNotes ? (
          <p className="text-sm whitespace-pre-wrap text-muted-foreground">{v.releaseNotes}</p>
        ) : null}
      </TimelineItem>
    );
  }

  return (
    <TimelineItem
      node={node}
      tone={spec.tone}
      filled={shipped}
      last={last}
      contentClassName="flex flex-col gap-2"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <AutoForm
          action={updateVersionAction}
          className="grid min-w-0 flex-1 grid-cols-1 gap-2 sm:grid-cols-[8rem_1fr]"
        >
          <input type="hidden" name="versionId" value={v.id} />
          <input type="hidden" name="projectKey" value={projectKey} />
          {shipped ? (
            <span className="num flex h-8 items-center font-mono text-sm font-medium">
              {v.version}
            </span>
          ) : (
            <Input
              name="version"
              defaultValue={v.version}
              required
              aria-label={t("version")}
              className="num font-mono"
            />
          )}
          <Input
            name="title"
            defaultValue={v.title ?? ""}
            aria-label={t("versionTitle")}
            placeholder={t("versionTitle")}
          />
          <Textarea
            name="releaseNotes"
            defaultValue={v.releaseNotes ?? ""}
            rows={2}
            aria-label={t("releaseNotes")}
            placeholder={t("releaseNotes")}
            className="sm:col-span-2"
          />
        </AutoForm>
        {!shipped ? (
          <InlineConfirm
            label={t("ship")}
            question={t("shipConfirm")}
            variant="default"
            pending={pending}
            onConfirm={() => run(() => shipVersionAction(v.id, projectKey, v.version))}
          />
        ) : null}
      </div>
      {meta}
    </TimelineItem>
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
    <form
      ref={formRef}
      action={action}
      className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[8rem_1fr_auto]"
    >
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="projectKey" value={projectKey} />
      <Field label={t("version")} htmlFor="v-version">
        <Input
          id="v-version"
          ref={versionRef}
          name="version"
          required
          maxLength={64}
          placeholder={t("versionPlaceholder")}
          className="num font-mono"
          disabled={pending}
        />
      </Field>
      <Field label={t("versionTitle")} htmlFor="v-title">
        <Input id="v-title" name="title" disabled={pending} />
      </Field>
      <Button type="submit" disabled={pending}>
        <PlusIcon />
        {t("addVersion")}
      </Button>
      {state && !state.ok ? <FormMessage state={state} className="sm:col-span-3" /> : null}
    </form>
  );
}
