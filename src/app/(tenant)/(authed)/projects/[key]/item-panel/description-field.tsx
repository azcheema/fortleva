"use client";

import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useMemo } from "react";

import type { ChecklistConvert } from "@/components/rich-text/description-editor";
import { useScopeKeys } from "@/components/shell/use-hotkeys";
import type { KeyBinding } from "@/lib/keymap";
import type { ItemSurface } from "@/lib/work-view";

import { createSubtaskAction, saveDescriptionAction } from "./actions";

/**
 * The route's binding between the generic editor and this project's
 * action. It exists so the editor stays a plain component (no route
 * knowledge, testable on its own) and the PANEL stays a server component
 * — a server component cannot hand a client one a closure, only a server
 * action, and this is where the two identifiers are bound to it.
 *
 * The editor is loaded on DEMAND, and that is not a micro-optimisation:
 * the panel is reachable from the board and the backlog, so a static
 * import puts Tiptap and ProseMirror in those routes' client graph.
 * Measured on a board with no `?item=` in the URL — no panel on screen,
 * no editor rendered — the browser still fetched **386 KB** of it. This
 * splits it off to the moment a panel actually renders.
 *
 * `ssr: false` costs nothing: the editor already sets
 * `immediatelyRender: false`, so it renders nothing on the server by
 * design (a ProseMirror tree built server-side hydrates mismatched).
 */
const DescriptionEditor = dynamic(
  () => import("@/components/rich-text/description-editor").then((m) => m.DescriptionEditor),
  {
    ssr: false,
    // Reserves the editor's own height, so the panel does not jump when
    // the chunk lands. Same label row and same box as the real thing.
    loading: () => <DescriptionSkeleton />,
  },
);

function DescriptionSkeleton() {
  const t = useTranslations("projects.item.description");
  return (
    <div className="flex flex-col gap-2" data-testid="description">
      <span className="eyebrow text-muted-foreground">{t("label")}</span>
      <div className="min-h-24 rounded-md border border-input bg-card" aria-hidden />
    </div>
  );
}

export function DescriptionField({
  itemId,
  itemNumber,
  projectId,
  projectKey,
  surface,
  doc,
  token,
  visibility,
  editable,
  childLevel,
  canCreate,
}: {
  itemId: string;
  /** The item's number — `⌘⇧O`'s create needs it for the MFA step-up return address. */
  itemNumber: number;
  /** The project's id — `⌘⇧O`'s create names it, as the Subtasks section's does. */
  projectId: string;
  projectKey: string;
  /** WHICH surface this panel is — the create's step-up return address. */
  surface: ItemSurface;
  doc: unknown;
  token: string;
  visibility: "INTERNAL" | "CLIENT_VISIBLE";
  editable: boolean;
  /**
   * What a child of this item WOULD be, or `null` when it can have none
   * (a Subtask is the lowest level) — the same `childTypeOf` answer the
   * Subtasks section is rendered on, so the key and the section agree by
   * construction.
   */
  childLevel: "TASK" | "SUBTASK" | null;
  /** `work_item:create` — the Subtasks add row's gate, and `⌘⇧O`'s. */
  canCreate: boolean;
}) {
  const t = useTranslations("projects.item.keys");
  const router = useRouter();

  /**
   * `⌘⇧O`'s create, bound here for the reason the save is: a server
   * component can hand a client one a server action, never a closure.
   * It goes through the SAME `createSubtaskAction` as the Subtasks
   * section's add row, so a child made from a checklist line lands
   * exactly as a typed one does, and `router.refresh()` is what puts it
   * in the section below — issued inside the editor's own transition,
   * which is where this is awaited.
   */
  const convert = useMemo<ChecklistConvert | null>(() => {
    if (!editable || !canCreate || !childLevel) return null;
    return {
      level: childLevel,
      run: async (title) => {
        const r = await createSubtaskAction({
          parentId: itemId,
          parentNumber: itemNumber,
          projectId,
          projectKey,
          surface,
          title,
        });
        if (!r.ok) return r;
        router.refresh();
        return { ok: true, value: { key: `${projectKey}-${r.value.number}` } };
      },
    };
  }, [editable, canCreate, childLevel, itemId, itemNumber, projectId, projectKey, surface, router]);

  /**
   * The `?` overlay's row and nothing more — `run: null`, because the
   * key is ProseMirror's (description-editor.tsx) and only the editor
   * knows which line the caret is in. Registered HERE rather than in the
   * editor because the editor is loaded on demand: a member who opens
   * the overlay before the chunk lands must still be told the key
   * exists.
   *
   * The registry holds ONE physical key per binding, so this row claims
   * `o` while advertising the chord — the same approximation the board's
   * `J or K` row makes. Nothing binds a bare `O`; if anything ever does,
   * dispatch is unaffected (a `run: null` binding is skipped, never
   * swallowed) and the overlay lists both rows, since a `run: null` row
   * claims no key there either (`overlaySections`).
   */
  const keys = useMemo<KeyBinding[]>(
    () => [
      {
        key: "o",
        label: t(`convert.${childLevel ?? "SUBTASK"}`),
        enabled: convert !== null,
        run: null,
        hint: ["mod", "Shift", "O"],
      },
    ],
    [t, childLevel, convert],
  );
  useScopeKeys("item", keys);

  return (
    <DescriptionEditor
      doc={doc}
      token={token}
      visibility={visibility}
      editable={editable}
      save={(next, baseToken) => saveDescriptionAction({ itemId, projectKey, doc: next, baseToken })}
      convert={convert}
    />
  );
}
