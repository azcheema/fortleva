"use client";

import { PlusIcon, TagIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";

import { PropertyPicker, type PickerOption } from "@/components/semantic";
import { useScopeKeys } from "@/components/shell/use-hotkeys";
import { Badge } from "@/components/ui/badge";
import { MAX_LABEL_NAME_LENGTH, compareLabelNames, labelNameKey, panelSurfaceOf } from "@/lib/work-view";
import type { LabelEntry, LabelVerb } from "@/modules/work";

import { createItemLabelAction, setItemLabelAction, type LabelsChanged } from "../backlog/actions";
import { usePanelCommit } from "./use-panel-commit";

/**
 * What the island shows: the task's labels, and the ONE change the
 * newest answer made, which is what the live region speaks. The change
 * travels WITH the value rather than in a ref beside it, so a superseded
 * answer that is announced later (use-panel-commit.tsx, the failure
 * branch) names ITS label and verb, never the newest pick's.
 */
type ShownLabels = {
  labels: LabelEntry[];
  last: { name: string; verb: LabelVerb } | null;
};

/** The derived row's value: a reserved prefix and the typed name, whitespace-free as `pickerRows` requires. */
const NEW = "new:";
const newValue = (name: string) => `${NEW}${encodeURIComponent(name)}`;
const newName = (value: string) => decodeURIComponent(value.slice(NEW.length));

const byName = (a: LabelEntry, b: LabelEntry) => compareLabelNames(a.name, b.name);
const sameIds = (a: readonly LabelEntry[], b: readonly LabelEntry[]) =>
  a.length === b.length && a.every((l, i) => l.id === b[i]!.id);

/** The three verbs are the three live-region keys — a literal map, because next-intl types its keys. */
const VERB_KEY = { added: "labels.added", removed: "labels.removed", created: "labels.created" } as const;

/** One element for every row: a fresh `<TagIcon>` per row per render is n elements for nothing. */
const tagIcon = <TagIcon className="size-3 shrink-0" aria-hidden="true" />;

/**
 * The item rail's Labels (UI.md §5.2 `L`): the first MULTI property, on
 * the shared `usePanelCommit` path, with the trigger, the key and the
 * actions in one island as `S A P E D V M` have them.
 *
 * MULTI, ON THE SINGLE-PICK CONTRACT. The picker commits ONE row and
 * closes, as for every other property; what a pick means here is a
 * TOGGLE of that one label. The rows are the vocabulary the task may
 * draw from (tenant-wide labels and this project's own), in ONE order,
 * name order, and every applied one is checked in place through the
 * picker's `selected` seam. `value` is null, so nothing is seeded on
 * open, a bare Enter is inert, and the member steers or types before
 * anything can commit — a checked row that Enter re-picked would be a
 * REMOVAL, not a no-op, which is why the empty-property rule's "current
 * row first" cannot apply to a set. There is no "No labels"/clear pair
 * for the same reason: every applied row is its own way off.
 *
 * ONE label per round trip means two members labelling the same task at
 * once never overwrite each other: the service adds or removes the one
 * label and answers with the whole list as it then stands, and that list
 * is what is shown.
 *
 * "Create “…”" is the typed row (the picker's `derive` seam), offered
 * only to a member who holds `label:manage` and only while no row already
 * has that name under the one key the database's index uses — one
 * transaction creates the label, audits `label.created` and puts it on
 * this task, so a member who may create but may not edit this task
 * creates nothing.
 */
export function LabelsField({
  itemId,
  itemNumber,
  projectKey,
  surface,
  applied,
  offered,
  canEdit,
  canCreate,
}: {
  itemId: string;
  itemNumber: number;
  projectKey: string;
  /** Decides the MFA step-up return address — see `panelSurfaceOf` / `itemReturnTo`. */
  surface: "board" | "backlog" | "page";
  /** REQUIRED — `getItemDetail`'s, by name. */
  applied: readonly LabelEntry[];
  /** REQUIRED — the vocabulary this task may draw from, by name; empty for a member who cannot edit. */
  offered: readonly LabelEntry[];
  canEdit: boolean;
  /** `label:manage` AND `canEdit`, folded by the panel — the typed row may coin a word and put it on this task. */
  canCreate: boolean;
}) {
  const t = useTranslations("projects.item");
  const [open, setOpen] = useState(false);

  // A stable canonical: a fresh object every render would make every memo
  // below dead and hand `useOptimistic` a new value each time.
  const canonical = useMemo<ShownLabels>(() => ({ labels: [...applied], last: null }), [applied]);
  const { shown, status, commit } = usePanelCommit<ShownLabels, LabelsChanged>({
    canonical,
    same: (a, b) => sameIds(a.labels, b.labels),
    adopt: (c) => ({ labels: c.labels, last: { name: c.label.name, verb: c.verb } }),
    announce: (v) => (v.last === null ? "" : t(VERB_KEY[v.last.verb], { name: v.last.name })),
    failedMessage: t("labels.failed"),
  });

  const appliedKey = shown.labels.map((l) => l.id).join("\u0000");
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the ids, which is what the set is
  const appliedIds = useMemo(() => new Set(shown.labels.map((l) => l.id)), [appliedKey]);

  // The ROWS: the vocabulary, plus any applied label the vocabulary does
  // not carry yet — a label coined a moment ago is on the task before the
  // refresh delivers it in `offered`, and it must be a row (to be taken
  // off again, and so the typed row does not offer to coin it twice).
  const rows = useMemo(() => {
    const seen = new Set(offered.map((l) => l.id));
    return [...offered, ...shown.labels.filter((l) => !seen.has(l.id))].sort(byName);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `shown.labels` by its ids, above
  }, [offered, appliedKey]);
  const nameKeys = useMemo(() => new Set(rows.map((l) => labelNameKey(l.name))), [rows]);

  // Whether this is a control at all follows the CANONICAL props, never
  // `shown` (milestone-field.tsx says why at length): a vocabulary to
  // pick from, or the right to add a word to it.
  const hasChoice = offered.length > 0 || canCreate;

  // Above the early return: a hook may not sit under a conditional. A
  // DISABLED binding swallows `L` rather than letting a lower scope have
  // it.
  useScopeKeys("item", [
    { key: "l", label: t("keys.labels"), enabled: canEdit && hasChoice, run: () => setOpen(true) },
  ]);

  // A gate that closes under an OPEN popover closes the popover too
  // (milestone-field.tsx): adjusted during render, never in an effect.
  if (open && (!canEdit || !hasChoice)) setOpen(false);

  const chips = (labels: readonly LabelEntry[]) =>
    labels.map((l) => (
      // Neutral, deliberately: `color` is a token name nothing writes yet,
      // and a chip is identity, never status (§10.4) — the name carries it.
      <Badge key={l.id} variant="outline" data-label={l.id}>
        {l.name}
      </Badge>
    ));

  // Honest degradation: without `work_item:edit`, or with nothing to
  // choose and no right to create, the labels are still the labels —
  // just not a control. `status` is rendered here too: the live region
  // is ALWAYS mounted.
  if (!canEdit || !hasChoice) {
    return (
      <>
        {shown.labels.length > 0 ? (
          <span className="flex flex-wrap gap-1">{chips(shown.labels)}</span>
        ) : (
          t("labels.none")
        )}
        {status}
      </>
    );
  }

  // Ordinals over the FULL row list, so a row's id never depends on which
  // labels this task happens to carry.
  const options: PickerOption<string>[] = rows.map((l, i) => ({
    value: l.id,
    label: l.name,
    icon: tagIcon,
    // A label whose create is still in flight is a row (checked, and so
    // the typed row does not offer to coin it twice) but not a target:
    // its id is provisional, and a pick would post it as a label id.
    disabled: l.id.startsWith(NEW),
    testId: `item-labels-${i}`,
  }));

  // The typed row: a NEW label with the typed name, for a member who may
  // create one, unless a row already has that name under the ONE name key
  // the index uses (`labelNameKey`: case, not diacritics — "Café" and
  // "Cafe" are two words) — that row is there to be picked. Null past the
  // name's bound, so the server's refusal is never offered as a row.
  const derive = (query: string): PickerOption<string> | null => {
    const name = query.trim();
    if (!canCreate || name.length > MAX_LABEL_NAME_LENGTH || nameKeys.has(labelNameKey(name))) return null;
    return {
      value: newValue(name),
      label: t("labels.create", { name }),
      icon: <PlusIcon className="size-3 shrink-0" aria-hidden="true" />,
      testId: "item-labels-create",
    };
  };

  const target = { itemId, projectKey, itemNumber, surface: panelSurfaceOf(surface) };

  const onSelect = (next: string) => {
    if (next.startsWith(NEW)) {
      const name = newName(next);
      // Shown at once under a provisional id the server's list replaces.
      const provisional: LabelEntry = { id: next, name, color: null };
      commit({ labels: [...shown.labels, provisional].sort(byName), last: { name, verb: "created" } }, () =>
        createItemLabelAction({ ...target, name }),
      );
      return;
    }
    const label = rows.find((l) => l.id === next);
    if (!label) return;
    const on = !appliedIds.has(next);
    const labels = on ? [...shown.labels, label].sort(byName) : shown.labels.filter((l) => l.id !== next);
    commit({ labels, last: { name: label.name, verb: on ? "added" : "removed" } }, () =>
      setItemLabelAction({ ...target, labelId: next, on }),
    );
  };

  const names = shown.labels.map((l) => l.name).join(", ");

  return (
    <>
      <PropertyPicker
        open={open}
        onOpenChange={setOpen}
        value={null}
        selected={appliedIds}
        options={options}
        onSelect={onSelect}
        derive={derive}
        hintKey="L"
        testId="item-labels"
        // Flush with the rail's other values (the rest box carries
        // `px-2.5`), and free to WRAP: a task may wear more chips than one
        // line holds, and a clipped chip is a label the member cannot see.
        className="-ms-2.5 h-auto min-h-8 flex-wrap py-1"
        labels={{
          trigger: shown.labels.length === 0 ? t("labels.triggerEmpty") : t("labels.trigger", { names }),
          // The field promises only what the picker will offer: "create"
          // to a member who may, and — with no vocabulary yet — an empty
          // state that says how, rather than "No matching label." under
          // a blank search box.
          search: canCreate ? t("labels.searchOrCreate") : t("labels.search"),
          empty: canCreate ? t("labels.emptyCreate") : t("labels.empty"),
          current: t("labels.applied"),
        }}
      >
        {shown.labels.length > 0 ? (
          chips(shown.labels)
        ) : (
          <span className="text-muted-foreground" data-value="">
            {t("labels.none")}
          </span>
        )}
      </PropertyPicker>
      {status}
    </>
  );
}
