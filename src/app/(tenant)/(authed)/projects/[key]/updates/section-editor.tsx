"use client";

import { Placeholder } from "@tiptap/extensions";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef } from "react";

import { EditorToolbar, markStates, toolbarMarks, type MarkKey } from "@/components/rich-text/editor-toolbar";
import { PasteFormatting } from "@/components/rich-text/paste-formatting";
import { TableMenu } from "@/components/rich-text/table-menu";
import { descriptionExtensions } from "@/lib/rich-text/extensions";
import { cn } from "@/lib/utils";

const SECTION_MARKS: readonly MarkKey[] = ["bold", "italic", "strike", "code", "bulletList", "orderedList", "taskList"];

/**
 * Nothing typed and nothing made. Tiptap's `isEmpty` reads a table of empty
 * cells — or a checklist of empty items — as empty, so a table just inserted
 * was sent as "no section" and gone after a reload (slice 132's re-check,
 * NIT-1); the normaliser keeps both, and the publish gate still refuses a
 * post that says nothing (`normalizeUpdateBody`'s text).
 */
export function isBlank(editor: Editor): boolean {
  if (!editor.isEmpty) return false;
  let made = false;
  editor.state.doc.descendants((node) => {
    if (node.type.name === "table" || node.type.name === "taskItem") made = true;
    return !made;
  });
  return !made;
}

/**
 * ONE SECTION OF THE COMPOSER — the description's schema (headings,
 * lists, checklists) in a small box with the shared toolbar. No submit,
 * no autosave: the composer owns saving, and this reports every change
 * upward as the document's JSON, already round-tripped through
 * `JSON.parse(JSON.stringify(…))` so it can cross a server action
 * (AGENTS.md's ProseMirror trap: node attrs are null-prototype objects
 * React's serialiser refuses).
 *
 * `onEditor` hands the live editor up once, for the pull-in panel:
 * "Add to Done" inserts a list into THIS editor rather than
 * re-rendering it from state, which would throw the caret away.
 */
export function SectionEditor({
  id,
  initialDoc,
  placeholder,
  ariaLabel,
  toolbarLabel,
  onChange,
  onEditor,
  testId,
}: {
  id: string;
  initialDoc: unknown;
  placeholder: string;
  ariaLabel: string;
  toolbarLabel: string;
  onChange: (doc: unknown | null) => void;
  onEditor?: (editor: Editor | null) => void;
  testId: string;
}) {
  const t = useTranslations("richText");
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  // `PasteFormatting` is client-only (slice 132): no node, no mark.
  const extensions = useMemo(
    () => [...descriptionExtensions(), Placeholder.configure({ placeholder }), PasteFormatting],
    [placeholder],
  );
  const editorProps = useMemo(
    () => ({
      attributes: {
        id,
        class: "prose-body min-h-20 px-3 py-2 focus-visible:outline-none",
        "data-testid": testId,
        "aria-label": ariaLabel,
      },
    }),
    [id, testId, ariaLabel],
  );

  const editor = useEditor({
    extensions,
    content: (initialDoc as object | null) ?? undefined,
    immediatelyRender: false,
    editorProps,
    onUpdate: ({ editor: e }) => {
      onChangeRef.current(isBlank(e) ? null : JSON.parse(JSON.stringify(e.getJSON())));
    },
  });

  useEffect(() => {
    onEditor?.(editor);
    return () => onEditor?.(null);
  }, [editor, onEditor]);

  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => (e ? { marks: markStates(e, SECTION_MARKS) } : null),
  });

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1">
        <EditorToolbar
          label={toolbarLabel}
          marks={toolbarMarks(editor, SECTION_MARKS, state?.marks ?? null, (key) => t(`format.${key}`))}
        />
        {/* Never `${testId}-…`: `update-layouts.spec` reads the sections by the
            `update-section-` prefix, and a menu sharing it read as a section. */}
        <TableMenu editor={editor} testId={`table-menu-${testId}`} />
      </div>
      <div
        className={cn(
          "rounded-md border border-input bg-card",
          "focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-ring",
        )}
      >
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
