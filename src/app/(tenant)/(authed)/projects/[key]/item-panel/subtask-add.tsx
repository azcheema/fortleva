"use client";

import { ListTreeIcon, PlusIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { EmptyState } from "@/components/semantic";
import { ESCAPE_LOCAL_ATTR } from "@/components/ui/escape-local";
import { Input } from "@/components/ui/input";
import { MAX_TITLE_LENGTH, type ItemSurface } from "@/lib/work-view";

import { createSubtaskAction } from "./actions";

/**
 * The Subtasks section's add row (UI.md §5.4, slice 9): the board
 * column's "+" shape — a button at rest, a title field on click, Enter
 * creates and keeps the field open for the next one, Escape closes and
 * hands focus back to the button, a blur with nothing typed closes.
 * Its copy is keyed by the child LEVEL (an Epic's children are Tasks):
 * one key per level, addressed as `add.${level}` — the catalogue's own
 * convention for a closed union (`workItemType.${type}`), and the only
 * one its parity test can read (it does not parse ICU `select`).
 *
 * A TRANSITION, never a `<form action>` (the standing React 19 trap).
 * The sent title shows at once as a pending row under the list, keyed
 * by a local id — never by its title, which a sibling may share — and
 * the pending rows are shown only while the transition is pending:
 * `router.refresh()` is issued INSIDE the same transition, so React
 * keeps it pending until the refreshed tree — the server's row — has
 * committed, and the pending rows vanish on exactly that render. A
 * failure is TOLD and the title STAYS in the field — a failed action
 * must never look like a revert, and retyping a lost title is the worst
 * of both — which is also why Escape does nothing while a create is in
 * flight: a field closed by Escape has nowhere to keep a title the
 * server then refuses. `busy` is the action's own flight (the next
 * Enter may go the moment it answers, before the refresh lands);
 * `isPending` spans the refresh too. The live region speaks the new key
 * once it exists, and only then. Focus goes back to the field after the
 * round trip only if it is still nowhere — a member who moved on to a
 * picker meanwhile is not pulled back.
 *
 * With nothing listed and nothing pending, the island IS the section's
 * nothing-yet state (§5.8: one verb, and the button is it) — rendered
 * here rather than around the island, so the island keeps one position
 * in the tree and its state across the refresh that lands the first row
 * (subtasks-section.tsx). Under a client-visible parent the field
 * carries the attachments' hint: the child starts visible too (§3.1).
 */
export function SubtaskAdd({
  parentId,
  parentNumber,
  parentKey,
  parentVisibility,
  projectId,
  projectKey,
  surface,
  level,
  hasRows,
}: {
  parentId: string;
  parentNumber: number;
  /** "ACME-12" — the hint names it. */
  parentKey: string;
  parentVisibility: "INTERNAL" | "CLIENT_VISIBLE";
  projectId: string;
  projectKey: string;
  surface: ItemSurface;
  /** What the children ARE — the copy's key. */
  level: "TASK" | "SUBTASK";
  /** Whether the server lists any child — false is the island's nothing-yet state. */
  hasRows: boolean;
}) {
  const t = useTranslations("projects.item.subtasks");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ id: number; title: string }[]>([]);
  const [announced, setAnnounced] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const nextId = useRef(0);
  // Escape returns focus to the button — ONLY Escape (the board's rule):
  // a blur-close because the member clicked a row must leave that
  // click's focus alone. The button's callback ref consumes the flag.
  const returnFocus = useRef(false);

  // Pending rows exist only for the life of the transition (see above);
  // whatever is left in state afterwards is stale and never shown.
  const shownPending = isPending ? pending : [];

  const submit = () => {
    const value = title.trim();
    if (!value || busy) return;
    setBusy(true);
    const id = ++nextId.current;
    setPending((rows) => (isPending ? [...rows, { id, title: value }] : [{ id, title: value }]));
    startTransition(async () => {
      const r = await createSubtaskAction({
        parentId,
        parentNumber,
        projectId,
        projectKey,
        surface,
        title: value,
      }).catch(() => ({ ok: false as const, message: t(`failed.${level}`) }));
      setBusy(false);
      if (document.activeElement === null || document.activeElement === document.body) inputRef.current?.focus();
      if (!r.ok) {
        setPending((rows) => rows.filter((p) => p.id !== id));
        toast.error(r.message);
        return;
      }
      // Clear only what was actually sent (trimmed, as `value` is): a
      // title typed while this one was in flight belongs to the member.
      setTitle((current) => (current.trim() === value ? "" : current));
      setAnnounced(t(`added.${level}`, { key: `${projectKey}-${r.value.number}` }));
      router.refresh();
    });
  };

  const label = t(`add.${level}`);
  const nothingYet = !hasRows && shownPending.length === 0 && !editing;

  const button = (
    <button
      ref={(node) => {
        if (node && returnFocus.current) {
          returnFocus.current = false;
          node.focus();
        }
      }}
      type="button"
      data-testid="item-subtask-add"
      onClick={() => setEditing(true)}
      className="-mx-2 flex h-8 items-center gap-1.5 rounded-md px-2 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <PlusIcon aria-hidden="true" className="size-3.5" />
      {label}
    </button>
  );

  return (
    <div className="flex flex-col gap-1">
      {nothingYet ? (
        <EmptyState
          variant="empty"
          icon={ListTreeIcon}
          title={t(`empty.${level}.title`)}
          body={t(`empty.${level}.body`)}
          action={button}
        />
      ) : (
        <>
          {shownPending.length > 0 ? (
            <ul className="flex flex-col" aria-hidden="true">
              {shownPending.map((p) => (
                <li
                  key={p.id}
                  data-testid="item-subtask-pending"
                  className="-mx-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground"
                >
                  <span className="wrap-anywhere">{p.title}</span>
                  <span className="text-xs">{t("adding")}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {editing ? (
            <>
              <Input
                ref={inputRef}
                autoFocus
                value={title}
                maxLength={MAX_TITLE_LENGTH}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submit();
                  } else if (e.key === "Escape") {
                    // The layer let this Escape through (escape-local.ts).
                    // Nothing while a create is in flight: the title must
                    // still have a field to stay in if the server refuses.
                    e.preventDefault();
                    if (busy) return;
                    returnFocus.current = true;
                    setTitle("");
                    setEditing(false);
                  }
                }}
                onBlur={() => {
                  if (title.trim() === "" && !busy) setEditing(false);
                }}
                placeholder={t(`placeholder.${level}`)}
                aria-label={label}
                aria-describedby={parentVisibility === "CLIENT_VISIBLE" ? "subtask-add-hint" : undefined}
                data-testid="item-subtask-input"
                {...{ [ESCAPE_LOCAL_ATTR]: "" }}
                className="h-8"
              />
              {parentVisibility === "CLIENT_VISIBLE" ? (
                <p id="subtask-add-hint" className="text-xs text-muted-foreground">
                  {t(`visibleHint.${level}`, { key: parentKey })}
                </p>
              ) : null}
            </>
          ) : (
            button
          )}
        </>
      )}
      <span role="status" aria-live="polite" className="sr-only">
        {announced}
      </span>
    </div>
  );
}
