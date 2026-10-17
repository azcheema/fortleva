"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { quickCreateProjectsAction, type QuickCreateProject } from "@/app/(tenant)/(authed)/projects/actions";
import { copyItemAction, copySourceAction } from "@/app/(tenant)/(authed)/projects/[key]/backlog/actions";
import { Field } from "@/components/semantic";
import { useScopeKeys } from "@/components/shell/use-hotkeys";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeCheckbox } from "@/components/ui/native-checkbox";
import { NativeSelect } from "@/components/ui/native-select";
import { useFocusReturn } from "@/components/ui/use-focus-return";
import { isActionRedirect } from "@/lib/action-redirect";
import { MAX_TITLE_LENGTH, copyLandingHref, type ItemSurface, type PanelSurface } from "@/lib/work-view";
import type { CopyPart, CopySource } from "@/modules/work";

/**
 * COPY A TASK (slice 129, founder decision C106 (a), (b)) — "Copy…" from the
 * task panel's header, the backlog row's menu and the board card's menu.
 *
 * The dialog reads the task (`copySourceAction`: what it has — a
 * description, subtasks, labels, people, dates — each over the tree a copy
 * would take) and the projects the member can add to (the quick-create
 * list). It offers the title (the original's, editable), the project (this
 * one chosen) and a checkbox for each part the task HAS — every one ticked
 * but the dates, which usually need changing (the design's reading). It
 * says before the copy that the copy starts hidden from the client, and that
 * comments, files and time stay behind.
 *
 * The copy opens where the member will want to edit it (`copyLandingHref`):
 * in the same project, the peek of the surface it was copied from; anywhere
 * else, its own page.
 */

export type CopySubject = { readonly id: string; readonly number: number; readonly projectKey: string };

/** The parts a copy offers, in the dialog's order. */
const PARTS: readonly CopyPart[] = ["description", "subtasks", "labels", "assignee", "dates"];

export function CopyTaskDialog({
  subject,
  actionSurface,
  landing,
  onClosed,
}: {
  /** The task to copy; null while closed. REQUIRED (the standing trap). */
  subject: CopySubject | null;
  /** The surface the actions name — the step-up's return address. */
  actionSurface: ItemSurface;
  /** Where the copy opens: the surface it was copied from, and that surface's own URL. */
  landing: { readonly surface: PanelSurface; readonly returnTo: string };
  /**
   * Closed — Cancel, Escape, or a copy made (then just before the copy
   * opens). The caller clears `subject` and, opened from a menu item that is
   * gone by now, hands focus back to its row or card.
   */
  onClosed: () => void;
}) {
  return (
    <Dialog
      open={subject !== null}
      onOpenChange={(open) => {
        if (!open) onClosed();
      }}
    >
      {subject ? (
        <CopyBody
          key={subject.id}
          subject={subject}
          actionSurface={actionSurface}
          landing={landing}
          onClosed={onClosed}
        />
      ) : null}
    </Dialog>
  );
}

type Loaded = { readonly source: CopySource; readonly projects: readonly QuickCreateProject[] };

function CopyBody({
  subject,
  actionSurface,
  landing,
  onClosed,
}: {
  subject: CopySubject;
  actionSurface: ItemSurface;
  landing: { readonly surface: PanelSurface; readonly returnTo: string };
  onClosed: () => void;
}) {
  const t = useTranslations("projects.copy");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const focusReturn = useFocusReturn();
  const ids = useId();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [title, setTitle] = useState("");
  const [projectId, setProjectId] = useState("");
  const [bring, setBring] = useState<ReadonlySet<CopyPart>>(new Set());
  const [busy, setBusy] = useState(false);
  const target = { itemId: subject.id, projectKey: subject.projectKey, itemNumber: subject.number, surface: actionSurface };
  // While open this dialog owns the keyboard (quick create's reason): single
  // keys are inert in the title field, but a checkbox, the select and the
  // buttons are not — an `S` on one would open the peek's state picker
  // behind the scrim. This body is mounted only while the dialog is open, so
  // the scope follows `open` (the standing trap's condition).
  useScopeKeys("modal", [], { exclusive: true });

  // Whether this body is still on screen — a copy answered after the member
  // closed the dialog must not navigate, nor close a dialog opened since
  // (the code review's L-2: `onClosed` is the closure of THIS opening).
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const titleRef = useRef<HTMLInputElement>(null);

  // Once per opening (the body is keyed on the task). `alive` guards a close
  // while the reads are out. In sequence: two actions share one request queue.
  // A server action's redirect (a session that ended, a step-up) REJECTS the
  // promise and then navigates by itself — never a "couldn't copy" toast.
  useEffect(() => {
    let alive = true;
    const failed = (err: unknown) => (isActionRedirect(err) ? null : { ok: false as const, message: t("failed") });
    void (async () => {
      const source = await copySourceAction(target).catch(failed);
      if (!alive || source === null) return;
      if (!source.ok) {
        toast.error(source.message);
        onClosed();
        return;
      }
      const projects = await quickCreateProjectsAction().catch(failed);
      if (!alive || projects === null) return;
      if (!projects.ok) {
        toast.error(projects.message);
        onClosed();
        return;
      }
      const s = source.value;
      setLoaded({ source: s, projects: projects.value });
      setTitle(s.title);
      // This project when it is on the list; when it is not (archived), NO
      // choice — never an unrelated project picked for the member (the code
      // review's L-1): the select asks.
      setProjectId(projects.value.some((p) => p.id === s.projectId) ? s.projectId : "");
      // Everything it has, ticked — but the dates, which usually need
      // changing; subtasks past the bound, which cannot come; and subtasks
      // whose descriptions together pass the budget, which cannot come WITH
      // the descriptions (the code review's L-4).
      setBring(
        new Set(
          PARTS.filter((p) =>
            p === "description"
              ? s.description
              : p === "subtasks"
                ? s.subtasks > 0 && !s.tooManySubtasks && !s.descriptionsTooBig
                : p === "labels"
                  ? s.labels
                  : p === "assignee"
                    ? s.assignee
                    : false,
          ),
        ),
      );
    })();
    return () => {
      alive = false;
    };
    // Once per opening: a new task is a new body (keyed above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The title takes focus once the form is there (quick create's way; never
  // `autoFocus`, which would skip `useFocusReturn`'s capture): until then the
  // close button holds it, and an Enter meant for the form closed the dialog
  // (the code review's L-7).
  useEffect(() => {
    if (loaded) titleRef.current?.focus();
  }, [loaded]);

  const toggle = (part: CopyPart, on: boolean) =>
    setBring((current) => {
      const next = new Set(current);
      if (on) next.add(part);
      else next.delete(part);
      return next;
    });

  const submit = async () => {
    if (!loaded || busy) return;
    const trimmed = title.trim();
    if (trimmed === "") {
      titleRef.current?.focus();
      return;
    }
    if (projectId === "") {
      document.getElementById(`${ids}-project`)?.focus();
      return;
    }
    setBusy(true);
    let r: Awaited<ReturnType<typeof copyItemAction>>;
    try {
      r = await copyItemAction({ ...target, projectId, title: trimmed, bring: PARTS.filter((p) => bring.has(p)) });
    } catch (err) {
      // A redirect (a session that ended, a step-up) navigates on its own.
      if (isActionRedirect(err)) return;
      r = { ok: false, message: t("failed") };
    }
    if (!mounted.current) {
      // Closed while the copy was out: say what happened, and nothing more —
      // no navigation, and no `onClosed` that could close a later dialog.
      if (r.ok) toast.success(t("copied", { key: `${r.value.projectKey}-${r.value.number}` }));
      else toast.error(r.message);
      return;
    }
    setBusy(false);
    if (!r.ok) {
      // Never a revert: everything chosen stays, and the toast says why.
      toast.error(r.message);
      return;
    }
    const key = `${r.value.projectKey}-${r.value.number}`;
    const chosen = loaded.projects.find((p) => p.id === projectId);
    toast.success(
      r.value.labelsLeftOff > 0 || r.value.assigneesLeftOff > 0
        ? t("copiedLeftOff", { key, project: chosen?.name ?? r.value.projectKey })
        : t("copied", { key }),
    );
    // Closed first, then on to the copy — which takes focus where it opens.
    onClosed();
    router.push(copyLandingHref(landing.surface, landing.returnTo, subject.projectKey, r.value));
  };

  const source = loaded?.source ?? null;
  // Another project CHOSEN — no project chosen yet says nothing about it.
  const elsewhere = loaded !== null && projectId !== "" && projectId !== loaded.source.projectId;
  const chosenKey = loaded?.projects.find((p) => p.id === projectId)?.key ?? "";
  const offered = source
    ? PARTS.filter((p) =>
        p === "description" ? source.description : p === "subtasks" ? source.subtasks > 0 : p === "labels" ? source.labels : p === "assignee" ? source.assignee : source.dates,
      )
    : [];
  const partLabel = (p: CopyPart): string =>
    p === "subtasks"
      ? source?.tooManySubtasks
        ? t("parts.subtasksMany")
        : t("parts.subtasks", { count: source?.subtasks ?? 0 })
      : p === "assignee" && source?.assigneeName
        ? t("parts.assigneeNamed", { name: source.assigneeName })
        : t(`parts.${p}`);
  const partHint = (p: CopyPart): string | null =>
    p === "subtasks" && source?.tooManySubtasks
      ? t("tooManySubtasks")
      : p === "subtasks" && source?.descriptionsTooBig && bring.has("subtasks") && bring.has("description")
        ? t("descriptionsTooBig")
        : p === "labels" && elsewhere && bring.has("labels")
          ? t("labelsHint", { key: subject.projectKey })
          : p === "assignee" && elsewhere && bring.has("assignee")
            ? t("assigneeHint", { key: chosenKey })
            : null;

  return (
    <DialogContent className="sm:max-w-md" data-testid="copy-task" {...focusReturn}>
      <DialogHeader>
        <DialogTitle>{t("title", { key: `${subject.projectKey}-${subject.number}` })}</DialogTitle>
        <DialogDescription>{t("description")}</DialogDescription>
      </DialogHeader>
      {loaded === null ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{tCommon("loading")}</p>
      ) : loaded.projects.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{t("noProjects")}</p>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field label={t("titleLabel")} htmlFor={`${ids}-title`}>
            <Input
              ref={titleRef}
              id={`${ids}-title`}
              value={title}
              maxLength={MAX_TITLE_LENGTH}
              required
              data-testid="copy-task-title"
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <Field label={t("projectLabel")} htmlFor={`${ids}-project`}>
            <NativeSelect
              id={`${ids}-project`}
              value={projectId}
              data-testid="copy-task-project"
              onChange={(e) => setProjectId(e.target.value)}
            >
              {projectId === "" ? (
                <option value="" disabled>
                  {t("chooseProject")}
                </option>
              ) : null}
              {loaded.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {t("projectOption", { key: p.key, name: p.name, client: p.clientName })}
                </option>
              ))}
            </NativeSelect>
          </Field>
          {offered.length > 0 ? (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1.5 text-sm">{t("bringLabel")}</legend>
              {offered.map((p) => {
                const hint = partHint(p);
                const disabled = p === "subtasks" && loaded.source.tooManySubtasks;
                return (
                  <div key={p} className="flex flex-col gap-0.5">
                    <label className="flex items-center gap-2 text-sm">
                      <NativeCheckbox
                        checked={bring.has(p)}
                        disabled={disabled}
                        aria-describedby={hint ? `${ids}-${p}-hint` : undefined}
                        data-testid={`copy-task-part-${p}`}
                        onChange={(e) => toggle(p, e.target.checked)}
                      />
                      {partLabel(p)}
                    </label>
                    {hint ? (
                      <span id={`${ids}-${p}-hint`} className="ps-6 text-xs text-muted-foreground">
                        {hint}
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </fieldset>
          ) : null}
          <p className="text-xs text-muted-foreground">{t("note")}</p>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {tCommon("cancel")}
              </Button>
            </DialogClose>
            <Button type="submit" aria-disabled={busy || undefined} data-testid="copy-task-submit">
              {t("submit")}
            </Button>
          </DialogFooter>
        </form>
      )}
    </DialogContent>
  );
}
