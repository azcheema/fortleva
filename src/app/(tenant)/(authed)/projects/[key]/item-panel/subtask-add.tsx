"use client";

import { ListTreeIcon, PlusIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { CreateVisibilitySelect, EmptyState, VisibilityBadge } from "@/components/semantic";
import { ESCAPE_LOCAL_ATTR } from "@/components/ui/escape-local";
import { Input } from "@/components/ui/input";
import { onCreateGroupBlur, useChildCreateLowered } from "@/components/work-view/use-create-visibility";
import { MAX_TITLE_LENGTH, childCreateVisibility, type ItemSurface } from "@/lib/work-view";

import { createSubtaskAction } from "./actions";
import { useShownVisibility } from "./shown-visibility";

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
 * once it exists, and only then — except for a CLAMP (asked "Client can
 * see", born private because the parent went private meanwhile), which
 * the eye must be told and a toast tells: one live surface per outcome.
 * Focus goes back to the field after the round trip only if it is
 * nowhere or still inside this field's own group (the title or the
 * switch) — a member who moved on to a picker meanwhile is not pulled
 * back.
 *
 * With nothing listed and nothing pending, the island IS the section's
 * nothing-yet state (§5.8: one verb, and the button is it) — rendered
 * here rather than around the island, so the island keeps one position
 * in the tree and its state across the refresh that lands the first row
 * (subtasks-section.tsx).
 *
 * WHO CAN SEE THE NEW CHILD (Phase 3 slice 73; founder decision (8),
 * 2026-09-12): it is born with its parent's visibility, and under a
 * parent the client can see, the field carries a LOWER-ONLY switch —
 * `CreateVisibilitySelect`, at "Client can see", with "Private to team"
 * the one other choice — for EVERY member who may create, not only those
 * who may share: lowering at birth is the one lever an Employee has,
 * since they cannot lower it afterwards. A "Private to team" choice is
 * KEPT across Enters (the safe side — founder decision C39 is that a
 * forgotten switch must never share a run of tasks) and cleared when the
 * field closes. Under a private parent there is nothing to choose, and
 * the field says so: the "Private to team" chip and "Follows ACME-12".
 * The parent's visibility is what the rail SHOWS (shown-visibility.ts),
 * never the prop, which lags a share by the whole refresh; the server
 * then never stores more than the parent it holds (`createItem`'s clamp),
 * and the announcement speaks from what was stored.
 */
export function SubtaskAdd({
  parentId,
  parentNumber,
  parentKey,
  parentVisibility,
  portalEnabled,
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
  /**
   * The portal switch as the parent's row carries it (`ItemDetail.portalEnabled`,
   * the rail's `V` note reads the same) — REQUIRED: with it off, the hint
   * says the client sees nothing yet rather than promising a view.
   */
  portalEnabled: boolean;
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
  const groupRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(0);
  const parentShown = useShownVisibility(parentId, parentVisibility);
  const { lowered, setLowered } = useChildCreateLowered({ open: editing });
  const { offered, send } = childCreateVisibility({ parentShown, lowered });
  const hintId = "subtask-add-hint";
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
    // What the field SHOWS now: the parent's visibility as the rail has it,
    // or "Private to team" when the member chose it.
    const sent = send;
    startTransition(async () => {
      const r = await createSubtaskAction({
        parentId,
        parentNumber,
        projectId,
        projectKey,
        surface,
        title: value,
        visibility: sent,
      }).catch(() => ({ ok: false as const, message: t(`failed.${level}`) }));
      setBusy(false);
      const active = document.activeElement;
      if (active === null || active === document.body || groupRef.current?.contains(active)) {
        inputRef.current?.focus();
      }
      if (!r.ok) {
        setPending((rows) => rows.filter((p) => p.id !== id));
        toast.error(r.message);
        return;
      }
      // Clear only what was actually sent (trimmed, as `value` is): a
      // title typed while this one was in flight belongs to the member.
      setTitle((current) => (current.trim() === value ? "" : current));
      const key = `${projectKey}-${r.value.number}`;
      if (sent === "CLIENT_VISIBLE" && r.value.visibility !== "CLIENT_VISIBLE") {
        // THE CLAMP: the parent went private after this field last saw it,
        // so the child was born private with it. The eye must be told —
        // it expected a shared row — and ONE live surface per outcome: the
        // toast, not the region too.
        toast.info(t(`addedPrivate.${level}`, { key, parent: parentKey }));
      } else {
        setAnnounced(
          r.value.visibility !== "CLIENT_VISIBLE"
            ? t(`added.${level}`, { key })
            : r.value.portalEnabled
              ? t(`addedVisible.${level}`, { key })
              : t(`addedVisiblePortalOff.${level}`, { key }),
        );
      }
      router.refresh();
    });
  };

  const label = t(`add.${level}`);
  // Under a private parent the field says why it is private ("Follows
  // ACME-12"); under a shared one, only while it will be shared — the
  // select already says "Private to team" when that is the choice.
  const hinted = !offered || send === "CLIENT_VISIBLE";
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
            <div
              ref={groupRef}
              className="flex flex-col gap-1.5"
              // The layer lets an Escape pressed ANYWHERE in the group through
              // (escape-local.ts) — the title field and the switch alike — so
              // it closes this field, never the peek with a typed title in it.
              {...{ [ESCAPE_LOCAL_ATTR]: "" }}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                // Nothing while a create is in flight: the title must still
                // have a field to stay in if the server refuses.
                e.preventDefault();
                if (busy) return;
                returnFocus.current = true;
                setTitle("");
                setEditing(false);
              }}
              onBlur={(e) =>
                onCreateGroupBlur(e, () => {
                  if (title.trim() === "" && !busy) setEditing(false);
                })
              }
            >
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  ref={inputRef}
                  autoFocus
                  value={title}
                  maxLength={MAX_TITLE_LENGTH}
                  onChange={(e) => setTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    e.preventDefault();
                    submit();
                  }}
                  placeholder={t(`placeholder.${level}`)}
                  aria-label={label}
                  aria-describedby={hinted ? hintId : undefined}
                  data-testid="item-subtask-input"
                  className="h-8 min-w-0 flex-1 basis-48"
                />
                {offered ? (
                  <CreateVisibilitySelect
                    value={send}
                    onChange={(next) => setLowered(next === "INTERNAL")}
                    testId="item-subtask-visibility"
                    describedBy={hinted ? hintId : undefined}
                    density="field"
                  />
                ) : (
                  <span data-testid="item-subtask-visibility-fixed" className="shrink-0">
                    <VisibilityBadge value="INTERNAL" size="sm" />
                  </span>
                )}
              </div>
              {hinted ? (
                <p id={hintId} className="text-xs whitespace-normal text-muted-foreground">
                  {!offered
                    ? t(`privateHint.${level}`, { key: parentKey })
                    : portalEnabled
                      ? t(`visibleHint.${level}`, { key: parentKey })
                      : t(`visibleHintPortalOff.${level}`, { key: parentKey })}
                </p>
              ) : null}
            </div>
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
