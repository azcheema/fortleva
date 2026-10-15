"use client";

import { LayoutTemplateIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Callout, Field } from "@/components/semantic";
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
import { useFocusReturn } from "@/components/ui/use-focus-return";
import { MAX_TEMPLATE_NAME_LENGTH } from "@/lib/template-rules";
import type { TemplateSaveSummary } from "@/lib/template-rules";

import { saveProjectAsTemplateAction, templateSaveSummaryAction } from "./template-actions";

/**
 * "Save as template…" on a project's Overview (slice 124, C100 (b)). The
 * dialog reads what would come along WHEN IT OPENS (never on every
 * Overview render), names the day dates are counted from, and — when the
 * name is one the workspace already uses — says saving replaces it and
 * the button reads "Replace template". The database decides "the same
 * name" (Postgres's fold); this line is the courtesy, and a race the
 * dialog did not see comes back as a refusal, after which the list is
 * read again so the member can choose to replace.
 *
 * A refusal stays in the dialog with everything typed; a success closes it
 * with a toast. No `autoFocus` (`keymap.test.ts`): Radix focuses the first
 * field, and `useFocusReturn` returns focus to the button.
 */
export function SaveTemplateButton({
  projectId,
  projectKey,
  projectName,
}: {
  projectId: string;
  projectKey: string;
  projectName: string;
}) {
  const t = useTranslations("projects.template");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="save-template-open">
        <LayoutTemplateIcon />
        {t("open")}
      </Button>
      {open ? (
        <SaveTemplateDialog
          projectId={projectId}
          projectKey={projectKey}
          projectName={projectName}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

// The plain, locale-free fold — closest to Postgres's `lower()`, which decides;
// a refusal that says the name is taken offers Replace whatever this says.
const fold = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

function SaveTemplateDialog({
  projectId,
  projectKey,
  projectName,
  onClose,
}: {
  projectId: string;
  projectKey: string;
  projectName: string;
  onClose: () => void;
}) {
  const t = useTranslations("projects.template");
  const tCommon = useTranslations("common");
  const format = useFormatter();
  const router = useRouter();
  const focusReturn = useFocusReturn();
  const [summary, setSummary] = useState<TemplateSaveSummary | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [name, setName] = useState(projectName.slice(0, MAX_TEMPLATE_NAME_LENGTH));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [reads, setReads] = useState(0);
  // The server said this name is taken though our fold did not see it.
  const [takenByServer, setTakenByServer] = useState(false);

  useEffect(() => {
    let live = true;
    // A thrown read (not a typed refusal) must still end the "Counting…"
    // line — a failure never looks like waiting (the fix review's LOW).
    templateSaveSummaryAction(projectId).then(
      (r) => {
        if (!live) return;
        if (r.ok) setSummary(r.value);
        else setReadError(r.message);
      },
      () => {
        if (live) setReadError(t("readFailed"));
      },
    );
    return () => {
      live = false;
    };
  }, [projectId, reads, t]);

  const taken = summary?.names.find((n) => fold(n) === fold(name)) ?? (takenByServer ? name.trim() : null);
  const nothing = summary !== null && summary.tasks === 0 && summary.milestones === 0;
  const canSave = summary !== null && !nothing && !summary.tooLarge && name.trim() !== "" && !pending;

  async function save() {
    setPending(true);
    setError(null);
    let r: Awaited<ReturnType<typeof saveProjectAsTemplateAction>>;
    try {
      r = await saveProjectAsTemplateAction({ projectId, key: projectKey, name, replace: taken !== null });
    } catch {
      // Thrown, not refused: say so, and give the button back (the fix
      // review's LOW — never a dialog stuck on "Saving…").
      setPending(false);
      setError(t("failed"));
      return;
    }
    if (r.ok) {
      toast.success(r.message);
      onClose();
      router.refresh();
      return;
    }
    setPending(false);
    setError(r.message);
    if (r.nameTaken) setTakenByServer(true);
    // A name saved meanwhile: read the list again, so "replaces" shows.
    setReads((n) => n + 1);
  }

  const anchor = summary ? format.dateTime(new Date(`${summary.anchor}T00:00:00Z`), { dateStyle: "long", timeZone: "UTC" }) : "";

  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent {...focusReturn} className="sm:max-w-md" data-testid="save-template-dialog">
        <DialogHeader>
          <DialogTitle>{t("dialogTitle")}</DialogTitle>
          <DialogDescription>{t("dialogDescription")}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSave) void save();
          }}
        >
          <Field htmlFor="template-name" label={t("name")} required>
            <Input
              id="template-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setTakenByServer(false);
              }}
              maxLength={MAX_TEMPLATE_NAME_LENGTH}
              required
              disabled={pending}
              data-testid="save-template-name"
            />
          </Field>
          {readError ? (
            <Callout tone="danger" role="alert">
              {readError}
            </Callout>
          ) : summary === null ? (
            <p className="text-sm text-muted-foreground" role="status">
              {t("loading")}
            </p>
          ) : nothing ? (
            <Callout tone="info" role="status">
              {t("empty")}
            </Callout>
          ) : summary.tooLarge ? (
            <Callout tone="caution" role="status">
              {t("tooLarge")}
            </Callout>
          ) : (
            <div className="flex flex-col gap-2 text-sm text-muted-foreground" data-testid="save-template-summary">
              <p className="text-foreground">{t("contents", { tasks: summary.tasks, milestones: summary.milestones })}</p>
              <p>{t("fresh")}</p>
              <p>{t("wordForWord")}</p>
              <p>{t(summary.anchorIsStart ? "anchorStart" : "anchorCreated", { date: anchor })}</p>
            </div>
          )}
          {taken !== null && canSave ? (
            <Callout tone="caution" role="status">
              <span data-testid="save-template-replaces">{t("replaces", { name: taken })}</span>
            </Callout>
          ) : null}
          {error ? (
            <Callout tone="danger" role="alert">
              {error}
            </Callout>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
              {tCommon("cancel")}
            </Button>
            <Button type="submit" disabled={!canSave} data-testid="save-template-submit">
              {pending ? t("submitting") : taken !== null ? t("submitReplace") : t("submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
