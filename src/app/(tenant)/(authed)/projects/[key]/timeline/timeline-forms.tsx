"use client";

import {
  ArrowDownIcon,
  ArrowUpIcon,
  BanIcon,
  ChevronsDownIcon,
  ChevronsUpIcon,
  CircleCheckIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  RotateCcwIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { AutoForm } from "@/components/auto-form";
import { InlineConfirm } from "@/components/inline-confirm";
import {
  Field,
  FormMessage,
  InlineEdit,
  RowActions,
  StatusBadge,
  StatusIcon,
  TimelineItem,
  VisibilityBadge,
  VisibilityInlineEdit,
  visibilityRowCue,
  type RowAction,
} from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
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
 * One milestone on the rail. THE TIMELINE IS CONTENT, NOT A FORM
 * (founder mandate 1): the name is plain 13px/500 text — the
 * highest-contrast thing in its own row — the due date is a quiet
 * formatted date, and the visibility IS the chip. Each becomes the
 * control it always was on click, Enter, Space or F2, and saves exactly
 * where it always did: `<AutoForm>` on blur, on `change` for a select.
 * Three permanently-mounted 32px boxes per milestone is what made this
 * page read as data entry rather than a plan.
 *
 * One statement per fact, and one verb per row: the visibility is no
 * longer printed twice (as a 190px select AND a chip 30px below),
 * reordering moved into the `⋯` menu instead of two arrow buttons, and
 * the only button left is the verb the row is actually waiting for.
 *
 * The node carries the state ICON, so the five milestone states are
 * told apart by silhouette before any hue is read; terminal states fill
 * their node and strike the name. The warm 2px edge on the content
 * block is the visibility row cue (§10.4) — it always travels with the
 * chip, never instead of it.
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
  const tCommon = useTranslations("common");
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
  const terminal = done || cancelled;
  const spec = STATUS_MAP.milestoneStatus[m.status];

  const node = <StatusIcon name={spec.icon} className="size-3.5" />;
  const completed =
    done && m.completedAt
      ? t("completedOn", { date: format.dateTime(m.completedAt, { dateStyle: "medium" }) })
      : null;
  const dueText = m.dueAt
    ? t("dueOn", { date: format.dateTime(m.dueAt, { dateStyle: "medium" }) })
    : null;

  const name = (
    <span className={cn(terminal ? "text-muted-foreground line-through" : "font-medium")}>
      {m.name}
    </span>
  );

  if (!editable) {
    return (
      <TimelineItem
        node={node}
        tone={spec.tone}
        filled={terminal}
        last={last}
        contentClassName={cn("flex flex-col gap-1.5", visibilityRowCue(m.visibility))}
      >
        <span className="min-w-0 truncate text-sm">{name}</span>
        <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <StatusBadge domain="milestoneStatus" value={m.status} />
          <VisibilityBadge value={m.visibility} />
          {completed ?? dueText ? <span className="num">{completed ?? dueText}</span> : null}
        </span>
      </TimelineItem>
    );
  }

  // Reordering is the keyboard twin of drag (UI.md §7.1) and lives in
  // the menu, so a row carries two controls rather than six. An item
  // that cannot act is left out rather than rendered permanently inert.
  const moveUp: RowAction[] = first
    ? []
    : [
        {
          key: "up",
          label: t("moveUp"),
          icon: ArrowUpIcon,
          onSelect: () => move({ beforeId: siblings[index - 1]!.id }),
        },
        {
          key: "top",
          label: t("moveTop"),
          icon: ChevronsUpIcon,
          onSelect: () => move({ position: "top" }),
        },
      ];
  const moveDown: RowAction[] = isLastSibling
    ? []
    : [
        {
          key: "down",
          label: t("moveDown"),
          icon: ArrowDownIcon,
          onSelect: () => move({ afterId: siblings[index + 1]!.id }),
        },
        {
          key: "bottom",
          label: t("moveBottom"),
          icon: ChevronsDownIcon,
          onSelect: () => move({ position: "bottom" }),
        },
      ];
  const statusItems: RowAction[] = [
    ...(m.status === "PLANNED" || m.status === "PAUSED"
      ? [
          {
            key: "start",
            label: t("start"),
            icon: PlayIcon,
            onSelect: () => setStatus("IN_PROGRESS"),
          } as RowAction,
        ]
      : []),
    ...(m.status === "IN_PROGRESS"
      ? [
          {
            key: "pause",
            label: t("statuses.PAUSED"),
            icon: PauseIcon,
            onSelect: () => setStatus("PAUSED"),
          } as RowAction,
        ]
      : []),
    ...(terminal
      ? [
          {
            key: "reopen",
            label: t("reopen"),
            icon: RotateCcwIcon,
            onSelect: () => setStatus("PLANNED"),
          } as RowAction,
        ]
      : []),
    ...(cancelled
      ? []
      : [
          {
            key: "cancel",
            label: t("cancel"),
            icon: BanIcon,
            tone: "danger",
            confirm: t("cancelConfirm"),
            onSelect: () => setStatus("CANCELLED"),
          } as RowAction,
        ]),
  ];
  const items = [...moveUp, ...moveDown, ...statusItems];

  return (
    <TimelineItem
      node={node}
      tone={spec.tone}
      filled={terminal}
      last={last}
      contentClassName={cn("flex flex-col", visibilityRowCue(m.visibility))}
    >
      {/* The actions sit OUTSIDE the <AutoForm>: the form paints its own
          "…" / "Saved" indicator at its own top-right corner, which is
          exactly where the ⋯ trigger would be. */}
      <div className="flex items-start justify-between gap-2">
        <AutoForm
          action={updateMilestoneAction}
          className="flex min-w-0 flex-1 flex-col gap-0.5 pr-10"
        >
          <input type="hidden" name="milestoneId" value={m.id} />
          <input type="hidden" name="projectKey" value={projectKey} />
          {/* -ml-2.5 pulls the rest button's control padding back out, so
              the name sits on the same left edge as the meta line. */}
          <InlineEdit
            kind="text"
            name="name"
            value={m.name}
            label={t("milestoneName")}
            placeholder={t("milestonePlaceholder")}
            display={name}
            inputProps={{ required: true }}
            className="-ml-2.5"
          />
          <div className="-ml-2.5 flex flex-wrap items-center gap-y-1 text-xs text-muted-foreground">
            <StatusBadge domain="milestoneStatus" value={m.status} className="ml-2.5" />
            <VisibilityInlineEdit value={m.visibility} className="ml-1 w-auto" />
            {/* Never a native yyyy-mm-dd placeholder: an undated milestone
                offers a quiet verb instead. */}
            <InlineEdit
              kind="date"
              name="dueAt"
              value={isoDate(m.dueAt)}
              label={t("due")}
              placeholder={t("setDate")}
              display={<span className="num">{dueText}</span>}
              density="table"
              className="w-auto"
            />
            {completed ? <span className="num ml-1.5">{completed}</span> : null}
          </div>
        </AutoForm>
        <span className="shrink-0">
          <RowActions
            label={tCommon("actionsFor", { name: m.name })}
            primary={
              m.status === "IN_PROGRESS" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => setStatus("DONE")}
                >
                  <CircleCheckIcon />
                  {t("complete")}
                </Button>
              ) : null
            }
            items={items}
          />
        </span>
      </div>
    </TimelineItem>
  );
}

/**
 * SAFETY-CRITICAL (UI.md §10.4): the write control wears the same warm
 * fill as the read chip while it is set to CLIENT_VISIBLE, so a new
 * milestone is never less legible than an existing one. Creation keeps
 * a real labelled control — read-first editing is for values that
 * already exist.
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
    // Container breakpoints, not viewport ones: this form lives in a card
    // that is half the content column wide (the card carries @container),
    // so `sm:` gave it four columns inside 538px and clipped the name
    // field to the width of "Des".
    <form
      ref={formRef}
      action={action}
      className="grid grid-cols-1 items-end gap-3 @2xl:grid-cols-[1fr_9rem_11rem_auto]"
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
      {state && !state.ok ? <FormMessage state={state} className="@2xl:col-span-4" /> : null}
    </form>
  );
}

// ── Versions ────────────────────────────────────────────────────────

/**
 * A shipped (or draft) version, on the same rail as the milestones it
 * sits between: what actually went live, when, and the notes that went
 * with it. Shipped nodes are filled and carry package-check; drafts
 * stay outlined with file-pen.
 *
 * The same read-first treatment as a milestone: the label, the title
 * and the release notes render as text and become their controls on
 * activation. A shipped label is immutable server-side, so it renders
 * with no affordance at all rather than as a control that will be
 * refused.
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
      contentClassName="flex flex-col gap-1.5"
    >
      <div className="flex items-start justify-between gap-2">
        <AutoForm
          action={updateVersionAction}
          className="flex min-w-0 flex-1 flex-col gap-0.5 pr-10"
        >
          <input type="hidden" name="versionId" value={v.id} />
          <input type="hidden" name="projectKey" value={projectKey} />
          <span className="-ml-2.5 flex min-w-0 flex-wrap items-center">
            <InlineEdit
              kind="text"
              name="version"
              value={v.version}
              label={t("version")}
              placeholder={t("versionPlaceholder")}
              display={<span className="num font-mono font-medium">{v.version}</span>}
              readOnly={shipped}
              inputProps={{ required: true, maxLength: 64 }}
              controlClassName="num font-mono"
              className={shipped ? "ml-2.5 w-auto" : "w-32"}
            />
            <InlineEdit
              kind="text"
              name="title"
              value={v.title ?? ""}
              label={t("versionTitle")}
              placeholder={t("versionTitle")}
              className="min-w-32 flex-1"
            />
          </span>
          <InlineEdit
            kind="multiline"
            name="releaseNotes"
            value={v.releaseNotes ?? ""}
            label={t("releaseNotes")}
            placeholder={t("releaseNotes")}
            display={<span className="text-muted-foreground">{v.releaseNotes}</span>}
            className="-ml-2.5"
          />
        </AutoForm>
        {!shipped ? (
          <span className="shrink-0">
            <InlineConfirm
              label={t("ship")}
              question={t("shipConfirm")}
              variant="outline"
              pending={pending}
              onConfirm={() => run(() => shipVersionAction(v.id, projectKey, v.version))}
            />
          </span>
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
      className="grid grid-cols-1 items-end gap-3 @lg:grid-cols-[8rem_1fr_auto]"
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
      {state && !state.ok ? <FormMessage state={state} className="@lg:col-span-3" /> : null}
    </form>
  );
}
