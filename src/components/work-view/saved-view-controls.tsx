"use client";

import { BookmarkIcon, BookmarkPlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { createSavedViewAction, updateSavedViewAction } from "@/app/(tenant)/(authed)/saved-view-actions";
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
import { isActionRedirect } from "@/lib/action-redirect";
import { SAVED_VIEW_NAME_MAX, type SavedViewKind } from "@/lib/saved-view-plan";

/** The view open on the page, as the server read it (`readOpenSavedView`). */
export type OpenView = { readonly id: string; readonly name: string; readonly query: string };

/**
 * SAVE VIEW / UPDATE VIEW (slice 136, C113) — beside a list's filters, on the
 * Tasks page and a project's backlog.
 *
 *   · No view open: "Save view" names the filters on screen; the new view
 *     then OPENS at the address the CALLER gives (`openHref`) — the filters
 *     on screen plus `?view=`. Never rebuilt from the stored filters, which
 *     would drop what a view does not keep, such as the backlog's "show
 *     archived" (the code review's L2); never read off the router's URL,
 *     which on the Tasks page trails a filter change still navigating (the
 *     re-check's L-1) — so the left menu lights it.
 *   · A view open, its filters unchanged: its name, quietly — on a phone the
 *     left menu is not in sight.
 *   · A view open and a filter changed (C113 (d)): the view is NOT changed —
 *     "Update view" makes it keep the filters on screen, and "Save as new
 *     view" names them as another.
 *
 * After Save and after Update the button pressed is gone, so focus goes to
 * the open view's name (`tabIndex={-1}`), never to `<body>` (the review's L3).
 *
 * `currentQuery` is the CANONICAL form of the filters on screen
 * (`saved-view-plan.ts`) — the caller derives it from its live state, so the
 * comparison is a string's. Both props are REQUIRED (standing trap: state a
 * shared component must reflect is never a default).
 *
 * No transition around the actions: each revalidates the signed-in layout,
 * and a pending flag would wait for the whole page's re-render (the standing
 * trap) — the buttons are guarded on the awaited action instead.
 */
export function SavedViewControls({
  kind,
  projectId,
  currentQuery,
  openView,
  openHref,
}: {
  kind: SavedViewKind;
  /** A backlog's project; null on the Tasks page. */
  projectId: string | null;
  currentQuery: string;
  openView: OpenView | null;
  /** Where a NEW view opens: the filters on screen, as this surface spells its address, plus `view=<id>`. Called when the save succeeds. */
  openHref: (id: string) => string;
}) {
  const t = useTranslations("savedViews");
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pending, setPending] = useState(false);
  // What "Update view" just stored, until the server's read of the view
  // moves on from the copy it was stored over (`over`). Dropped the moment
  // it does — so the server's copy speaks again, whoever changed it (another
  // tab, another device), and a later change BACK to `over` is never taken
  // for this one (the re-check's NIT 2). Adjusted during render, React's
  // pattern for state that follows a prop.
  const [stored, setStored] = useState<{ id: string; query: string; over: string } | null>(null);
  if (stored !== null && (openView === null || stored.id !== openView.id || openView.query !== stored.over)) {
    setStored(null);
  }
  const nameRef = useRef<HTMLSpanElement>(null);
  // Set by a Save to the NEW view's id: focus its name once the page shows
  // it. Cleared on the first view the page shows after, whichever it is — a
  // save overtaken by another navigation never moves focus later (NIT 1).
  const focusNameOf = useRef<string | null>(null);

  const savedQuery = openView && stored?.id === openView.id ? stored.query : openView?.query;
  const changed = openView !== null && savedQuery !== currentQuery;

  useEffect(() => {
    if (focusNameOf.current === null || openView === null) return;
    const wanted = focusNameOf.current;
    focusNameOf.current = null;
    if (openView.id === wanted) nameRef.current?.focus({ preventScroll: true });
  }, [openView]);

  async function update() {
    if (!openView || pending) return;
    setPending(true);
    try {
      const r = await updateSavedViewAction({ id: openView.id, query: currentQuery });
      if (r.ok) {
        setStored({ id: openView.id, query: currentQuery, over: openView.query });
        toast.success(t("updated", { name: openView.name }));
        nameRef.current?.focus({ preventScroll: true });
      } else {
        toast.error(r.message);
      }
    } catch (e) {
      if (isActionRedirect(e)) return;
      toast.error(t("failed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2" data-testid="saved-view-controls">
      {openView ? (
        <span
          ref={nameRef}
          tabIndex={-1}
          className="flex min-w-0 items-center gap-1.5 rounded-sm text-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          data-testid="saved-view-open"
        >
          <BookmarkIcon aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="sr-only">{t("openLabel")}</span>
          <span className="min-w-0 truncate" title={openView.name}>
            {openView.name}
          </span>
          {changed ? <span className="shrink-0">{t("changedSuffix")}</span> : null}
        </span>
      ) : null}
      {changed ? (
        <Button type="button" size="sm" variant="secondary" onClick={() => void update()} disabled={pending} data-testid="saved-view-update">
          {t("update")}
        </Button>
      ) : null}
      {openView === null || changed ? (
        <Button type="button" size="sm" variant="outline" onClick={() => setDialogOpen(true)} disabled={pending} data-testid="saved-view-save">
          <BookmarkPlusIcon aria-hidden="true" />
          {openView === null ? t("save") : t("saveAsNew")}
        </Button>
      ) : null}
      {dialogOpen ? (
        <SaveViewDialog
          kind={kind}
          projectId={projectId}
          query={currentQuery}
          onClose={() => setDialogOpen(false)}
          onSaved={(id) => {
            setDialogOpen(false);
            focusNameOf.current = id;
            router.replace(openHref(id), { scroll: false });
          }}
        />
      ) : null}
    </div>
  );
}

function SaveViewDialog({
  kind,
  projectId,
  query,
  onClose,
  onSaved,
}: {
  kind: SavedViewKind;
  projectId: string | null;
  query: string;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const t = useTranslations("savedViews");
  const focusReturn = useFocusReturn();
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const canSave = name.trim() !== "" && !pending;

  // A refusal gives the name field back its focus (it was disabled while the
  // save was in flight) — a taken name is the usual reason, and the fix.
  useEffect(() => {
    if (error !== null && !pending) inputRef.current?.focus();
  }, [error, pending]);

  async function save() {
    setPending(true);
    setError(null);
    try {
      const r = await createSavedViewAction({ kind, projectId, name, query });
      if (r.ok) {
        toast.success(t("saved", { name: r.value.name }));
        onSaved(r.value.id);
        return;
      }
      setError(r.message);
    } catch (e) {
      if (isActionRedirect(e)) return;
      setError(t("failed"));
    }
    setPending(false);
  }

  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent {...focusReturn} className="sm:max-w-md" data-testid="save-view-dialog">
        <DialogHeader>
          <DialogTitle>{t("dialogTitle")}</DialogTitle>
          <DialogDescription>{kind === "TASKS" ? t("dialogDescriptionTasks") : t("dialogDescriptionBacklog")}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSave) void save();
          }}
        >
          <Field htmlFor="saved-view-name" label={t("name")} required>
            <Input
              ref={inputRef}
              id="saved-view-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={SAVED_VIEW_NAME_MAX}
              placeholder={t("namePlaceholder")}
              required
              disabled={pending}
              data-testid="save-view-name"
            />
          </Field>
          <p className="text-sm text-muted-foreground">{t("onlyYou")}</p>
          {error ? (
            <Callout tone="danger" role="alert">
              {error}
            </Callout>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={!canSave} data-testid="save-view-submit">
              {pending ? t("saving") : t("saveSubmit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
