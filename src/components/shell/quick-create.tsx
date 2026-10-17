"use client";

import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
  quickCreateOptionsAction,
  type QuickCreateForm,
  type QuickCreateProject,
} from "@/app/(tenant)/(authed)/projects/actions";
import { createTaskAction } from "@/app/(tenant)/(authed)/projects/[key]/backlog/actions";
import { CreateVisibilitySelect, EntityChip, VisibilityBadge } from "@/components/semantic";
import { KeyboardHint } from "@/components/semantic/keyboard-hint";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmptyState,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useFocusReturn } from "@/components/ui/use-focus-return";
import { DraftAssigneePicker, DraftDuePicker, DraftPriorityPicker } from "@/components/work-view/draft-pickers";
import { useRootCreatePick } from "@/components/work-view/use-create-visibility";
import type { Priority } from "@/lib/enum-map";
import { matchesQuery } from "@/lib/text-match";
import { MAX_DESCRIPTION_TEXT, MAX_TITLE_LENGTH, rootCreateVisibility } from "@/lib/work-view";

import { useScopeKeys } from "./use-hotkeys";

/**
 * THE GLOBAL `C` — title-only create, anywhere (UI.md rule 2 and §5,
 * keymap `global · C`).
 *
 * "Project if inside one, else asks project first via picker": the
 * project comes from the ROUTE when there is one, and otherwise the
 * dialog opens on a picker. Either way the project stays changeable,
 * because which project is this surface's first property, and a member
 * who pressed `C` on the wrong page should not have to close and
 * navigate to fix it.
 *
 * WHO CAN SEE IT is the second property, where it is a choice at all
 * (Phase 3 slice 73; UI.md rule 10; founder decisions C38, C39): in a
 * project whose portal is on, a member who may share tasks gets
 * `CreateVisibilitySelect` under the title, at "Private to team"; one who
 * may not sees the "Private to team" chip, which is what the task will
 * be; a portal-off project asks nothing. The select never creates — only
 * the title field does (a stray letter on it picks "Client can see").
 * Choosing another project starts private again, and whatever state
 * says, a project that no longer OFFERS the choice sends INTERNAL
 * (`rootCreateVisibility`).
 *
 * THREE WAYS TO COMMIT, which is rule 2's create field verbatim:
 *   · Enter        — create, and leave the field empty and focused for
 *                    the next one. The project is kept, so a member
 *                    types six tasks into a project in six Enters.
 *                    Cleared on the ANSWER and guarded while one is out,
 *                    which is the backlog create row's own shape — ONE
 *                    behaviour for "the create field", not two. Clearing
 *                    on send instead lets the next title be typed inside
 *                    the flight, and was tried: the e2e caught it losing
 *                    a task outright, because the create had not landed
 *                    when the member navigated and the browser cancelled
 *                    the POST. The field is never `disabled` either —
 *                    that was the first shape, and a disabled input has
 *                    already lost focus, so the re-focus below was a
 *                    no-op and "starts the next" quietly did not.
 *   · ⌘⇧Enter      — rule 2's "create-another with the same properties":
 *                    the project, which Enter keeps too, AND the
 *                    visibility pick, which Enter does not — after a
 *                    task the client can see, Enter starts the next one
 *                    "Private to team" again (C39), and ⌘⇧Enter is how a
 *                    member keeps sharing a run of them.
 *   · ⌘Enter       — create and OPEN, on the task's own page.
 *
 * The board shadows this key with its own `C` (scope order: board 10
 * over global 0), which creates straight into the default column — a
 * surface that knows the state it wants does better than a dialog. The
 * backlog does not, so `C` there is this dialog with that project
 * already chosen.
 *
 * `canCreateTask` is a REQUIRED prop (the standing trap). It is the tenant's
 * `work_item:create`, batched with the nav's permission reads in the
 * layout, and it decides only whether the KEY is offered — a member
 * whose scope excludes a project gets nothing from the picker for it,
 * and `createItem` refuses server-side regardless. `canShareTask`
 * (REQUIRED, the same read) is `work_item:change_visibility`: whether
 * "Client can see" is offered — and `createItem` refuses the share
 * without it regardless (C38).
 *
 * THE FULLER FORM AND ITS BUTTON (slice 129, founder decision C106 (c)): a
 * project page's "New task" button opens THIS dialog (`openQuickCreate`, a
 * window event — one create dialog, not two), and the dialog now carries,
 * under the title, a description box and the Person, Due date and Priority
 * pickers — for a member who may set them (`work_item:edit` too; the
 * server's `form` answer is null otherwise, and the dialog stays
 * title-only) — plus a visible "Create task" button that creates and
 * closes. Enter's "start the next" starts it fresh: the description and the
 * three picks go back to empty, as the visibility pick does (C39); ⌘⇧Enter
 * keeps the picks (rule 2's "create another with the same properties"),
 * never the description, which is one task's own words.
 */
const OPEN_EVENT = "flv:quick-create";

/** Open the create dialog — a project page's "New task" button. A plain function, never a hook's closure (the React Compiler's module-binding trap does not apply: nothing here is a module `let`). */
export function openQuickCreate(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

export function QuickCreate({ canCreateTask, canShareTask }: { canCreateTask: boolean; canShareTask: boolean }) {
  const t = useTranslations("shell.quickCreate");
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // THE BOARD OWNS `C` ON ITS OWN ROUTE, and that is settled by the
  // ROUTE rather than by which component hydrated first. Scope order
  // (board 10 over global 0) is still what decides once both bindings
  // are registered — but the board's is registered by the board's own
  // effect, and the shell is interactive before a streamed page is, so
  // a `C` pressed into that window opened this dialog over a board that
  // was about to claim the key. A review caught it; `keymap.spec.ts`
  // presses `c` in a retry loop expecting the board's composer, and the
  // exclusive scope this dialog then takes would have made every
  // retry a no-op for the full 30 s.
  //
  // Declared and DISABLED rather than left out: a run-bearing binding
  // that is disabled SWALLOWS its key instead of falling through, so
  // the window now does nothing at all and the retry simply comes back
  // — which is what a key nobody has claimed yet should do.
  const ownedByRoute = isBoardRoute(pathname);
  useScopeKeys("global", [
    {
      key: "c",
      label: t("key"),
      enabled: canCreateTask && !ownedByRoute,
      run: () => setOpen(true),
    },
  ]);

  // The project page's "New task" button (slice 129). The button is drawn
  // only for a member who may create there; the guard is the key's own.
  useEffect(() => {
    if (!canCreateTask) return;
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, [canCreateTask]);

  // While it is open this dialog owns the keyboard, the stop confirm's
  // reason: single keys are inert in the title field and in cmdk's
  // input, but the footer's buttons are neither — a `T` or a `G P` on
  // the "change project" button would otherwise act on the page behind
  // the scrim. `exclusive` FOLLOWS `open` (the standing trap: register
  // one unconditionally and every key in the app dies).
  useScopeKeys("modal", [], { exclusive: open });

  // Keyed on `open`, so every opening starts from nothing typed and
  // nothing chosen — a dialog that reopens on last week's half-typed
  // title is a dialog nobody trusts. The route is read at that moment
  // too, which is what makes "in context" mean the page it was pressed
  // on rather than the page it was last opened on.
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {open ? (
        <QuickCreateBody
          key={pathname}
          routeKey={projectKeyOf(pathname)}
          canShareTask={canShareTask}
          onDone={() => setOpen(false)}
          onOpenTask={(href) => {
            setOpen(false);
            router.push(href);
          }}
        />
      ) : null}
    </Dialog>
  );
}

/**
 * The project key in `/projects/{KEY}/…`, or null anywhere else.
 *
 * Only a DEFAULT — the id that is actually written comes from the row
 * the picker resolved, and `createItem` scopes it server-side — so a
 * path that is not a project route simply means "ask".
 */
export function projectKeyOf(pathname: string): string | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "projects" || parts.length < 2) return null;
  const key = parts[1]!;
  return /^[A-Z][A-Z0-9]*$/.test(key) ? key : null;
}

/**
 * The board, which has a `C` of its own (UI.md keymap, `board · C`):
 * a composer straight into the default column beats a dialog on a
 * surface that already knows which column it means.
 */
export function isBoardRoute(pathname: string): boolean {
  const parts = pathname.split("/").filter(Boolean);
  return parts[0] === "projects" && parts[2] === "board";
}

/** The sentence under the field while the pick says "Client can see". */
const HINT_ID = "quick-create-visibility-hint";

type Stage = { kind: "loading" } | { kind: "picking" } | { kind: "titling"; project: QuickCreateProject };

function QuickCreateBody({
  routeKey,
  canShareTask,
  onDone,
  onOpenTask,
}: {
  routeKey: string | null;
  canShareTask: boolean;
  onDone: () => void;
  onOpenTask: (href: string) => void;
}) {
  const t = useTranslations("shell.quickCreate");
  const tCommon = useTranslations("common");
  const tVis = useTranslations("visibility.create");
  const focusReturn = useFocusReturn();
  const [projects, setProjects] = useState<QuickCreateProject[]>([]);
  // The fuller form's half (slice 129) — null for a member who may not set
  // the fields, and then the dialog is the title-only one it always was.
  const [form, setForm] = useState<QuickCreateForm | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: "loading" });
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assignee, setAssignee] = useState<string | null>(null);
  const [due, setDue] = useState<string | null>(null);
  const [priority, setPriority] = useState<Priority>("NONE");
  const [pending, setPending] = useState(false);
  const [query, setQuery] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);
  const titling = stage.kind === "titling" ? stage.project : null;
  const { pick, setPick, afterCreate } = useRootCreatePick({
    open: titling !== null,
    scope: titling?.id ?? "",
    offered: Boolean(titling?.portalEnabled) && canShareTask,
  });
  const { offered, send } = rootCreateVisibility({
    portalEnabled: titling?.portalEnabled ?? false,
    canShare: canShareTask,
    pick,
  });

  // The list is fetched once per opening. `alive` guards the setState:
  // a member who presses Escape while it is in flight has unmounted this.
  useEffect(() => {
    let alive = true;
    void quickCreateOptionsAction().then((r) => {
      if (!alive) return;
      if (!r.ok) {
        toast.error(r.message);
        onDone();
        return;
      }
      setProjects(r.value.projects);
      setForm(r.value.form);
      const inRoute = routeKey ? r.value.projects.find((p) => p.key === routeKey) : undefined;
      setStage(inRoute ? { kind: "titling", project: inRoute } : { kind: "picking" });
    });
    return () => {
      alive = false;
    };
    // Once per opening: the body is keyed on the route, so a change of
    // either input is a new body rather than a refetch into an old one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The title field is focused when the project is settled, and never by
  // `autoFocus` — Radix does not dispatch `onOpenAutoFocus` when a child
  // carries one, which is how `useFocusReturn` loses the origin (the
  // standing trap; `keymap.test.ts` scans for it).
  useEffect(() => {
    if (stage.kind === "titling") titleRef.current?.focus();
  }, [stage.kind]);

  // `close` is the Create task button's (slice 129): create, say so, and
  // close — focus goes back to whatever opened the dialog.
  const create = async (then: "again" | "keep" | "open" | "close") => {
    if (stage.kind !== "titling" || pending) return;
    const trimmed = title.trim();
    if (!trimmed) {
      // The button pressed over an empty title: the field says what is missing.
      titleRef.current?.focus();
      return;
    }
    setPending(true);
    // What this form SHOWS now — the values the answer's resets compare
    // against (`afterCreate`, and the three picks below).
    const sent = send;
    const sentDescription = form ? description : "";
    const sentAssignee = form ? assignee : null;
    const sentDue = form ? due : null;
    const sentPriority: Priority = form ? priority : "NONE";
    const r = await createTaskAction({
      projectId: stage.project.id,
      projectKey: stage.project.key,
      title: trimmed,
      visibility: sent,
      description: sentDescription,
      assigneeMemberId: sentAssignee,
      priority: sentPriority,
      targetDate: sentDue,
    }).catch(() => ({ ok: false as const, message: t("failed") }));
    setPending(false);
    if (!r.ok) {
      // An action failure must never look like a revert (standing trap):
      // everything typed and picked stays exactly where it is, and the
      // toast says why.
      toast.error(r.message);
      return;
    }
    if (then === "open") {
      onOpenTask(`/projects/${stage.project.key}/items/${r.value.number}`);
      return;
    }
    // Said from the ANSWER — what the row was born with, and whether its
    // project's portal is on — never from the pick.
    const key = `${stage.project.key}-${r.value.number}`;
    toast.success(
      r.value.visibility !== "CLIENT_VISIBLE"
        ? t("created", { key })
        : r.value.portalEnabled
          ? t("createdVisible", { key })
          : t("createdVisiblePortalOff", { key }),
    );
    if (then === "close") {
      onDone();
      return;
    }
    // C39: the next task starts private again — unless ⌘⇧Enter asked to
    // keep it, or the member changed the pick while this one was out.
    afterCreate(sent, then === "keep");
    // Only what was SENT is cleared. The fields stay enabled and focused
    // through the round trip — a create that revalidates its page takes
    // over two seconds to answer — so a member who has started the next
    // one in the meantime must not have it erased by the last one
    // landing (review). The description is one task's own words, so even
    // ⌘⇧Enter starts the next without it; the three picks are kept by
    // ⌘⇧Enter and otherwise go back to empty, as the visibility pick does.
    setTitle((current) => (current === trimmed ? "" : current));
    setDescription((current) => (current === sentDescription ? "" : current));
    if (then !== "keep") {
      setAssignee((current) => (current === sentAssignee ? null : current));
      setDue((current) => (current === sentDue ? null : current));
      setPriority((current) => (current === sentPriority ? "NONE" : current));
    }
    titleRef.current?.focus();
  };
  // Whether ⌘⇧Enter would keep anything the next task would otherwise lose.
  const picked = form !== null && (assignee !== null || due !== null || priority !== "NONE");

  const rows =
    query.trim() === ""
      ? projects
      : projects.filter((p) => matchesQuery(`${p.key} ${p.name} ${p.clientName}`, query));

  return (
    <DialogContent className="sm:max-w-lg" data-testid="quick-create" {...focusReturn}>
      <DialogHeader>
        <DialogTitle>{t("title")}</DialogTitle>
        <DialogDescription>
          {stage.kind === "titling" ? t("inProject", { name: stage.project.name }) : t("pickProject")}
        </DialogDescription>
      </DialogHeader>

      {stage.kind === "loading" ? (
        // Its OWN branch. Falling through to the picker showed "Which
        // project should it go in?" over an empty list saying there is
        // no project to add a task to — a false answer, on every open,
        // with focus in a search box where a typed title would be lost
        // (review).
        <p className="py-6 text-center text-sm text-muted-foreground">{tCommon("loading")}</p>
      ) : stage.kind === "titling" ? (
        <>
          <Input
            ref={titleRef}
            value={title}
            maxLength={MAX_TITLE_LENGTH}
            placeholder={t("placeholder")}
            aria-label={t("titleLabel")}
            aria-describedby={offered && pick === "CLIENT_VISIBLE" ? HINT_ID : undefined}
            data-testid="quick-create-title"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              // cmdk is not in this branch, so nothing else claims Enter.
              // ⌘Enter opens; ⌘⇧Enter creates the next one KEEPING the
              // visibility pick; a bare Enter creates the next one with
              // the project kept and the pick back at "Private to team".
              e.preventDefault();
              void create(e.metaKey || e.ctrlKey ? (e.shiftKey ? "keep" : "open") : "again");
            }}
          />
          {form ? (
            <>
              {/* PLAIN TEXT, made a description on the server (slice 129):
                  Enter is a new line here, and ⌘Enter / ⌘⇧Enter are the
                  title's two — create and open, create the next keeping
                  the picks. */}
              <Textarea
                value={description}
                maxLength={MAX_DESCRIPTION_TEXT}
                rows={3}
                placeholder={t("descriptionPlaceholder")}
                aria-label={t("descriptionLabel")}
                data-testid="quick-create-description"
                className="max-h-48 overflow-y-auto"
                onChange={(e) => setDescription(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
                  e.preventDefault();
                  void create(e.shiftKey ? "keep" : "open");
                }}
              />
              <div className="flex flex-wrap items-center gap-2" data-testid="quick-create-fields">
                <DraftAssigneePicker members={form.members} value={assignee} onChange={setAssignee} />
                <DraftDuePicker value={due} onChange={setDue} weekStart={form.weekStart} showIsoWeek={form.showIsoWeek} />
                <DraftPriorityPicker value={priority} onChange={setPriority} />
              </div>
            </>
          ) : null}
          {offered ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <CreateVisibilitySelect
                  value={pick}
                  onChange={setPick}
                  testId="quick-create-visibility"
                  describedBy={pick === "CLIENT_VISIBLE" ? HINT_ID : undefined}
                  density="field"
                />
                {pick === "CLIENT_VISIBLE" ? (
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <KeyboardHint keys={["mod", "Shift", "Enter"]} />
                    {t("keepHint")}
                  </span>
                ) : null}
              </div>
              {pick === "CLIENT_VISIBLE" ? (
                <p id={HINT_ID} className="text-xs text-muted-foreground">
                  {tVis("rootHint")}
                </p>
              ) : null}
            </div>
          ) : stage.project.portalEnabled ? (
            // No choice for this member (C38) in a project the client can
            // look into: the state is still drawn — absence is not a
            // state (§10.4) — as what the task will be.
            <div data-testid="quick-create-visibility-fixed">
              <VisibilityBadge value="INTERNAL" size="sm" />
            </div>
          ) : null}
          {/* Both verbs stated, in the glyph machinery rather than as
              copy: `mod` renders ⌘ on a Mac and Ctrl everywhere else,
              which a hard-coded "⌘Enter" in a message would not. Above
              the footer since slice 129, which gave the footer its button. */}
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <KeyboardHint keys={["Enter"]} />
              {t("enterHint")}
            </span>
            <span className="flex items-center gap-1.5">
              <KeyboardHint keys={["mod", "Enter"]} />
              {t("openHint")}
            </span>
            {picked ? (
              <span className="flex items-center gap-1.5">
                <KeyboardHint keys={["mod", "Shift", "Enter"]} />
                {t("keepFieldsHint")}
              </span>
            ) : null}
          </span>
          <DialogFooter className="flex-row items-center justify-between gap-2 sm:justify-between">
            {/* The project is a property, so it stays changeable here —
                the picker is one click away, not a close-and-navigate. */}
            {/* The visible chip IS the value; the sr-only clause says
                what activating it does (SC 2.5.3), the same shape the
                archived-filter chip uses. Without it the button's whole
                accessible name was a project name, which reads as a
                link to that project. */}
            <Button variant="ghost" size="sm" className="min-w-0" onClick={() => setStage({ kind: "picking" })}>
              <EntityChip
                id={stage.project.id}
                name={stage.project.name}
                entityKey={stage.project.key}
                kind="project"
              />
              <span className="sr-only">{t("changeProject")}</span>
            </Button>
            {/* The verb a pointer can see (slice 129): create and close. */}
            <Button size="sm" className="shrink-0" data-testid="quick-create-submit" onClick={() => void create("close")}>
              {t("submit")}
            </Button>
          </DialogFooter>
        </>
      ) : (
        <Command
          shouldFilter={false}
          className="rounded-none bg-transparent"
          data-testid="quick-create-projects"
        >
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={t("searchProjects")}
          />
          <CommandList>
            {rows.length === 0 ? <CommandEmptyState>{t("noProjects")}</CommandEmptyState> : null}
            <CommandGroup>
              {rows.map((p) => (
                <CommandItem
                  key={p.id}
                  value={p.id}
                  onSelect={() => {
                    setQuery("");
                    setStage({ kind: "titling", project: p });
                  }}
                >
                  <EntityChip id={p.id} name={p.name} entityKey={p.key} kind="project" />
                  <span className="ml-auto truncate text-xs text-muted-foreground">
                    {p.clientName}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      )}
    </DialogContent>
  );
}
