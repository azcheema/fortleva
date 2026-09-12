"use client";

import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";

import { saveDescriptionAction } from "./actions";

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
  projectKey,
  doc,
  token,
  visibility,
  editable,
}: {
  itemId: string;
  projectKey: string;
  doc: unknown;
  token: string;
  visibility: "INTERNAL" | "CLIENT_VISIBLE";
  editable: boolean;
}) {
  return (
    <DescriptionEditor
      doc={doc}
      token={token}
      visibility={visibility}
      editable={editable}
      save={(next, baseToken) => saveDescriptionAction({ itemId, projectKey, doc: next, baseToken })}
    />
  );
}
