"use client";

import { BookmarkIcon, MoreHorizontalIcon, PencilIcon, Trash2Icon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { deleteSavedViewAction, renameSavedViewAction } from "@/app/(tenant)/(authed)/saved-view-actions";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { returnFocusTo, useFocusReturn } from "@/components/ui/use-focus-return";
import { isActionRedirect } from "@/lib/action-redirect";
import { afterClosingLayers } from "@/lib/after-closing-layers";
import { SAVED_VIEW_NAME_MAX, viewParamOf, type SavedViewLink } from "@/lib/saved-view-plan";
import { cn } from "@/lib/utils";

type Asking = {
  readonly mode: "rename" | "delete";
  readonly view: SavedViewLink;
  /**
   * The Tasks entry the list hangs under, found WHEN THE DIALOG OPENS: after a
   * delete the row's own menu button leaves, and when it was the last view the
   * whole list unmounts — a lookup through the list then finds nothing (the
   * code review's L1 (b)).
   */
  readonly tasksEntry: HTMLElement | null;
};

/**
 * THE MEMBER'S SAVED VIEWS IN THE LEFT MENU (slice 136, C113 (c)): under
 * Tasks, by name, each opening its list with its filters; a `⋯` menu beside
 * each renames or deletes it. Drawn in the desktop rail (`variant="rail"`,
 * left out while the rail is collapsed — a column of identical icons names
 * nothing) and in the phone's More sheet (`variant="sheet"`, the menu always
 * visible: a touch screen has no hover).
 *
 * A view is LIT when its list is the page and its id is the page's `?view=`
 * — the open view, whatever its filters now are. A backlog view whose project
 * the member no longer reaches has no link (`href` null): listed greyed, with
 * its menu, so it can still be renamed or deleted (it counts toward the 30).
 *
 * The dialogs open after the menu has gone (`afterClosingLayers`) and return
 * focus through `useFocusReturn`; after a DELETE the row's own menu button is
 * about to leave, so focus goes to the Tasks entry above the list instead —
 * as a RETURN (`returnFocusTo`), so the rail's tooltip there stays shut.
 */
export function SavedViewsNav({
  views,
  variant,
  onNavigate,
}: {
  views: readonly SavedViewLink[];
  variant: "rail" | "sheet";
  /** The sheet closes on a link's click. */
  onNavigate?: () => void;
}) {
  const t = useTranslations("savedViews");
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const openId = viewParamOf(searchParams);
  const [asking, setAsking] = useState<Asking | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  if (views.length === 0) return null;

  const isOpen = (v: SavedViewLink) => v.href !== null && openId === v.id && pathname === v.href.split("?")[0];
  const ask = (mode: Asking["mode"], view: SavedViewLink) => {
    const tasksEntry = listRef.current?.parentElement?.querySelector<HTMLAnchorElement>("a") ?? null;
    afterClosingLayers(() => setAsking({ mode, view, tasksEntry }));
  };

  const rowClass =
    variant === "rail"
      ? "relative flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2 pr-8 text-xs text-sidebar-foreground"
      : "flex h-9 min-w-0 flex-1 items-center gap-3 rounded-md px-3 pr-10 pl-9 text-xs";

  return (
    <>
      <ul
        ref={listRef}
        aria-label={t("menuLabel")}
        data-testid={`saved-views-${variant}`}
        className={cn("flex flex-col gap-0.5", variant === "rail" ? "mt-0.5 md:pl-4" : "")}
      >
        {views.map((v) => {
          const open = isOpen(v);
          return (
            <li key={v.id} className="group/view relative flex min-w-0 items-center" data-testid="saved-view-row" data-view-id={v.id}>
              {v.href === null ? (
                <span className={cn(rowClass, "text-muted-foreground")} data-testid="saved-view-unavailable" title={t("unavailable")}>
                  <BookmarkIcon aria-hidden="true" className="size-3.5 shrink-0" />
                  <span className="min-w-0 truncate">{v.name}</span>
                  <span className="sr-only">{t("unavailable")}</span>
                </span>
              ) : (
                <Link
                  href={v.href}
                  onClick={onNavigate}
                  aria-current={open ? "page" : undefined}
                  data-testid="saved-view-link"
                  className={cn(
                    rowClass,
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                    variant === "rail"
                      ? "transition-colors duration-(--dur-instant) ease-out hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                      : "hover:bg-accent",
                    open &&
                      (variant === "rail"
                        ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full before:bg-sidebar-primary"
                        : "bg-accent font-medium"),
                  )}
                >
                  <BookmarkIcon aria-hidden="true" className={cn("size-3.5 shrink-0", open && variant === "rail" && "text-sidebar-primary")} />
                  <span className="min-w-0 truncate" title={v.name}>
                    {v.name}
                  </span>
                  {v.projectKey ? (
                    <span className="num-id shrink-0 text-2xs text-muted-foreground">
                      <span className="sr-only">{t("backlogOf")}</span>
                      {v.projectKey}
                    </span>
                  ) : null}
                </Link>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t("actionsFor", { name: v.name })}
                    data-testid="saved-view-menu"
                    className={cn(
                      "absolute right-1",
                      // The rail shows the button on hover or focus; the sheet always.
                      variant === "rail" &&
                        "opacity-0 group-hover/view:opacity-100 group-focus-within/view:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100",
                    )}
                  >
                    <MoreHorizontalIcon aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem data-testid="saved-view-rename" onSelect={() => ask("rename", v)}>
                    <PencilIcon aria-hidden="true" />
                    {t("rename")}
                  </DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" data-testid="saved-view-delete" onSelect={() => ask("delete", v)}>
                    <Trash2Icon aria-hidden="true" />
                    {t("delete")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          );
        })}
      </ul>
      {asking?.mode === "rename" ? <RenameDialog view={asking.view} onClose={() => setAsking(null)} /> : null}
      {asking?.mode === "delete" ? (
        <DeleteDialog
          view={asking.view}
          isOpenView={isOpen(asking.view)}
          onClose={() => setAsking(null)}
          tasksEntry={asking.tasksEntry}
        />
      ) : null}
    </>
  );
}

function RenameDialog({ view, onClose }: { view: SavedViewLink; onClose: () => void }) {
  const t = useTranslations("savedViews");
  const focusReturn = useFocusReturn();
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(view.name);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const canSave = name.trim() !== "" && !pending;

  // A refusal gives the name field back its focus (it was disabled while the
  // save was in flight) — the name is what the member changes next.
  useEffect(() => {
    if (error !== null && !pending) inputRef.current?.focus();
  }, [error, pending]);

  async function save() {
    setPending(true);
    setError(null);
    try {
      const r = await renameSavedViewAction({ id: view.id, name });
      if (r.ok) {
        if (r.value.changed) toast.success(t("renamed", { name: r.value.name }));
        onClose();
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
      <DialogContent {...focusReturn} className="sm:max-w-md" data-testid="rename-view-dialog">
        <DialogHeader>
          <DialogTitle>{t("renameTitle")}</DialogTitle>
          <DialogDescription>{t("renameDescription")}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSave) void save();
          }}
        >
          <Field htmlFor="rename-view-name" label={t("name")} required>
            <Input
              ref={inputRef}
              id="rename-view-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={SAVED_VIEW_NAME_MAX}
              required
              disabled={pending}
              data-testid="rename-view-name"
            />
          </Field>
          {error ? (
            <Callout tone="danger" role="alert">
              {error}
            </Callout>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={!canSave} data-testid="rename-view-submit">
              {pending ? t("saving") : t("renameSubmit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({
  view,
  isOpenView,
  onClose,
  tasksEntry,
}: {
  view: SavedViewLink;
  /** The page shows this view now: its address loses `?view=` with it. */
  isOpenView: boolean;
  onClose: () => void;
  /** Where focus goes once the view is gone (`Asking.tasksEntry`). */
  tasksEntry: HTMLElement | null;
}) {
  const t = useTranslations("savedViews");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const deleted = useRef(false);
  const focusReturn = useFocusReturn({
    onCloseAutoFocus: (event) => {
      if (!deleted.current || !tasksEntry?.isConnected) return;
      event.preventDefault();
      returnFocusTo(tasksEntry);
    },
  });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function remove() {
    setPending(true);
    setError(null);
    try {
      const r = await deleteSavedViewAction({ id: view.id });
      if (r.ok) {
        deleted.current = true;
        toast.success(t("deleted", { name: view.name }));
        onClose();
        if (isOpenView) {
          // The list stays as it is on screen — only the view's name leaves the address.
          const next = new URLSearchParams(searchParams.toString());
          next.delete("view");
          const q = next.toString();
          router.replace(q === "" ? pathname : `${pathname}?${q}`, { scroll: false });
        }
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
      <DialogContent {...focusReturn} className="sm:max-w-md" data-testid="delete-view-dialog">
        <DialogHeader>
          <DialogTitle>{t("deleteTitle", { name: view.name })}</DialogTitle>
          <DialogDescription>{t("deleteDescription")}</DialogDescription>
        </DialogHeader>
        {error ? (
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
            {t("cancel")}
          </Button>
          <Button type="button" variant="destructive" onClick={() => void remove()} disabled={pending} data-testid="delete-view-submit">
            {pending ? t("deleting") : t("deleteSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
