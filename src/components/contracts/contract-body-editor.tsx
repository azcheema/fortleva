"use client";

import { Placeholder } from "@tiptap/extensions";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { BracesIcon, ChevronDownIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef } from "react";

import { EditorToolbar, markStates, toolbarMarks, type MarkKey } from "@/components/rich-text/editor-toolbar";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { contractExtensions } from "@/lib/rich-text/extensions";
import { cn } from "@/lib/utils";
import { FILL_IN_KEYS, fillInToken } from "@/modules/contracts/fill-ins";

const CONTRACT_MARKS: readonly MarkKey[] = ["heading", "bold", "italic", "underline", "strike", "bulletList", "orderedList"];

/**
 * A CONTRACT'S TEXT, OR A TEMPLATE'S (Phase 4 slice 112) — the contract schema
 * (`contractExtensions`: no code, no checklist) in a document-sized box with
 * the shared toolbar plus a heading and underline. No submit, no autosave: the
 * page owns saving, and this reports every change upward as the document's
 * JSON, round-tripped through `JSON.parse(JSON.stringify(…))` so it can cross a
 * server action (AGENTS.md's ProseMirror trap).
 *
 * `fillIns` adds an "Insert fill-in" menu (the template editor's, C84 (e)):
 * each item puts its `{{key}}` token at the caret, unformatted — a token split
 * by formatting is never filled. The token is inserted AFTER the menu has
 * closed (`onCloseAutoFocus`, its focus return prevented), never from the
 * item's select: focusing the editor while the menu still held focus fought
 * Radix's focus handling, and the menu then would not open a second time (CI
 * run 38091780925, `contracts.spec.ts`). Non-modal, so nothing else on the page
 * is locked while it is open.
 */
export function ContractBodyEditor({
  id,
  initialDoc,
  placeholder,
  ariaLabel,
  onChange,
  fillIns,
  testId,
  readOnly = false,
}: {
  id: string;
  initialDoc: unknown;
  placeholder: string;
  ariaLabel: string;
  onChange: (doc: unknown | null) => void;
  fillIns: boolean;
  testId: string;
  readOnly?: boolean;
}) {
  const t = useTranslations("richText");
  const tFill = useTranslations("contracts.fillIns");
  const onChangeRef = useRef(onChange);
  /** The fill-in picked in the menu, put in once the menu has closed. */
  const pickedRef = useRef<(typeof FILL_IN_KEYS)[number] | null>(null);
  /** The menu closed by a press elsewhere: that press keeps its focus (Radix's own rule, which the prevented return skips). */
  const outsideRef = useRef(false);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  const extensions = useMemo(() => [...contractExtensions(), Placeholder.configure({ placeholder })], [placeholder]);
  const editorProps = useMemo(
    () => ({
      attributes: {
        id,
        class: "prose-body min-h-64 px-4 py-3 focus-visible:outline-none",
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
    editable: !readOnly,
    editorProps,
    onUpdate: ({ editor: e }) => {
      onChangeRef.current(e.isEmpty ? null : JSON.parse(JSON.stringify(e.getJSON())));
    },
  });

  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => (e ? { marks: markStates(e, CONTRACT_MARKS) } : null),
  });

  return (
    <div className="flex flex-col gap-1.5">
      {readOnly ? null : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <EditorToolbar
            label={t("toolbar.contract")}
            marks={toolbarMarks(editor, CONTRACT_MARKS, state?.marks ?? null, (key) => t(`format.${key}`))}
          />
          {fillIns ? (
            <DropdownMenu
              modal={false}
              onOpenChange={(open) => {
                // A fresh opening forgets a pick from an earlier one whose close
                // never completed (reopened during its exit animation).
                if (open) {
                  pickedRef.current = null;
                  outsideRef.current = false;
                }
              }}
            >
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="outline" size="sm" data-testid="insert-fill-in">
                  <BracesIcon aria-hidden="true" />
                  {tFill("insert")}
                  <ChevronDownIcon aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                onInteractOutside={() => {
                  outsideRef.current = true;
                }}
                onCloseAutoFocus={(e) => {
                  e.preventDefault();
                  const key = pickedRef.current;
                  const outside = outsideRef.current;
                  pickedRef.current = null;
                  outsideRef.current = false;
                  if (key) editor?.chain().focus().insertContent({ type: "text", text: fillInToken(key) }).run();
                  else if (!outside) editor?.commands.focus();
                }}
              >
                {FILL_IN_KEYS.map((key) => (
                  <DropdownMenuItem
                    key={key}
                    data-testid={`fill-in-${key}`}
                    onSelect={() => {
                      pickedRef.current = key;
                    }}
                  >
                    {tFill(`keys.${key}`)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      )}
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
