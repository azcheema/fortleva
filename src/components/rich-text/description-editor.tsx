"use client";

import { Placeholder } from "@tiptap/extensions";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { BoldIcon, CheckSquareIcon, CodeIcon, ItalicIcon, ListIcon, ListOrderedIcon, StrikethroughIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { VisibilityBadge } from "@/components/visibility-badge";
import { descriptionExtensions } from "@/lib/rich-text/extensions";
import { cn } from "@/lib/utils";
import type { ActionResult } from "@/lib/server-actions";

/**
 * The task description (ARC-19). Saves itself — on blur, 2 s after
 * typing stops, and on unmount — because a Save button on a field you
 * leave by clicking elsewhere is a field people lose work in (UI.md
 * rule 2).
 *
 * Five rules this component exists to keep:
 *  • Every render-time read of editor state goes through `useEditorState`.
 *    The React Compiler memoises on the stable `editor` reference, so a
 *    plain `editor.isActive()` in the body renders a toolbar that stops
 *    updating — and no lint rule catches it.
 *  • THE FIELD STAYS DIRTY UNTIL A SAVE IS KNOWN TO HAVE LANDED. Marking
 *    it clean when the request LEAVES is what turns a failed save into a
 *    revert: the sync effect below adopts the server's document the
 *    moment the editor is clean, so a 500 would quietly replace the
 *    member's words with the server's older ones.
 *  • Incoming props are IGNORED while the editor is focused or dirty, and
 *    a payload rendered BEFORE this editor's own last write is ignored
 *    even when it is clean (`caughtUp`) — the board's 12 s freshness poll
 *    re-renders this panel, and a description that reverts under the
 *    cursor is the "failure looks like a revert" trap in its worst form.
 *  • `visibility` is a REQUIRED prop, not a default: on a client-visible
 *    task every word typed here is visible to the client, so the badge
 *    must be beside the writing, not inferred.
 *  • The whole component is keyed by item id at the call site, so a panel
 *    reused for a DIFFERENT task can never carry the old task's text into
 *    the new one.
 */

type SaveResult = ActionResult<{ checklistTotal: number; checklistDone: number; token: string }>;

const EMPTY = { type: "doc", content: [{ type: "paragraph" }] } as const;
const IDLE_MS = 2000;

export function DescriptionEditor({
  doc,
  token,
  visibility,
  editable,
  save,
}: {
  doc: unknown;
  token: string;
  visibility: "INTERNAL" | "CLIENT_VISIBLE";
  editable: boolean;
  save: (doc: unknown, baseToken: string) => Promise<SaveResult>;
}) {
  const t = useTranslations("projects.item.description");
  const [, startTransition] = useTransition();
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  // Refs, not state: the token is what the NEXT save carries, and a
  // re-render must never take it backwards to the server's copy while
  // this editor owns the field.
  const tokenRef = useRef(token);
  /**
   * Dirtiness as two counters rather than a boolean. `edit` is bumped by
   * every keystroke batch; a save records the `edit` value it SENT and
   * only marks that value saved when the server confirms it. A save that
   * overlaps fresh typing therefore cannot mark the newer text clean.
   */
  const editSeqRef = useRef(0);
  const savedSeqRef = useRef(0);
  /**
   * False while the server has not yet echoed this editor's own last
   * write. A refresh payload rendered before that write carries an OLDER
   * token — different from ours, and adopting it would revert the save
   * we just made.
   */
  const caughtUpRef = useRef(true);
  /** One save at a time — see `commit`. */
  const inFlightRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const editor = useEditor({
    // Placeholder is CLIENT-ONLY on purpose: it adds no node and no mark,
    // so the schema the server validates against (descriptionExtensions)
    // stays exactly the schema the browser edits with — and the prompt
    // itself is a translated string, which has no business in a module
    // the server imports.
    extensions: [
      ...descriptionExtensions({
        // Named in the workspace's language, and by its own text — every
        // checkbox otherwise announces the same words (the text sits in a
        // sibling element, outside the label that names the input).
        checkboxLabel: (node) => t("checkboxLabel", { text: node.textContent.trim() || t("checkboxEmpty") }),
      }),
      Placeholder.configure({ placeholder: t("placeholder") }),
    ],
    content: (doc as object | null) ?? EMPTY,
    editable,
    // SSR: render nothing on the server rather than a mismatched tree.
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: "prose-body min-h-24 px-3 py-2 focus-visible:outline-none",
        "data-testid": "description-editor",
        "aria-label": t("label"),
      },
    },
  });

  /**
   * The document as JSON the server action can actually carry.
   * ProseMirror builds every node's attributes with `Object.create(null)`
   * and `toJSON()` hands that same null-prototype object out; React's
   * serialiser cannot encode it, so `attrs` crosses the wire as an opaque
   * reference and the normaliser rejects the document as INVALID_INPUT.
   * Only nodes that HAVE attributes are affected, which is why plain
   * paragraphs saved and every heading, link, ordered list, code block
   * and checklist did not.
   */
  const payload = (): unknown => JSON.parse(JSON.stringify(editor!.getJSON()));

  /** So a save that completes can start the one the typing behind it needs. */
  const commitRef = useRef<() => void>(() => {});

  const commit = useCallback(() => {
    if (!editor || editSeqRef.current === savedSeqRef.current) return;
    // ONE save at a time. Two overlapping saves would carry the SAME base
    // token — the field is still dirty until the first lands — so the
    // compare-and-set would refuse one of them and the member would be
    // told "someone else saved this description" about their own typing.
    // A blur two seconds into a save is the ordinary way to hit it.
    if (inFlightRef.current) return;
    const seq = editSeqRef.current;
    const base = tokenRef.current;
    const json = payload();
    inFlightRef.current = true;
    setStatus("saving");
    startTransition(async () => {
      try {
        const result = await save(json, base);
        if (!result.ok) {
          // The words stay on screen and the field stays DIRTY, so
          // nothing can replace them (standing trap). No retry loop: the
          // next keystroke or blur is what tries again.
          setStatus("failed");
          toast.error(result.message);
          return;
        }
        tokenRef.current = result.value.token;
        caughtUpRef.current = false;
        // Only the edit this save CARRIED is clean.
        savedSeqRef.current = seq;
        const stillTyping = editSeqRef.current !== seq;
        setStatus(stillTyping ? "idle" : "saved");
        // Whatever was typed while this was in flight never got a commit
        // of its own (the guard above turned it away), so start its one.
        if (stillTyping) {
          if (timerRef.current) clearTimeout(timerRef.current);
          timerRef.current = setTimeout(() => commitRef.current(), IDLE_MS);
        }
      } catch {
        // A rethrown server error or a dropped connection. Same rule: the
        // text is still the member's, and it is still unsaved.
        setStatus("failed");
        toast.error(t("saveFailed"));
      } finally {
        inFlightRef.current = false;
      }
    });
    // `payload` closes over `editor`, which is already a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, save, t]);

  useEffect(() => {
    commitRef.current = commit;
  }, [commit]);

  useEffect(() => {
    if (!editor) return;
    const onUpdate = () => {
      editSeqRef.current += 1;
      setStatus("idle");
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(commit, IDLE_MS);
    };
    const onBlur = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      commit();
    };
    editor.on("update", onUpdate);
    editor.on("blur", onBlur);
    return () => {
      editor.off("update", onUpdate);
      editor.off("blur", onBlur);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [editor, commit]);

  /**
   * Unmount is a save point, not a discard. Closing the side-peek with
   * Escape inside the 2 s window fires no blur, so without this the
   * member's last sentence is simply gone. Its own effect with an empty
   * dependency list, so the cleanup runs ONCE — hanging it off `commit`
   * would fire a save on every re-render instead.
   */
  const flushRef = useRef<() => void>(() => {});
  useEffect(() => {
    flushRef.current = () => {
      if (!editor || editSeqRef.current === savedSeqRef.current) return;
      // A save already on its way carries this editor's only valid base
      // token, so a second one here could only be refused. Let it land.
      if (inFlightRef.current) return;
      // Deliberately not through the transition: this component is going
      // away, so there is no state left to settle — only the request.
      void save(payload(), tokenRef.current).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, save]);
  useEffect(() => () => flushRef.current(), []);

  /**
   * Permission is a prop, and Tiptap reads `editable` only when it builds
   * the editor — so without this a member who loses `work_item:edit`
   * mid-session keeps a writable surface under a hidden toolbar.
   */
  useEffect(() => {
    if (editor && editor.isEditable !== editable) editor.setEditable(editable);
  }, [editor, editable]);

  // The panel re-renders on every poll tick. Take the server's document
  // ONLY when this editor has nothing of its own to lose, and only once
  // the server has caught up with this editor's own last write.
  useEffect(() => {
    if (!editor || editSeqRef.current !== savedSeqRef.current || editor.isFocused) return;
    if (token === tokenRef.current) {
      caughtUpRef.current = true;
      return;
    }
    if (!caughtUpRef.current) return; // a payload rendered before our write
    tokenRef.current = token;
    editor.commands.setContent((doc as object | null) ?? EMPTY, { emitUpdate: false });
  }, [doc, token, editor]);

  const active = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e
        ? {
            bold: e.isActive("bold"),
            italic: e.isActive("italic"),
            strike: e.isActive("strike"),
            code: e.isActive("code"),
            bulletList: e.isActive("bulletList"),
            orderedList: e.isActive("orderedList"),
            taskList: e.isActive("taskList"),
          }
        : null,
  });

  const marks = [
    { key: "bold", icon: BoldIcon, run: () => editor?.chain().focus().toggleBold().run() },
    { key: "italic", icon: ItalicIcon, run: () => editor?.chain().focus().toggleItalic().run() },
    { key: "strike", icon: StrikethroughIcon, run: () => editor?.chain().focus().toggleStrike().run() },
    { key: "code", icon: CodeIcon, run: () => editor?.chain().focus().toggleCode().run() },
    { key: "bulletList", icon: ListIcon, run: () => editor?.chain().focus().toggleBulletList().run() },
    { key: "orderedList", icon: ListOrderedIcon, run: () => editor?.chain().focus().toggleOrderedList().run() },
    { key: "taskList", icon: CheckSquareIcon, run: () => editor?.chain().focus().toggleTaskList().run() },
  ] as const;

  // A toolbar is ONE tab stop with arrow keys inside it, not seven tab
  // stops on the way to the text (WAI-ARIA `toolbar`).
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [roving, setRoving] = useState(0);
  const onToolbarKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
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
    <div className="flex flex-col gap-2" data-testid="description">
      <div className="flex flex-wrap items-center gap-2">
        <span className="eyebrow text-muted-foreground">{t("label")}</span>
        {visibility === "CLIENT_VISIBLE" ? <VisibilityBadge visibility={visibility} /> : null}
        <span
          aria-live="polite"
          className={cn("ms-auto text-xs", status === "failed" ? "text-destructive" : "text-muted-foreground")}
        >
          {status === "saving" ? t("saving") : status === "saved" ? t("saved") : status === "failed" ? t("notSaved") : null}
        </span>
      </div>

      {editable ? (
        <div
          ref={toolbarRef}
          className="flex flex-wrap gap-1"
          role="toolbar"
          aria-label={t("toolbar")}
          onKeyDown={onToolbarKeyDown}
        >
          {marks.map(({ key, icon: Icon, run }, i) => (
            <Button
              key={key}
              type="button"
              size="icon-sm"
              variant={active?.[key] ? "secondary" : "ghost"}
              aria-pressed={active?.[key] ?? false}
              aria-label={t(`format.${key}`)}
              tabIndex={i === roving ? 0 : -1}
              onFocus={() => setRoving(i)}
              onClick={run}
            >
              <Icon />
            </Button>
          ))}
        </div>
      ) : null}

      <div
        className={cn(
          // The same boundary and ground every other text control wears.
          // The focus ring is an OUTLINE with a negative offset, never a
          // box-shadow: the peek is an overflow-y-auto container and a
          // shadow ring is clipped by it (UI.md §9).
          "rounded-md border border-input bg-card",
          editable && "focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-ring",
        )}
      >
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
