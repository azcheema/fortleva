"use client";

import { draggable, dropTargetForElements, monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { CalendarIcon, RepeatIcon } from "lucide-react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useOptimistic, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Command, CommandDialog, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { isActionRedirect } from "@/lib/action-redirect";
import { cutForCell } from "@/lib/calendar-plan";
import { parseDueQuery } from "@/lib/due-date";
import { dateColumn } from "@/lib/duration";
import { formatDay } from "@/lib/format";
import { cn } from "@/lib/utils";

import { moveCalendarTaskAction } from "./actions";

/**
 * THE CALENDAR'S BODY (slice 128; founder decision C105 — design §3.1,
 * §3.4). Every word and date on it arrives FORMATTED from the server page, so
 * nothing here reformats a date before hydration (the ICU trap); the only
 * date this island formats is a typed one in "Move to…", after a keystroke.
 *
 * - Desktop (`md` and up): the period as a grid of day cells. A month cell
 *   draws three entries and "+N more" (a link to that day's week); a week
 *   cell draws them all.
 * - Phone: the same period as an AGENDA — the days with something on them,
 *   each under its heading. Both are rendered; CSS shows one.
 *
 * MOVING (C105 (d)): on a FINE pointer a task drags onto another day
 * (ARC-17: no touch drag); everywhere, its "Move…" button opens a day list.
 * Either moves the entry AT ONCE (`useOptimistic`, in a transition), asks the
 * server, toasts a refusal (the entry goes back) and refreshes. A projected
 * repeat copy does not exist yet: it never drags and has no button.
 */

export type CalendarDay = {
  readonly iso: string;
  /** "17" */
  readonly dayNumber: string;
  /** "Saturday 17 October" — the cell's and the agenda heading's name. */
  readonly label: string;
  /** In the month shown (a week view: always). */
  readonly inPeriod: boolean;
  readonly isToday: boolean;
};

export type CalendarTask = {
  readonly id: string;
  readonly key: string;
  readonly projectKey: string;
  readonly title: string;
  readonly href: string;
  readonly done: boolean;
  readonly dueOn: string;
  /** "Repeats every week" when it holds a repeat. */
  readonly repeatWords: string | null;
};

export type CalendarGhost = {
  readonly key: string;
  readonly title: string;
  readonly href: string;
  /** "Weekly check — next copy of ACME-12, appears Mon 3 Nov": the accessible name, the visible title within it (WCAG 2.5.3). */
  readonly words: string;
  readonly dueOn: string;
};

export type MoveChoice = { readonly iso: string; readonly label: string };

type TaskData = { type: "calendar-task"; id: string };
type DayData = { type: "calendar-day"; iso: string };
const isTaskData = (d: Record<string | symbol, unknown>): d is TaskData => d["type"] === "calendar-task";
const isDayData = (d: Record<string | symbol, unknown>): d is DayData => d["type"] === "calendar-day";

export function CalendarBoard({
  view,
  weeks,
  weekdayLabels,
  tasks,
  ghosts,
  canEdit,
  today,
  moreHrefs,
  moveChoices,
}: {
  view: "month" | "week";
  weeks: readonly (readonly CalendarDay[])[];
  /** The seven weekday names, in the workspace's week order. */
  weekdayLabels: readonly string[];
  tasks: readonly CalendarTask[];
  ghosts: readonly CalendarGhost[];
  canEdit: boolean;
  /** The member's day — an open task due before it is overdue. */
  today: string;
  /** Each day's week view (month cells' "+N more"). */
  moreHrefs: Readonly<Record<string, string>>;
  /** "Move to…"'s days: today, tomorrow and the fortnight after, labelled. */
  moveChoices: readonly MoveChoice[];
}) {
  const t = useTranslations("calendar");
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [announced, setAnnounced] = useState("");
  const [moving, setMoving] = useState<CalendarTask | null>(null);
  const [shown, applyMove] = useOptimistic(tasks, (current: readonly CalendarTask[], mv: { id: string; dueOn: string }) =>
    current.map((task) => (task.id === mv.id ? { ...task, dueOn: mv.dueOn } : task)),
  );

  const labels = new Map<string, string>([
    ...weeks.flat().map((d) => [d.iso, d.label] as const),
    ...moveChoices.map((c) => [c.iso, c.label] as const),
  ]);

  // FOCUS AFTER "Move…" (the code review's M2, the re-check's LOW): the moved
  // chip is a NEW node in another day's list, committed with the dialog's
  // close, so the dialog's own focus return finds its origin gone. After that
  // commit the moved task's visible "Move…" button takes focus — the grid's or
  // the agenda's — and Radix's later restore leaves an element that already
  // has focus alone. When the task is not drawn (moved out of the period
  // shown), the calendar's body takes it instead; when the move is refused,
  // the next commit — the chip back in its old cell — is told to do the same.
  const refocus = useRef<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const id = refocus.current;
    if (id === null) return;
    refocus.current = null;
    const buttons = document.querySelectorAll<HTMLElement>(`[data-item-id="${CSS.escape(id)}"] [data-testid="calendar-move"]`);
    for (const b of buttons) {
      if (b.offsetParent !== null) {
        b.focus();
        return;
      }
    }
    bodyRef.current?.focus();
  });

  const move = (task: CalendarTask, iso: string, label: string | undefined) => {
    if (iso === task.dueOn) return;
    // A move from the dialog owns where focus goes; one from a drag does not.
    const fromDialog = refocus.current === task.id;
    startTransition(async () => {
      applyMove({ id: task.id, dueOn: iso });
      const r = await moveCalendarTaskAction({ itemId: task.id, projectKey: task.projectKey, targetDate: iso }).catch((e: unknown) =>
        // A redirect (an expired session, a step-up) REJECTS the promise and
        // navigates by itself: pass it silently, never toast it as a failure
        // over a page that is already leaving (`src/lib/action-redirect.ts`).
        isActionRedirect(e) ? null : { ok: false as const, message: t("moveFailed") },
      );
      if (r === null) return;
      if (!r.ok) {
        toast.error(r.message);
        // The chip goes back to its old cell as a new node: focus follows it.
        if (fromDialog) refocus.current = task.id;
      } else setAnnounced(t("moved", { key: task.key, date: label ?? labels.get(iso) ?? iso }));
      router.refresh();
    });
  };

  // ONE monitor for the surface (the board's shape): a drop on a day moves
  // the task there. The latest list and verb through refs, so the monitor is
  // registered once.
  const latest = useRef({ shown, move });
  useEffect(() => {
    latest.current = { shown, move };
  });
  useEffect(() => {
    if (!canEdit) return;
    return monitorForElements({
      canMonitor: ({ source }) => isTaskData(source.data),
      onDrop: ({ source, location }) => {
        const target = location.current.dropTargets[0];
        if (!target || !isTaskData(source.data) || !isDayData(target.data)) return;
        const id = source.data.id;
        const iso = target.data.iso;
        const task = latest.current.shown.find((x) => x.id === id);
        if (task) latest.current.move(task, iso, undefined);
      },
    });
  }, [canEdit]);

  const byDay = new Map<string, { tasks: CalendarTask[]; ghosts: CalendarGhost[] }>();
  const slot = (iso: string) => {
    let s = byDay.get(iso);
    if (!s) byDay.set(iso, (s = { tasks: [], ghosts: [] }));
    return s;
  };
  for (const task of shown) slot(task.dueOn).tasks.push(task);
  for (const ghost of ghosts) slot(ghost.dueOn).ghosts.push(ghost);

  const chipFor = (task: CalendarTask, agenda: boolean) => (
    <TaskChip
      key={task.id}
      task={task}
      overdue={!task.done && task.dueOn < today}
      canEdit={canEdit}
      agenda={agenda}
      wrap={agenda || view === "week"}
      onMove={() => setMoving(task)}
    />
  );
  const ghostFor = (ghost: CalendarGhost, wrap: boolean) => <GhostChip key={ghost.key} ghost={ghost} wrap={wrap} />;

  const agendaDays = weeks.flat().filter((d) => d.inPeriod && byDay.has(d.iso));

  return (
    // Focusable by script only: where focus goes when a moved task is not drawn (above).
    <div
      ref={bodyRef}
      tabIndex={-1}
      role="region"
      aria-label={t("title")}
      data-testid="calendar-body"
      className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <span role="status" aria-live="polite" className="sr-only">
        {announced}
      </span>

      {/* The grid — desktop. */}
      <div className="hidden md:block" data-testid="calendar-grid">
        <div className="grid grid-cols-7 border-b border-border text-xs text-muted-foreground" aria-hidden="true">
          {weekdayLabels.map((w) => (
            <div key={w} className="px-2 py-1.5">
              {w}
            </div>
          ))}
        </div>
        {weeks.map((week) => (
          <div key={week[0]!.iso} className="grid grid-cols-7 border-b border-border last:border-b-0">
            {week.map((day) => {
              const items = byDay.get(day.iso) ?? { tasks: [], ghosts: [] };
              const all: ({ kind: "task"; task: CalendarTask } | { kind: "ghost"; ghost: CalendarGhost })[] = [
                ...items.tasks.map((task) => ({ kind: "task" as const, task })),
                ...items.ghosts.map((ghost) => ({ kind: "ghost" as const, ghost })),
              ];
              const { shown: drawn, more } = view === "month" ? cutForCell(all) : { shown: all, more: 0 };
              return (
                <DayCell key={day.iso} day={day} canEdit={canEdit} tall={view === "week"}>
                  <ul className="flex flex-col gap-0.5">
                    {drawn.map((x) => (x.kind === "task" ? chipFor(x.task, false) : ghostFor(x.ghost, view === "week")))}
                  </ul>
                  {more > 0 ? (
                    <Link
                      href={moreHrefs[day.iso] ?? "/calendar"}
                      className="px-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                      data-testid="calendar-more"
                    >
                      {t("more", { count: more })}
                    </Link>
                  ) : null}
                </DayCell>
              );
            })}
          </div>
        ))}
      </div>

      {/* The agenda — phone. */}
      <div className="md:hidden" data-testid="calendar-agenda">
        {agendaDays.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <ol className="flex flex-col">
            {agendaDays.map((day) => {
              const items = byDay.get(day.iso)!;
              return (
                <li key={day.iso} className="border-b border-border px-4 py-3 last:border-b-0">
                  <h3 className={cn("mb-1.5 text-sm font-medium", day.isToday && "text-primary")}>{day.label}</h3>
                  <ul className="flex flex-col gap-1">
                    {items.tasks.map((task) => chipFor(task, true))}
                    {items.ghosts.map((g) => ghostFor(g, true))}
                  </ul>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {moving ? (
        <MoveDayDialog
          task={moving}
          choices={moveChoices}
          onOpenChange={(open) => {
            if (!open) setMoving(null);
          }}
          onChoose={(iso, label) => {
            // Where focus goes after the move: the effect above.
            refocus.current = moving.id;
            move(moving, iso, label);
          }}
        />
      ) : null}
    </div>
  );
}

/** A day: a drop target for a task when the member may move tasks. */
function DayCell({
  day,
  canEdit,
  tall,
  children,
}: {
  day: CalendarDay;
  canEdit: boolean;
  tall: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || !canEdit) return;
    return dropTargetForElements({
      element: el,
      canDrop: ({ source }) => isTaskData(source.data),
      getData: (): DayData => ({ type: "calendar-day", iso: day.iso }),
      onDragEnter: () => setOver(true),
      onDragLeave: () => setOver(false),
      onDrop: () => setOver(false),
    });
  }, [canEdit, day.iso]);
  return (
    <div
      ref={ref}
      role="group"
      aria-label={day.label}
      data-testid="calendar-day"
      data-date={day.iso}
      data-over={over ? "true" : undefined}
      className={cn(
        "flex min-w-0 flex-col gap-1 border-r border-border p-1 last:border-r-0",
        tall ? "min-h-64" : "min-h-28",
        !day.inPeriod && "text-muted-foreground",
        over && "bg-accent ring-1 ring-ring ring-inset",
      )}
    >
      <span
        className={cn(
          "num inline-flex size-6 items-center justify-center self-start rounded-full text-xs",
          day.isToday && "bg-primary font-medium text-primary-foreground",
        )}
        aria-current={day.isToday ? "date" : undefined}
      >
        {day.dayNumber}
      </span>
      {children}
    </div>
  );
}

/** A real task: its link, its marks, and — for a member who may — its "Move…" and its drag. */
function TaskChip({
  task,
  overdue,
  canEdit,
  agenda,
  wrap,
  onMove,
}: {
  task: CalendarTask;
  overdue: boolean;
  canEdit: boolean;
  /** In the phone's agenda: never draggable (ARC-17). */
  agenda: boolean;
  /** Two lines rather than one (the week view, the agenda): a column with room shows the title. */
  wrap: boolean;
  onMove: () => void;
}) {
  const t = useTranslations("calendar");
  const ref = useRef<HTMLLIElement>(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || !canEdit || agenda) return;
    // ARC-17: a fine pointer only — a touch screen moves through "Move…".
    if (!window.matchMedia("(pointer: fine)").matches) return;
    return draggable({
      element: el,
      getInitialData: (): TaskData => ({ type: "calendar-task", id: task.id }),
      onDragStart: () => setDragging(true),
      onDrop: () => setDragging(false),
    });
  }, [canEdit, agenda, task.id]);
  return (
    <li
      ref={ref}
      data-testid={agenda ? "calendar-agenda-entry" : "calendar-entry"}
      data-item-id={task.id}
      className={cn(
        "flex min-w-0 items-center gap-1 rounded-sm px-1 text-xs",
        canEdit && !agenda && "cursor-grab active:cursor-grabbing",
        dragging && "opacity-40",
        agenda && "text-sm",
      )}
    >
      <Link
        href={task.href}
        // NOT natively draggable (the code review's HIGH): a link is, so a
        // drag started on the title made the <a> the drag source, which the
        // drag library's registry (keyed on the <li>) never saw — the browser
        // dragged a URL that no day accepts. Off, the drag is the <li>'s.
        draggable={false}
        className={cn(
          "min-w-0 flex-1 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          wrap ? "line-clamp-2 break-words" : "truncate",
          task.done && "text-muted-foreground line-through",
          overdue && "text-(--tone-danger-fg)",
        )}
        title={task.title}
      >
        <span className="num-id text-muted-foreground">{task.key}</span> {task.title}
        {task.done ? <span className="sr-only">{t("doneSuffix")}</span> : null}
        {overdue ? <span className="sr-only">{t("overdueSuffix")}</span> : null}
      </Link>
      {task.repeatWords ? (
        <span role="img" aria-label={task.repeatWords} className="inline-flex shrink-0 text-muted-foreground">
          <RepeatIcon aria-hidden="true" className="size-3" />
        </span>
      ) : null}
      {canEdit ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="shrink-0"
          aria-label={t("moveButton", { key: task.key })}
          data-testid="calendar-move"
          onClick={onMove}
        >
          <CalendarIcon aria-hidden="true" />
        </Button>
      ) : null}
    </li>
  );
}

/** A copy a repeating task WILL make: faint, never draggable, linking to its series' newest task. */
function GhostChip({ ghost, wrap }: { ghost: CalendarGhost; wrap: boolean }) {
  return (
    <li
      data-testid="calendar-copy"
      className="flex min-w-0 items-center gap-1 rounded-sm border border-dashed border-border px-1 text-xs text-muted-foreground"
    >
      <RepeatIcon aria-hidden="true" className="size-3 shrink-0" />
      <Link href={ghost.href} className={cn("min-w-0 flex-1 underline-offset-2 hover:underline", wrap ? "line-clamp-2 break-words" : "truncate")} title={ghost.words}>
        <span className="sr-only">{ghost.words}</span>
        <span aria-hidden="true">{ghost.title}</span>
      </Link>
    </li>
  );
}

/** "Move to…" — the keyboard and touch twin of the drag (the board's MovePicker shape). */
function MoveDayDialog({
  task,
  choices,
  onOpenChange,
  onChoose,
}: {
  task: CalendarTask;
  choices: readonly MoveChoice[];
  onOpenChange: (open: boolean) => void;
  onChoose: (iso: string, label: string) => void;
}) {
  const t = useTranslations("calendar");
  const locale = useLocale();
  const [query, setQuery] = useState("");
  const typed = parseDueQuery(query);
  const typedLabel = typed ? formatDay(locale, dateColumn(typed)) : null;
  const pick = (iso: string, label: string) => {
    onChoose(iso, label);
    onOpenChange(false);
  };
  return (
    <CommandDialog
      open
      onOpenChange={onOpenChange}
      title={t("moveTitle", { key: task.key })}
      description={t("moveSearch")}
    >
      <Command>
        <CommandInput placeholder={t("moveSearch")} value={query} onValueChange={setQuery} />
        <CommandList>
          <CommandEmpty>{t("moveEmpty")}</CommandEmpty>
          {typed && typedLabel ? (
            <CommandItem value={`${query} ${typedLabel}`} data-testid="calendar-move-typed" onSelect={() => pick(typed, typedLabel)}>
              {t("moveTyped", { date: typedLabel })}
            </CommandItem>
          ) : null}
          {choices.map((c) => (
            <CommandItem
              key={c.iso}
              value={`${c.label} ${c.iso}`}
              data-testid={`calendar-move-choice-${c.iso}`}
              data-current={c.iso === task.dueOn ? "true" : undefined}
              onSelect={() => pick(c.iso, c.label)}
            >
              {c.label}
            </CommandItem>
          ))}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
