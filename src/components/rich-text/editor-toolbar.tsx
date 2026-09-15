"use client";

import type { Editor } from "@tiptap/core";
import {
  BoldIcon,
  CheckSquareIcon,
  CodeIcon,
  ItalicIcon,
  ListIcon,
  ListOrderedIcon,
  StrikethroughIcon,
  type LucideIcon,
} from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * The rich-text toolbar, shared by the description editor and the
 * comment editor (panel slice 10) so the two cannot drift into two
 * toolbars — and WHAT EACH BUTTON DOES is shared too (`MARK_SPECS`):
 * the icon, the command and the active-state probe per mark are one
 * table, and an editor picks the KEYS it offers (a comment has no
 * checklist). One tab stop with arrow keys inside it, not seven tab
 * stops on the way to the text (WAI-ARIA `toolbar`), each button a
 * toggle whose `aria-pressed` is the mark's state. The caller reads
 * that state through `useEditorState` with `markStates` as the
 * selector — the React Compiler memoises on the stable `editor`
 * reference, so a plain `editor.isActive()` in a render body renders a
 * toolbar that stops updating.
 */
export type MarkKey = "bold" | "italic" | "strike" | "code" | "bulletList" | "orderedList" | "taskList";

type MarkSpec = {
  readonly icon: LucideIcon;
  /** The Tiptap node/mark name `isActive` is asked about. */
  readonly active: string;
  readonly toggle: (editor: Editor) => void;
};

export const MARK_SPECS: Readonly<Record<MarkKey, MarkSpec>> = {
  bold: { icon: BoldIcon, active: "bold", toggle: (e) => e.chain().focus().toggleBold().run() },
  italic: { icon: ItalicIcon, active: "italic", toggle: (e) => e.chain().focus().toggleItalic().run() },
  strike: { icon: StrikethroughIcon, active: "strike", toggle: (e) => e.chain().focus().toggleStrike().run() },
  code: { icon: CodeIcon, active: "code", toggle: (e) => e.chain().focus().toggleCode().run() },
  bulletList: { icon: ListIcon, active: "bulletList", toggle: (e) => e.chain().focus().toggleBulletList().run() },
  orderedList: {
    icon: ListOrderedIcon,
    active: "orderedList",
    toggle: (e) => e.chain().focus().toggleOrderedList().run(),
  },
  taskList: { icon: CheckSquareIcon, active: "taskList", toggle: (e) => e.chain().focus().toggleTaskList().run() },
};

export type MarkStates = Partial<Record<MarkKey, boolean>>;

/** The `useEditorState` selector body: which of `keys` is active in `editor`. */
export function markStates(editor: Editor | null, keys: readonly MarkKey[]): MarkStates | null {
  if (!editor) return null;
  const out: MarkStates = {};
  for (const key of keys) out[key] = editor.isActive(MARK_SPECS[key].active);
  return out;
}

export type ToolbarMark = {
  readonly key: MarkKey;
  readonly icon: LucideIcon;
  /** Translated accessible name. */
  readonly label: string;
  readonly active: boolean;
  readonly run: () => void;
};

/** The toolbar's rows for `keys`, labelled by the caller's catalogue. */
export function toolbarMarks(
  editor: Editor | null,
  keys: readonly MarkKey[],
  active: MarkStates | null,
  label: (key: MarkKey) => string,
): ToolbarMark[] {
  return keys.map((key) => ({
    key,
    icon: MARK_SPECS[key].icon,
    label: label(key),
    active: active?.[key] ?? false,
    run: () => {
      if (editor) MARK_SPECS[key].toggle(editor);
    },
  }));
}

export function EditorToolbar({ label, marks }: { label: string; marks: readonly ToolbarMark[] }) {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [roving, setRoving] = useState(0);
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const last = marks.length - 1;
    const next =
      e.key === "ArrowRight" ? (roving === last ? 0 : roving + 1)
      : e.key === "ArrowLeft" ? (roving === 0 ? last : roving - 1)
      : e.key === "Home" ? 0
      : e.key === "End" ? last
      : -1;
    if (next < 0) return;
    e.preventDefault();
    setRoving(next);
    toolbarRef.current?.querySelectorAll("button")[next]?.focus();
  };

  return (
    <div ref={toolbarRef} className="flex flex-wrap gap-1" role="toolbar" aria-label={label} onKeyDown={onKeyDown}>
      {marks.map(({ key, icon: Icon, label: name, active, run }, i) => (
        <Button
          key={key}
          type="button"
          size="icon-sm"
          variant={active ? "secondary" : "ghost"}
          aria-pressed={active}
          aria-label={name}
          tabIndex={i === roving ? 0 : -1}
          onFocus={() => setRoving(i)}
          onClick={run}
        >
          <Icon />
        </Button>
      ))}
    </div>
  );
}
