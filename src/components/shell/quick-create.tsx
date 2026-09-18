"use client";

import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
  quickCreateProjectsAction,
  type QuickCreateProject,
} from "@/app/(tenant)/(authed)/projects/actions";
import { createItemAnywhereAction } from "@/app/(tenant)/(authed)/projects/[key]/backlog/actions";
import { EntityChip } from "@/components/semantic";
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
import { useFocusReturn } from "@/components/ui/use-focus-return";
import { matchesQuery } from "@/lib/text-match";
import { MAX_TITLE_LENGTH } from "@/lib/work-view";

import { useScopeKeys } from "./use-hotkeys";

/**
 * THE GLOBAL `C` — title-only create, anywhere (UI.md rule 2 and §5,
 * keymap `global · C`).
 *
 * "Project if inside one, else asks project first via picker": the
 * project comes from the ROUTE when there is one, and otherwise the
 * dialog opens on a picker. Either way the project stays changeable,
 * because the one property this surface has is which project, and a
 * member who pressed `C` on the wrong page should not have to close and
 * navigate to fix it.
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
 *   · ⌘⇧Enter      — the same. Rule 2 calls it "create-another with the
 *                    same properties", and on THIS surface the only
 *                    property is the project, which Enter already keeps
 *                    — so it is an alias rather than a second verb, and
 *                    it is bound so the muscle memory from the board's
 *                    composer does not die here.
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
 * and `createItem` refuses server-side regardless.
 */
export function QuickCreate({ canCreateTask }: { canCreateTask: boolean }) {
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

type Stage = { kind: "loading" } | { kind: "picking" } | { kind: "titling"; project: QuickCreateProject };

function QuickCreateBody({
  routeKey,
  onDone,
  onOpenTask,
}: {
  routeKey: string | null;
  onDone: () => void;
  onOpenTask: (href: string) => void;
}) {
  const t = useTranslations("shell.quickCreate");
  const tCommon = useTranslations("common");
  const focusReturn = useFocusReturn();
  const [projects, setProjects] = useState<QuickCreateProject[]>([]);
  const [stage, setStage] = useState<Stage>({ kind: "loading" });
  const [title, setTitle] = useState("");
  const [pending, setPending] = useState(false);
  const [query, setQuery] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);

  // The list is fetched once per opening. `alive` guards the setState:
  // a member who presses Escape while it is in flight has unmounted this.
  useEffect(() => {
    let alive = true;
    void quickCreateProjectsAction().then((r) => {
      if (!alive) return;
      if (!r.ok) {
        toast.error(r.message);
        onDone();
        return;
      }
      setProjects(r.value);
      const inRoute = routeKey ? r.value.find((p) => p.key === routeKey) : undefined;
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

  const create = async (then: "again" | "open") => {
    if (stage.kind !== "titling" || pending) return;
    const trimmed = title.trim();
    if (!trimmed) return;
    setPending(true);
    const r = await createItemAnywhereAction(stage.project.id, stage.project.key, trimmed).catch(
      () => ({ ok: false as const, message: t("failed") }),
    );
    setPending(false);
    if (!r.ok) {
      // An action failure must never look like a revert (standing trap):
      // the typed title stays exactly where it is, and the toast says why.
      toast.error(r.message);
      return;
    }
    if (then === "open") {
      onOpenTask(`/projects/${stage.project.key}/items/${r.value.number}`);
      return;
    }
    toast.success(t("created", { key: `${stage.project.key}-${r.value.number}` }));
    // Only the title that was SENT is cleared. The field stays enabled
    // and focused through the round trip — a create that revalidates
    // its page takes over two seconds to answer — so a member who has
    // started the next one in the meantime must not have it erased by
    // the last one landing (review).
    setTitle((current) => (current === trimmed ? "" : current));
    titleRef.current?.focus();
  };

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
            data-testid="quick-create-title"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              // cmdk is not in this branch, so nothing else claims Enter.
              // ⌘Enter opens; ⌘⇧Enter and a bare Enter both create the
              // next one, which on this surface is the same thing —
              // "with the same properties" (rule 2) means the project,
              // and Enter keeps it.
              e.preventDefault();
              void create(e.metaKey || e.ctrlKey ? (e.shiftKey ? "again" : "open") : "again");
            }}
          />
          <DialogFooter className="items-center justify-between gap-2 sm:justify-between">
            {/* The project is a property, so it stays changeable here —
                the picker is one click away, not a close-and-navigate. */}
            {/* The visible chip IS the value; the sr-only clause says
                what activating it does (SC 2.5.3), the same shape the
                archived-filter chip uses. Without it the button's whole
                accessible name was a project name, which reads as a
                link to that project. */}
            <Button variant="ghost" size="sm" onClick={() => setStage({ kind: "picking" })}>
              <EntityChip
                id={stage.project.id}
                name={stage.project.name}
                entityKey={stage.project.key}
                kind="project"
              />
              <span className="sr-only">{t("changeProject")}</span>
            </Button>
            {/* Both verbs stated, in the glyph machinery rather than as
                copy: `mod` renders ⌘ on a Mac and Ctrl everywhere else,
                which a hard-coded "⌘Enter" in a message would not. */}
            <span className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <KeyboardHint keys={["Enter"]} />
                {t("enterHint")}
              </span>
              <span className="flex items-center gap-1.5">
                <KeyboardHint keys={["mod", "Enter"]} />
                {t("openHint")}
              </span>
            </span>
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
