"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { InlineConfirm } from "@/components/semantic";
import { Pending } from "@/components/semantic/field";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useFocusReturn } from "@/components/ui/use-focus-return";
import type { ActionResult } from "@/lib/server-actions";
import { UPDATE_EDIT_NOTE_MAX } from "@/modules/work/update-body";

import {
  annotateUpdateAction,
  archiveUpdateAction,
  retractUpdateAction,
  setUpdateVisibilityAction,
} from "./actions";

/**
 * WHAT A MEMBER MAY STILL DO TO A PUBLISHED POST: show it to the client
 * or take it back (visibility), add the one note that may change after
 * publishing, archive it, and — for fifteen minutes — retract it. Each
 * is its own audited verb in `updates.ts`; this file only names them and
 * says what happened.
 *
 * Retract and archive ask first (`InlineConfirm` with `tone="danger"`,
 * which is what makes the question render at all — AGENTS.md's dead-
 * string trap); the note lives in a dialog because it is a sentence
 * written for a client, not a click.
 */
export function PublishedActions({
  projectKey,
  id,
  visibility,
  editNote,
  retractUntil,
  caps,
}: {
  projectKey: string;
  id: string;
  visibility: "INTERNAL" | "CLIENT_VISIBLE";
  editNote: string | null;
  /** ISO instant, or null once the window has closed. */
  retractUntil: string | null;
  caps: { publish: boolean; changeVisibility: boolean };
}) {
  const t = useTranslations("projects.updates.detail");
  const tCommon = useTranslations("common");
  const format = useFormatter();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState(editNote ?? "");
  const focusReturn = useFocusReturn();

  const run = (fn: () => Promise<ActionResult<void>>, done: string) =>
    start(async () => {
      const r = await fn().catch(() => ({ ok: false as const, message: t("toasts.failed") }));
      if (!r.ok) {
        toast.error(r.message || t("toasts.failed"));
        return;
      }
      toast.success(done);
      router.refresh();
    });

  const saveNote = () => {
    const trimmed = note.trim();
    setNoteOpen(false);
    run(
      () => annotateUpdateAction({ projectKey, id, editNote: trimmed === "" ? null : trimmed }),
      trimmed === "" ? t("toasts.noteCleared") : t("toasts.annotated"),
    );
  };

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="published-actions">
      {caps.changeVisibility ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          data-testid="toggle-visibility"
          onClick={() =>
            run(
              () =>
                setUpdateVisibilityAction({
                  projectKey,
                  id,
                  visibility: visibility === "CLIENT_VISIBLE" ? "INTERNAL" : "CLIENT_VISIBLE",
                }),
              visibility === "CLIENT_VISIBLE" ? t("toasts.hidden") : t("toasts.shown"),
            )
          }
        >
          {visibility === "CLIENT_VISIBLE" ? t("actions.hide") : t("actions.show")}
        </Button>
      ) : null}
      {caps.publish ? (
        <>
          <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => setNoteOpen(true)}>
            {editNote ? t("actions.editNote") : t("actions.annotate")}
          </Button>
          {retractUntil ? (
            <InlineConfirm
              label={t("actions.retract")}
              question={t("actions.retractQuestion")}
              onConfirm={() => run(() => retractUpdateAction({ projectKey, id }), t("toasts.retracted"))}
              pending={pending}
              variant="outline"
              tone="danger"
            />
          ) : null}
          <InlineConfirm
            label={t("actions.archive")}
            question={t("actions.archiveQuestion")}
            onConfirm={() => run(() => archiveUpdateAction({ projectKey, id }), t("toasts.archived"))}
            pending={pending}
            variant="ghost"
            tone="danger"
          />
          {retractUntil ? (
            <span className="text-xs text-muted-foreground">
              {t("retractUntil", { time: format.dateTime(new Date(retractUntil), { timeStyle: "short" }) })}
            </span>
          ) : null}
        </>
      ) : null}

      <Dialog open={noteOpen} onOpenChange={(next) => (!next ? setNoteOpen(false) : undefined)}>
        <DialogContent {...focusReturn} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("annotateDialog.title")}</DialogTitle>
            <DialogDescription>{t("annotateDialog.description")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="update-note">{t("annotateDialog.label")}</Label>
            <Textarea
              id="update-note"
              value={note}
              maxLength={UPDATE_EDIT_NOTE_MAX}
              rows={3}
              placeholder={t("annotateDialog.placeholder")}
              onChange={(e) => setNote(e.target.value)}
            />
            <p className="num text-xs text-muted-foreground">
              {t("annotateDialog.count", { count: note.length, max: UPDATE_EDIT_NOTE_MAX })}
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={() => setNoteOpen(false)} disabled={pending}>
              {tCommon("cancel")}
            </Button>
            <Button type="button" size="sm" onClick={saveNote} disabled={pending}>
              {pending ? <Pending label={tCommon("loading")} /> : t("annotateDialog.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
