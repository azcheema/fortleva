"use client";

import { CheckIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useMemo, useOptimistic, useState, useTransition } from "react";
import { toast } from "sonner";

import { PropertyPicker, StatusIcon, type PickerOption } from "@/components/semantic";
import { useScopeKeys } from "@/components/shell/use-hotkeys";
import { STATUS_MAP, type StatusValue } from "@/lib/enum-map";
import { canEnterState, enterableStates } from "@/lib/work-view";
import type { ResolvedWorkflowState } from "@/modules/work";

import { setPanelStateAction } from "./actions";

/**
 * The item panel's State property (UI.md §5.2 `S`) — the first
 * `<PropertyPicker>`, and the shape the rest of the rail's properties
 * take in the slices after it.
 *
 * ONE island owns the trigger, the key and the mutation together, which
 * is what lets `P E D` be three more of exactly this with no further
 * coordination: the key binding sits beside the state it mutates, so
 * there is no registry entry to keep in sync with a handler somewhere
 * else.
 *
 * It renders inside a SERVER component on two surfaces (the peek sheet
 * and the full item page), so every fact it needs is a REQUIRED prop —
 * a default here would be a shared component quietly disagreeing with
 * itself on one of the two.
 */
export function StateField({
  itemId,
  itemNumber,
  projectKey,
  surface,
  stateId,
  stateName,
  stateCategory,
  states,
  canEdit,
  canApprove,
}: {
  itemId: string;
  itemNumber: number;
  projectKey: string;
  /** Decides the MFA step-up return address — see `setPanelStateAction`. */
  surface: "board" | "backlog" | "page";
  stateId: string;
  stateName: string;
  stateCategory: string;
  states: readonly ResolvedWorkflowState[];
  canEdit: boolean;
  canApprove: boolean;
}) {
  const t = useTranslations("projects.item");
  const tCat = useTranslations("states.stateCategory");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [, startTransition] = useTransition();
  // The live region is ALWAYS mounted (a `role="status"` that appears
  // together with its text is never announced — a finding this codebase
  // has already paid for) but says NOTHING until a change has actually
  // happened. Rendering the past-tense sentence at rest would leave
  // "State changed to To do" standing in the accessibility tree of a
  // task nobody has touched, on every peek open.
  const [announced, setAnnounced] = useState("");

  // `useOptimistic` unwinds by itself when the transition ends, which is
  // why a failure below needs no manual revert — and why this is a
  // transition rather than a `<form action>`: React 19 RESETS a form
  // action at the start of every action, so a control inside one shows
  // stale server state (the standing trap).
  const [shown, setShown] = useOptimistic(
    { stateId, stateName, stateCategory },
    (_current, next: { stateId: string; stateName: string; stateCategory: string }) => next,
  );

  // ONE rule for every surface — the board's drops, the backlog's select
  // and this picker all ask `@/lib/work-view`, never a local predicate.
  const targets = useMemo(
    () => enterableStates(states, canApprove, stateId),
    [states, canApprove, stateId],
  );

  const options = useMemo<PickerOption<string>[]>(
    () =>
      targets.map((s) => ({
        value: s.id,
        label: s.name,
        group: tCat(s.category as StatusValue<"stateCategory">),
        icon: (
          <StatusIcon
            name={STATUS_MAP.stateCategory[s.category as StatusValue<"stateCategory">].icon}
            className="size-3 shrink-0"
            aria-hidden="true"
          />
        ),
        // The item's CURRENT state is always listed, and non-selectable
        // when it is not a legal target — TRIAGE, or a gated Done under
        // a non-approver. A picker that cannot show what the item IS is
        // broken (§5.2, and the residue the 2W-R review accepted).
        disabled: !canEnterState(s, canApprove),
        meta:
          s.id === shown.stateId ? <CheckIcon className="size-3.5" aria-hidden="true" /> : undefined,
        testId: `item-state-${s.category}`,
      })),
    [targets, canApprove, shown.stateId, tCat],
  );

  // Above the early return: a hook may not sit under a conditional. The
  // binding is DISABLED rather than absent when there is nothing to
  // choose, so `S` is swallowed here instead of falling through to the
  // board's "Move to…" underneath.
  useScopeKeys("item", [
    {
      key: "s",
      label: t("keys.state"),
      enabled: canEdit && options.some((o) => !o.disabled),
      run: () => setOpen(true),
    },
  ]);

  const commit = (next: string) => {
    setOpen(false);
    const target = targets.find((s) => s.id === next);
    // A no-op costs no round trip and tells no lie: the server would
    // also write nothing and return `changed: false`, but claiming
    // "saved" for a write that did not happen starts on the client.
    if (!target || next === shown.stateId) return;
    startTransition(async () => {
      setShown({ stateId: target.id, stateName: target.name, stateCategory: target.category });
      const r = await setPanelStateAction({
        itemId,
        stateId: next,
        projectKey,
        itemNumber,
        surface,
      }).catch(() => ({ ok: false as const, message: t("state.failed") }));
      // A failure must never look like a revert: the optimistic value
      // unwinds on its own, and the member is TOLD why.
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      // `changed: false` does NOT mean "nothing to do" — it means the
      // server disagreed with the props this panel rendered from,
      // because someone else had already moved the item there. Returning
      // early here let the optimistic value unwind to the STALE prop:
      // the member's pick appeared to revert, with no toast and no
      // refresh, and the panel stayed wrong until a full reload. That is
      // the standing "a failure must never look like a revert" trap in
      // its silent-success form, so both branches refresh.
      setShown({
        stateId: r.value.stateId,
        stateName: r.value.stateName,
        stateCategory: r.value.stateCategory,
      });
      setAnnounced(t("state.changed", { state: r.value.stateName }));
      // The canonical row REPLACES the optimistic slice (§7.2) by
      // re-rendering the server panel — which is also the only refresh
      // the item page gets, its `revalidatePath` form being a no-op.
      router.refresh();
    });
  };

  // Honest degradation: without `work_item:edit` — or in the unreachable
  // case of a project whose states were never seeded — the value is
  // still the value, just not a control.
  if (!canEdit || states.length === 0) return <>{shown.stateName}</>;

  const spec = STATUS_MAP.stateCategory[shown.stateCategory as StatusValue<"stateCategory">];

  return (
    <>
      <PropertyPicker
        open={open}
        onOpenChange={setOpen}
        value={shown.stateId}
        options={options}
        onSelect={commit}
        hintKey="S"
        testId="item-state"
        // The trigger carries the rest box's own `px-2.5`, which would
        // otherwise indent the State value 10px past every sibling
        // `<dd>` in the rail (§10.15 pattern 7).
        className="-ms-2.5"
        labels={{
          trigger: t("state.trigger", { state: shown.stateName }),
          search: t("state.search"),
          empty: t("state.empty"),
        }}
      >
        <StatusIcon name={spec.icon} className="size-3 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">{shown.stateName}</span>
      </PropertyPicker>
      <span role="status" aria-live="polite" className="sr-only">
        {announced}
      </span>
    </>
  );
}
