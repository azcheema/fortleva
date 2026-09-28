"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
  PropertyPicker,
  VISIBILITY_VALUES,
  VisibilityBadge,
  VisibilityIcon,
  visibilityLabelKey,
  type PickerOption,
  type VisibilityValue,
} from "@/components/semantic";
import { useScopeKeys } from "@/components/shell/use-hotkeys";
import { VisibilityQuestion } from "@/components/visibility-question";
import { afterClosingLayers } from "@/lib/after-closing-layers";
import { usePrivacyCopy } from "@/components/work-view/use-privacy-copy";
import { panelSurfaceOf } from "@/lib/work-view";
import type { PrivacyPreview } from "@/modules/work";

import {
  makeItemPrivateAction,
  previewMakePrivateAction,
  setItemVisibilityAction,
  type ItemPrivateResult,
  type VisibilityCommitted,
} from "../backlog/actions";
import { publishShownVisibility } from "./shown-visibility";
import { usePanelCommit } from "./use-panel-commit";

/** What the chip shows, plus what the last commit's announcement must say beyond it. */
type Shown = {
  value: VisibilityValue;
  alsoPrivate?: ItemPrivateResult["alsoPrivate"];
  ended?: boolean;
};

/**
 * The item rail's Visibility (UI.md §5.2 `V`, §10.4 — SAFETY-CRITICAL).
 * Two tokens and nothing else. The trigger's rest state IS the
 * `<VisibilityBadge>`, exactly as `VisibilityInlineEdit`'s is on the
 * files table, so the editable chip and the read-only chip are one
 * silhouette carrying all five channels; a member without
 * `work_item:change_visibility` gets the chip alone — never no chip
 * (§10.4: absence is indistinguishable from a bug). The rows' icons and
 * words are the badge's own (`VisibilityIcon`, `visibilityLabelKey`),
 * so the CVD-measured pair cannot drift between the chip and the list.
 *
 * NEVER OPTIMISTIC (§10.4). `usePanelCommit` is asked to hold the shown
 * value until the server answers, then it adopts the canonical row.
 *
 * MAKING IT PRIVATE ALWAYS WORKS (slice 72; founder decision C37). Every
 * "Private to team" goes through ONE door, `makeItemPrivateAction`: the
 * plain one-row flip, falling back to the cascade when something below
 * the task is still client-visible. Before that, when the task is shared
 * and nothing is in flight, a PREVIEW asks what else would go private;
 * when it counts anything, the rail asks — "Make this task private,
 * together with 2 tasks under it, 3 comments and 1 file?" — as a row of
 * its own under this one (§5.9, in place). The preview only decides
 * whether to ASK, never which action writes: a child that arrives after
 * it, or a reversal picked while a share is still in flight (a share
 * brings the client's own comments back, C37), is caught by the door's
 * fallback rather than refused with a toast.
 *
 * THE PREVIEW IS OUTSIDE `usePanelCommit`'s sequence, so it carries its
 * own token: a later pick supersedes it. But A "PRIVATE TO TEAM" PICK IS
 * NEVER DROPPED — the slice 72 review found two ways the first cut lost
 * one, each leaving the task on the client's portal with nothing said:
 *   · the member LEFT the task (Escape, `J`/`K`) while the preview was out:
 *     the island had unmounted. Now the answer lands as a TOAST — the ask
 *     with its "Make all private" action when something is below, and the
 *     door itself (with its result toasted) when nothing is;
 *   · on the full page the canonical prop lags a share by the whole
 *     refresh (seconds), and an answer judged "no longer shared" by that
 *     lagging prop was dropped. Now anything but a newer pick falls
 *     through to the door, which is safe on a task that is already
 *     private (`changed: false`).
 * The same holds while the answer waits for the picker to finish closing
 * (`afterClosingLayers`), and when the member leaves with the question
 * still OPEN: the question comes with them as the same toast.
 * The question itself closes underneath only when the task BECOMES
 * PRIVATE (a colleague, or our own answer) — not when a refresh confirms
 * a share. It opens only once the picker's popover has gone, and takes
 * focus only if focus is still here: nowhere, or this island's trigger —
 * a member who has moved on (another picker included) is not pulled back.
 * While the preview is out, a visible line says so.
 *
 * "FOLLOWS ACME-12". Under a PRIVATE parent the task cannot be shared —
 * child ≤ parent, the tree trigger — so the rail draws the chip as TEXT
 * with the reason on its own row, and `V` does nothing (§5.2's rule: an
 * island with nothing choosable degrades to text). Not a tooltip: the
 * picker's trigger carries none, deliberately (§5.2 — focus returns to it
 * when the popover closes and a tooltip would open and eat the next
 * Escape). Inheritance is a default at creation, never live, so "Follows"
 * means CAPPED by the parent.
 *
 * TWO WARNINGS BEFORE THE PICK, in the picker's `note` (named by its
 * search box's `aria-describedby`): with the project's portal off, the
 * client sees nothing either way; and a task handed to someone at the
 * client comes off their list when it goes private — and a re-share does
 * not hand it back (the mirror of the A picker's publish warning, 6c).
 *
 * INTERNAL is always the first row: the picker seeds `""` for it when it
 * is current (cmdk lights it), and the current value when the item is
 * shared — either way a bare Enter is the no-op §5.2 requires.
 */
export function VisibilityField({
  itemId,
  itemNumber,
  projectKey,
  surface,
  visibility,
  canChangeVisibility,
  portalEnabled,
  parent,
  assigneeContactName,
  valueClassName,
}: {
  itemId: string;
  itemNumber: number;
  projectKey: string;
  /** Decides the MFA step-up return address — see `panelSurfaceOf` / `itemReturnTo`. */
  surface: "board" | "backlog" | "page";
  visibility: VisibilityValue;
  /** `work_item:change_visibility` — REQUIRED, from `getItemDetail`. */
  canChangeVisibility: boolean;
  /** The project's portal switch — REQUIRED: with it off, the note says the client sees nothing either way. */
  portalEnabled: boolean;
  /** The parent's number and visibility — REQUIRED (null at the root): a private parent caps this task. */
  parent: { number: number; visibility: VisibilityValue } | null;
  /** The contact holding the task, if any — REQUIRED: making it private takes it off their list. */
  assigneeContactName: string | null;
  /** The rail's value-cell classes (the `<dd>` this island renders). */
  valueClassName: string;
}) {
  const t = useTranslations("projects.item");
  const tVisibility = useTranslations("visibility");
  const tBacklog = useTranslations("projects.backlog");
  const router = useRouter();
  const { partsOf: partsOfUnder, detailsOf, hasBelow } = usePrivacyCopy();
  const [open, setOpen] = useState(false);
  const labelOf = (v: VisibilityValue) => tVisibility(visibilityLabelKey(v));
  const cellRef = useRef<HTMLElement>(null);

  const partsOf = (p: { below: number; comments: number; files: number }) => partsOfUnder(p, "it");
  // The name, captured when a make-private is COMMITTED: the refresh that
  // follows clears the assignee prop before the announcement is spoken.
  const endedName = useRef<string | null>(null);

  const { shown, status, commit, intent } = usePanelCommit<Shown, VisibilityCommitted | ItemPrivateResult>({
    canonical: { value: visibility },
    same: (a, b) => a.value === b.value,
    adopt: (c) =>
      "alsoPrivate" in c
        ? { value: c.visibility, alsoPrivate: c.alsoPrivate, ended: c.endedContactAssignment }
        : { value: c.visibility, ended: c.endedContactAssignment },
    announce: (s) => {
      const also = s.alsoPrivate;
      const base =
        also && hasBelow(also)
          ? t("visibility.changedWith", { visibility: labelOf(s.value), list: partsOf(also) })
          : t("visibility.changed", { visibility: labelOf(s.value) });
      return s.ended && endedName.current
        ? `${base}. ${t("visibility.endedAssignment", { name: endedName.current })}`
        : base;
    },
    failedMessage: t("visibility.failed"),
    optimistic: false,
  });

  // THE PREVIEW'S OWN SEQUENCE (see the docblock): a token every pick
  // bumps — the ONLY thing that drops an answer — and what the rail SHOWS
  // now (`shownNow`, below: a ref the render keeps current from an effect,
  // `usePanelCommit`'s `canonicalNow` pattern), which decides only whether
  // to ASK or to go straight through the door. What it shows, NEVER the
  // canonical PROP: on the peek and the full page the prop lags a share by
  // the whole refresh, and an answer judged "no longer shared" by it went
  // through the door without asking (the first e2e run caught it).
  const previewToken = useRef(0);
  // Whether the island is still on screen when an answer lands — the task
  // may have been left (the island is keyed on the item).
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const shownNow = useRef<VisibilityValue>(visibility);
  const [checking, setChecking] = useState(false);
  const [asking, setAsking] = useState<{ preview: PrivacyPreview; takeFocus: boolean } | null>(null);
  // The open question, for the unmount below — which runs with this
  // render's closure gone.
  const askingNow = useRef<PrivacyPreview | null>(null);
  useEffect(() => {
    askingNow.current = asking?.preview ?? null;
  });
  // The task BECOMING PRIVATE underneath an open question — a colleague,
  // or our own answer landing — retires it, during render (React's
  // "adjusting state when a prop changes"), never in an effect. A change
  // TO shared is a refresh confirming a share, and leaves it alone.
  const [askedOver, setAskedOver] = useState(visibility);
  if (askedOver !== visibility) {
    setAskedOver(visibility);
    if (visibility !== "CLIENT_VISIBLE") {
      setAsking(null);
      setChecking(false);
    }
  }

  useEffect(() => {
    shownNow.current = shown.value;
  });

  // What this rail SHOWS, for the panel's other islands — the Subtasks
  // add row and `⌘⇧O` decide a new child's visibility from it, never
  // from the prop that lags a share by the whole refresh
  // (shown-visibility.ts; slice 73).
  useEffect(() => {
    publishShownVisibility(itemId, { base: visibility, shown: shown.value });
  }, [itemId, visibility, shown.value]);
  useEffect(() => () => publishShownVisibility(itemId, null), [itemId]);

  const followsPrivateParent = parent !== null && parent.visibility === "INTERNAL";
  const parentKey = parent ? `${projectKey}-${parent.number}` : "";
  const interactive = canChangeVisibility && !followsPrivateParent;

  // Above the early returns: a hook may not sit under a conditional. A
  // DISABLED binding swallows `V` rather than letting a lower scope have it.
  useScopeKeys("item", [
    { key: "v", label: t("keys.visibility"), enabled: interactive, run: () => setOpen(true) },
  ]);

  const trigger = () => cellRef.current?.querySelector<HTMLElement>('[data-slot="property-picker"]') ?? null;
  // Asked only once the picker's popover has finished closing and Radix
  // has handed focus back (`afterClosingLayers`) — so "here" is simply
  // nowhere, or this island's trigger.
  const focusIsHere = () => {
    const active = document.activeElement;
    return active === null || active === document.body || active === trigger();
  };
  const handBack = () => {
    // Focus back to the chip BEFORE the question unmounts, never to <body>.
    trigger()?.focus();
  };

  const target = { itemId, projectKey, itemNumber, surface: panelSurfaceOf(surface) };
  const makePrivate = () => {
    endedName.current = assigneeContactName;
    commit({ value: "INTERNAL" }, () => makeItemPrivateAction(target));
  };
  // The same door when the island is GONE (the member left the task while
  // the preview was out): its announcement would reach nobody, so the
  // result is a toast, and the list refreshes.
  const itemKey = `${projectKey}-${itemNumber}`;
  const makePrivateAway = () => {
    // The name, from the render that asked: the refresh clears the prop.
    const name = assigneeContactName;
    void makeItemPrivateAction(target)
      .catch(() => ({ ok: false as const, message: t("visibility.failed") }))
      .then((r) => {
        if (!r.ok) {
          toast.error(r.message);
        } else if (r.value.changed) {
          const also = r.value.alsoPrivate;
          toast.success(
            also && hasBelow(also)
              ? tBacklog("visibilityPrivateWith", { key: itemKey, list: partsOf(also) })
              : r.value.endedContactAssignment && name
                ? tBacklog("visibilityPrivateEnded", { key: itemKey, name })
                : tBacklog("visibilityPrivate", { key: itemKey }),
          );
        }
        router.refresh();
      });
  };
  // The answer, when the island is GONE: the door when nothing is below,
  // else the question as a toast whose action is the answer.
  const answerAway = (p: PrivacyPreview) => {
    if (!hasBelow(p)) {
      makePrivateAway();
      return;
    }
    toast.warning(tBacklog(p.portalEnabled ? "visibilityAsk" : "visibilityAskPortalOff", { key: itemKey, list: partsOf(p) }), {
      description: detailsOf(p).join(" "),
      duration: 30_000,
      action: { label: tBacklog("visibilityAskAction"), onClick: makePrivateAway },
    });
  };
  // LEAVING WITH THE QUESTION OPEN keeps it: the same ask, as a toast.
  // The member picked "Private to team" and has not said no — the task is
  // still on the client's portal, and dropping the question would lose
  // that in silence.
  const answerAwayNow = useRef(answerAway);
  useEffect(() => {
    answerAwayNow.current = answerAway;
  });
  useEffect(
    () => () => {
      const open = askingNow.current;
      if (open) answerAwayNow.current(open);
    },
    [],
  );

  const onSelect = (next: VisibilityValue) => {
    // Any pick retires a question or a preview still in flight.
    previewToken.current++;
    setAsking(null);
    setChecking(false);
    if (next === "CLIENT_VISIBLE") {
      commit({ value: "CLIENT_VISIBLE" }, () => setItemVisibilityAction({ ...target, visibility: "CLIENT_VISIBLE" }));
      return;
    }
    const meant = intent().value;
    // Shared and settled: ask the database what else would go private,
    // and ask the member only if anything would. Anything else — a
    // reversal while a share is still in flight, or a pick equal to what
    // is meant (the hook's no-op) — goes straight to the door.
    if (meant === "CLIENT_VISIBLE" && shown.value === "CLIENT_VISIBLE") {
      const token = ++previewToken.current;
      setChecking(true);
      void previewMakePrivateAction([itemId], projectKey)
        .catch(() => ({ ok: false as const, message: t("visibility.failed") }))
        .then((r) => {
          // Superseded by a NEWER pick — that pick is the member's word.
          if (token !== previewToken.current) return;
          if (!mounted.current) {
            // The member left the task: never drop the pick.
            if (!r.ok) toast.error(r.message);
            else answerAway(r.value);
            return;
          }
          setChecking(false);
          if (!r.ok) {
            toast.error(r.message);
            return;
          }
          const p = r.value;
          // Nothing below — or the rail no longer SHOWS it shared (a
          // colleague made it private and the refresh landed): the door,
          // which is safe either way (`changed: false` on a private task).
          if (!hasBelow(p) || shownNow.current !== "CLIENT_VISIBLE") {
            makePrivate();
            return;
          }
          // The question opens once the picker has finished closing: a
          // modal layer keeps its focus trap through its exit animation and
          // would pull focus straight back out of the question.
          afterClosingLayers(() => {
            if (token !== previewToken.current) return;
            // Left while the picker closed: the answer still lands.
            if (!mounted.current) {
              answerAway(p);
              return;
            }
            if (shownNow.current !== "CLIENT_VISIBLE") {
              makePrivate();
              return;
            }
            setAsking({ preview: p, takeFocus: focusIsHere() });
          });
        });
      return;
    }
    makePrivate();
  };

  const notes = [
    ...(!portalEnabled ? [t("visibility.portalOff")] : []),
    ...(shown.value === "CLIENT_VISIBLE" && assigneeContactName
      ? [t("visibility.handBackWarning", { name: assigneeContactName })]
      : []),
  ];

  const followsRow = followsPrivateParent ? (
    <dd className="col-span-2 pb-1 text-xs text-muted-foreground" data-testid="item-visibility-follows">
      {t("visibility.follows", { key: parentKey })}
    </dd>
  ) : null;

  if (!interactive) {
    return (
      <>
        <dd className={valueClassName}>
          <VisibilityBadge value={shown.value} />
        </dd>
        {followsRow}
      </>
    );
  }

  const options: PickerOption<VisibilityValue>[] = VISIBILITY_VALUES.map((v) => ({
    value: v,
    label: labelOf(v),
    icon: <VisibilityIcon value={v} className="shrink-0" />,
    testId: `item-visibility-${v}`,
  }));

  const preview = asking?.preview;
  const details = preview ? detailsOf(preview) : [];

  return (
    <>
      <dd className={valueClassName} ref={cellRef} aria-busy={checking || undefined}>
        <PropertyPicker
          open={open}
          onOpenChange={setOpen}
          value={shown.value}
          options={options}
          onSelect={onSelect}
          hintKey="V"
          testId="item-visibility"
          // Flush with the rail's other values: the rest box carries `px-2.5`.
          className="-ms-2.5"
          labels={{
            trigger: t("visibility.trigger", { visibility: labelOf(shown.value) }),
            search: t("visibility.search"),
            empty: t("visibility.empty"),
            current: t("currentValue"),
          }}
          note={
            notes.length > 0 ? (
              <span data-testid="item-visibility-note">{notes.join(" ")}</span>
            ) : undefined
          }
        >
          {/* The chip is the value: the badge emits `data-visibility` for the tests. */}
          <VisibilityBadge value={shown.value} />
        </PropertyPicker>
        {status}
        {/* ALWAYS mounted, so "checking…" is SPOKEN when it arrives — the
            visible line below it is born with its text, and a region born
            with its text is never announced. */}
        <span role="status" aria-live="polite" className="sr-only">
          {checking ? tVisibility("ask.checking") : ""}
        </span>
      </dd>
      {checking ? (
        <dd className="col-span-2 pb-1 text-xs text-muted-foreground" data-testid="item-visibility-checking">
          {tVisibility("ask.checking")}
        </dd>
      ) : null}
      {asking && preview ? (
        <dd className="col-span-2 pb-1">
          <VisibilityQuestion
            testId="item-visibility-question"
            question={t("visibility.askQuestion", { list: partsOf(preview) })}
            details={details}
            confirmLabel={t("visibility.askConfirm")}
            cancelLabel={t("visibility.askCancel")}
            takeFocus={asking.takeFocus}
            onConfirm={() => {
              handBack();
              setAsking(null);
              makePrivate();
            }}
            onCancel={({ returnFocus }) => {
              if (returnFocus) handBack();
              setAsking(null);
            }}
            onWithdrawn={handBack}
          />
        </dd>
      ) : null}
    </>
  );
}
