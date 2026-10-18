"use client";

import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { moveFactsAction, moveTaskToProjectAction } from "@/app/(tenant)/(authed)/projects/[key]/backlog/actions";
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
import { NativeSelect } from "@/components/ui/native-select";
import { useFocusReturn } from "@/components/ui/use-focus-return";
import { isActionRedirect } from "@/lib/action-redirect";
import { withItemParam, type ItemSurface, type PanelSurface } from "@/lib/work-view";
import type { MoveFacts } from "@/modules/work";

/**
 * MOVE A TASK TO ANOTHER PROJECT OF ITS CLIENT (slice 131, founder decision
 * C108) — "Move…" from the task panel's header, the backlog row's menu and
 * the board card's menu.
 *
 * The dialog reads the task (`moveFactsAction`: the client's other projects
 * the member reaches, what moves with it, and every reason the move would be
 * refused), offers the project, and — once one is chosen — reads what the
 * move would leave off THERE (labels of this project only, people who cannot
 * work there, the milestone). Every consequence is said before the click,
 * and a refusal disables Move with its reason; the move itself asks again.
 *
 * After the move the task opens where it is now: on the Tasks page, its peek
 * there under the new key; anywhere else, its own page in the new project.
 */

export type MoveSubject = { readonly id: string; readonly number: number; readonly projectKey: string };

export function MoveTaskDialog({
  subject,
  actionSurface,
  landing,
  onClosed,
}: {
  /** The task to move; null while closed. REQUIRED (the standing trap). */
  subject: MoveSubject | null;
  /** The surface the actions name — the step-up's return address. */
  actionSurface: ItemSurface;
  /** The surface it was opened on, and that surface's own URL — where a moved task opens on `/tasks`. */
  landing: { readonly surface: PanelSurface; readonly returnTo: string };
  /** Closed — Cancel, Escape, or a move made (then just before the task opens). */
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
        <MoveBody key={subject.id} subject={subject} actionSurface={actionSurface} landing={landing} onClosed={onClosed} />
      ) : null}
    </Dialog>
  );
}

function MoveBody({
  subject,
  actionSurface,
  landing,
  onClosed,
}: {
  subject: MoveSubject;
  actionSurface: ItemSurface;
  landing: { readonly surface: PanelSurface; readonly returnTo: string };
  onClosed: () => void;
}) {
  const t = useTranslations("projects.move");
  const tCommon = useTranslations("common");
  const format = useFormatter();
  const router = useRouter();
  const focusReturn = useFocusReturn();
  const ids = useId();
  const [facts, setFacts] = useState<MoveFacts | null>(null);
  const [projectId, setProjectId] = useState("");
  /** What a chosen project would leave off — read when one is chosen, and kept with the project it was read for. */
  const [read, setRead] = useState<{ readonly projectId: string; readonly facts: MoveFacts["target"] } | null>(null);
  const [busy, setBusy] = useState(false);
  const target = { itemId: subject.id, projectKey: subject.projectKey, itemNumber: subject.number, surface: actionSurface };
  // While open this dialog owns the keyboard (copy's reason): a bare key on
  // the select or a button must not reach the peek behind the scrim.
  useScopeKeys("modal", [], { exclusive: true });

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const selectRef = useRef<HTMLSelectElement>(null);

  // Once per opening (the body is keyed on the task). A server action's
  // redirect (a session that ended, a step-up) REJECTS the promise and then
  // navigates by itself — never a "couldn't move" toast.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const r = await moveFactsAction({ ...target, projectId: null }).catch((err: unknown) =>
        isActionRedirect(err) ? null : { ok: false as const, message: t("failed") },
      );
      if (!alive || r === null) return;
      if (!r.ok) {
        toast.error(r.message);
        onClosed();
        return;
      }
      setFacts(r.value);
      // The one other project, chosen; with several, the member chooses.
      if (r.value.targets.length === 1) setProjectId(r.value.targets[0]!.id);
    })();
    return () => {
      alive = false;
    };
    // Once per opening: a new task is a new body (keyed above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // What the chosen project would leave off, read for it (the reads go one
  // at a time: two actions share one request queue).
  useEffect(() => {
    if (projectId === "") return;
    let alive = true;
    void (async () => {
      const r = await moveFactsAction({ ...target, projectId }).catch((err: unknown) =>
        isActionRedirect(err) ? null : { ok: false as const, message: t("failed") },
      );
      if (!alive || r === null) return;
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      setRead({ projectId, facts: r.value.target });
    })();
    return () => {
      alive = false;
    };
    // The task does not change while open; only the project does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // The select takes focus once it is there (never `autoFocus`, which would
  // skip `useFocusReturn`'s capture — copy's way).
  useEffect(() => {
    if (facts && facts.targets.length > 0) selectRef.current?.focus();
  }, [facts]);

  const refusal: string | null = !facts
    ? null
    : facts.tooBig
      ? t("refuse.tooBig")
      : facts.inTriage
        ? t("refuse.inTriage")
        : facts.hoursBilled
          ? t("refuse.hoursBilled")
          : facts.shared && !facts.mayShare
            ? t("refuse.shared")
            : facts.othersHours && !facts.mayMoveOthersHours
              ? t("refuse.othersHours")
              : null;
  // The chosen project's facts once they are read FOR IT — while another
  // project's are still on screen, nothing is said about this one.
  const chosen = read !== null && read.projectId === projectId ? read.facts : null;
  const blocked = refusal !== null || projectId === "" || chosen === null || busy;

  const submit = async () => {
    if (!facts || blocked) return;
    setBusy(true);
    let r: Awaited<ReturnType<typeof moveTaskToProjectAction>>;
    try {
      r = await moveTaskToProjectAction({ ...target, projectId });
    } catch (err) {
      if (isActionRedirect(err)) return;
      r = { ok: false, message: t("failed") };
    }
    const key = r.ok ? `${r.value.projectKey}-${r.value.number}` : "";
    if (!mounted.current) {
      // Closed while the move was out: say what happened, and nothing more.
      if (r.ok) toast.success(t("moved", { key }));
      else toast.error(r.message);
      return;
    }
    setBusy(false);
    if (!r.ok) {
      // Never a revert: the choice stays, and the toast says why.
      toast.error(r.message);
      return;
    }
    toast.success(t("moved", { key }));
    onClosed();
    // Where it is now: on the Tasks page its peek under the new key; anywhere
    // else its own page in the new project (its old surface no longer has it).
    router.push(
      landing.surface === "tasks" ? withItemParam(landing.returnTo, key) : `/projects/${r.value.projectKey}/items/${r.value.number}`,
    );
  };

  const targetProject = facts?.targets.find((p) => p.id === projectId) ?? null;
  const hours = facts ? format.number(facts.seconds / 3600, { maximumFractionDigits: 1 }) : "";

  return (
    <DialogContent className="sm:max-w-md" data-testid="move-task" {...focusReturn}>
      <DialogHeader>
        <DialogTitle>{t("title", { key: `${subject.projectKey}-${subject.number}` })}</DialogTitle>
        <DialogDescription>{t("description")}</DialogDescription>
      </DialogHeader>
      {facts === null ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{tCommon("loading")}</p>
      ) : facts.targets.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground" data-testid="move-task-none">
          {t("noProjects")}
        </p>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field label={t("projectLabel")} htmlFor={`${ids}-project`}>
            <NativeSelect
              ref={selectRef}
              id={`${ids}-project`}
              value={projectId}
              data-testid="move-task-project"
              onChange={(e) => setProjectId(e.target.value)}
            >
              {projectId === "" ? (
                <option value="" disabled>
                  {t("chooseProject")}
                </option>
              ) : null}
              {facts.targets.map((p) => (
                <option key={p.id} value={p.id}>
                  {t("projectOption", { key: p.key, name: p.name })}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <ul className="flex list-disc flex-col gap-1 ps-5 text-sm" data-testid="move-task-facts">
            {facts.subtasks > 0 ? <li>{t("facts.subtasks", { count: facts.subtasks })}</li> : null}
            {facts.binned > 0 ? <li>{t("facts.binned", { count: facts.binned })}</li> : null}
            {/* The hours as the board shows them: the team's with time:view_team, else the reader's own. */}
            {facts.teamHours && facts.entries > 0 ? (
              <li>{t("facts.hours", { hours })}</li>
            ) : !facts.teamHours && facts.entries > 0 ? (
              <li>{t("facts.hoursOwn", { hours })}</li>
            ) : facts.othersHours ? (
              <li>{t("facts.hoursNoCount")}</li>
            ) : null}
            {chosen && chosen.hoursShared ? <li>{t("facts.hoursShared")}</li> : null}
            <li>{t("facts.newNumber", { key: `${subject.projectKey}-${subject.number}` })}</li>
            {chosen && chosen.milestone ? <li>{t("facts.milestone", { name: chosen.milestone })}</li> : null}
            {chosen && chosen.labelsLeftOff.length > 0 ? (
              <li>{t("facts.labels", { labels: chosen.labelsLeftOff.join(", ") })}</li>
            ) : null}
            {chosen && chosen.peopleLeftOff.length > 0 ? (
              <li>{t("facts.people", { people: chosen.peopleLeftOff.join(", "), key: targetProject?.key ?? "" })}</li>
            ) : null}
            {facts.shared && targetProject ? (
              <li>{targetProject.portalEnabled ? t("facts.sharedOn", { project: targetProject.name }) : t("facts.sharedOff", { project: targetProject.name })}</li>
            ) : null}
          </ul>
          {refusal ? (
            <p className="text-sm text-(--tone-danger-fg)" role="alert" data-testid="move-task-refusal">
              {refusal}
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {tCommon("cancel")}
              </Button>
            </DialogClose>
            {/* Never `disabled`: a disabled button drops focus to <body>. */}
            <Button type="submit" aria-disabled={blocked || undefined} data-testid="move-task-submit">
              {t("submit")}
            </Button>
          </DialogFooter>
        </form>
      )}
    </DialogContent>
  );
}
