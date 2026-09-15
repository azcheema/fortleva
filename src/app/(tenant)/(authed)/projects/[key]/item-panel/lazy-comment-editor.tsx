"use client";

import dynamic from "next/dynamic";

/**
 * The comment editor, loaded on DEMAND — for the same reason the
 * description editor is (description-field.tsx): the panel is reachable
 * from the board and the backlog, and a static import puts Tiptap in
 * those routes' client graph. ONE lazy binding shared by the composer
 * and the in-place edit, so the chunk is one chunk.
 *
 * `ssr: false` costs nothing: the editor sets `immediatelyRender:
 * false`, so it renders nothing on the server by design.
 */
export const LazyCommentEditor = dynamic(
  () => import("@/components/rich-text/comment-editor").then((m) => m.CommentEditor),
  {
    ssr: false,
    // Reserves the editor's own height so the section does not jump when
    // the chunk lands: the same box as the real thing.
    loading: () => <div className="min-h-16 rounded-md border border-input bg-card" aria-hidden />,
  },
);
