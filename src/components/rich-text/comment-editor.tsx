"use client";

import { Placeholder } from "@tiptap/extensions";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef } from "react";

import { Button } from "@/components/ui/button";
import { ESCAPE_LOCAL_ATTR } from "@/components/ui/escape-local";
import { Pending } from "@/components/semantic/field";
import { commentExtensions } from "@/lib/rich-text/extensions";
import { cn } from "@/lib/utils";

import { EditorToolbar, markStates, toolbarMarks, type MarkKey } from "./editor-toolbar";

/**
 * The comment editor (UI.md §5.6, panel slice 10): one editing surface
 * for the composer and for editing a posted comment in place. Unlike
 * the description it does NOT save itself — a comment is posted on
 * purpose (`⌘Enter`, or the button), and until then it is the member's
 * draft, kept here. It knows nothing about the route: the caller hands
 * it `onSubmit`, which answers whether the text may be cleared (a post
 * that landed) or must stay (a refusal — a failed action must never
 * look like a revert, and retyping a lost comment is the worst of
 * both).
 *
 * `⌘Enter` posts from inside the text (§6, `item` scope: the one key
 * the composer owns), handled in ProseMirror's own keymap so no newline
 * is inserted first. Escape belongs to the caller ONLY when there is
 * something to cancel (`onCancel`, the in-place edit): then the wrapper
 * marks itself `data-escape-local` so the sheet's layer lets the key
 * through (the standing trap, `escape-local.ts`), and handles it for
 * every element inside — the text through the keymap, the toolbar and
 * the buttons through the wrapper's own handler. With no `onCancel`
 * the marker is absent and Escape does what it does everywhere in the
 * peek: closes it.
 *
 * `footerStart` is where the composer's two-mode toggle goes: the
 * editor owns the buttons because only it knows whether there is
 * anything to post (`empty` disables the verb — an empty comment is
 * refused server-side as COMMENT_EMPTY, and a button that cannot
 * succeed should not be pressable). The options Tiptap compares by
 * reference (`extensions`, `editorProps`) are memoised: rebuilt every
 * render, Tiptap re-applied them to the view on every keystroke.
 */
const COMMENT_MARKS: readonly MarkKey[] = ["bold", "italic", "strike", "code", "bulletList", "orderedList"];

export function CommentEditor({
  initialDoc,
  placeholder,
  ariaLabel,
  ariaDescribedBy,
  toolbarLabel,
  submitLabel,
  cancelLabel,
  busy,
  autoFocus = false,
  onSubmit,
  onCancel,
  footerStart,
  testId,
}: {
  /** The document to start from — null for a fresh composer. */
  initialDoc: unknown;
  placeholder: string;
  ariaLabel: string;
  /** The id of the sentence that says who will see the words (the composer's hint). */
  ariaDescribedBy?: string;
  /** The toolbar's accessible name — per surface, so two editors on one panel are told apart. */
  toolbarLabel: string;
  submitLabel: string;
  cancelLabel?: string;
  /** The submit is in flight: the verb is disabled and the text stays. */
  busy: boolean;
  autoFocus?: boolean;
  /** Resolves true when the text may be cleared (it landed); false keeps it. */
  onSubmit: (doc: unknown) => Promise<boolean>;
  onCancel?: () => void;
  footerStart?: React.ReactNode;
  testId: string;
}) {
  const t = useTranslations("richText");
  const tCommon = useTranslations("common");
  // The newest handlers, read by ProseMirror's keymap (bound once).
  const submitRef = useRef<() => void>(() => {});
  const cancelRef = useRef<(() => void) | undefined>(onCancel);

  // Placeholder is CLIENT-ONLY on purpose: it adds no node and no mark,
  // so the schema the server validates against (commentExtensions)
  // stays exactly the schema the browser edits with.
  const extensions = useMemo(() => [...commentExtensions(), Placeholder.configure({ placeholder })], [placeholder]);
  const editorProps = useMemo(
    () => ({
      attributes: {
        class: "prose-body min-h-16 px-3 py-2 focus-visible:outline-none",
        "data-testid": testId,
        "aria-label": ariaLabel,
        ...(ariaDescribedBy ? { "aria-describedby": ariaDescribedBy } : {}),
      },
      handleKeyDown: (_view: unknown, event: KeyboardEvent) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          submitRef.current();
          return true;
        }
        if (event.key === "Escape" && cancelRef.current) {
          event.preventDefault();
          cancelRef.current();
          return true;
        }
        return false;
      },
    }),
    [testId, ariaLabel, ariaDescribedBy],
  );

  const editor = useEditor({
    extensions,
    content: (initialDoc as object | null) ?? undefined,
    // SSR: render nothing on the server rather than a mismatched tree.
    immediatelyRender: false,
    autofocus: autoFocus ? "end" : false,
    editorProps,
  });

  useEffect(() => {
    cancelRef.current = onCancel;
  }, [onCancel]);

  /**
   * The document as JSON the server action can actually carry:
   * ProseMirror builds attributes with `Object.create(null)`, which
   * React's serialiser cannot encode (the standing trap).
   */
  const submit = async () => {
    if (!editor || editor.isEmpty || busy) return;
    const payload: unknown = JSON.parse(JSON.stringify(editor.getJSON()));
    const clear = await onSubmit(payload);
    // `clearContent(true)` emits an update, so `empty` follows by itself.
    if (clear) editor.commands.clearContent(true);
  };
  useEffect(() => {
    submitRef.current = () => void submit();
  });

  // ONE selector for everything the render reads off the editor (the
  // React Compiler memoises on the stable `editor` reference, so plain
  // reads in the body would go stale).
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => (e ? { marks: markStates(e, COMMENT_MARKS), empty: e.isEmpty } : null),
  });
  const empty = state?.empty ?? true;

  return (
    <div
      className="flex flex-col gap-2"
      {...(onCancel ? { [ESCAPE_LOCAL_ATTR]: "" } : {})}
      onKeyDown={(e) => {
        // The toolbar and the buttons: the keymap above never sees them.
        if (e.key === "Escape" && cancelRef.current && !e.defaultPrevented) {
          e.preventDefault();
          cancelRef.current();
        }
      }}
    >
      <EditorToolbar
        label={toolbarLabel}
        marks={toolbarMarks(editor, COMMENT_MARKS, state?.marks ?? null, (key) => t(`format.${key}`))}
      />
      <div
        className={cn(
          // The same boundary and ground every other text control wears;
          // an OUTLINE, never a box-shadow, so the peek's scroller cannot
          // clip it (UI.md §9).
          "rounded-md border border-input bg-card",
          "focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-ring",
        )}
      >
        <EditorContent editor={editor} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">{footerStart}</div>
        <div className="flex items-center gap-2">
          {onCancel && cancelLabel ? (
            <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
              {cancelLabel}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            onClick={() => void submit()}
            disabled={busy || empty}
            data-testid={`${testId}-submit`}
          >
            {busy ? <Pending label={tCommon("loading")} /> : submitLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
