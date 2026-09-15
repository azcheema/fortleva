"use client";

import { Extension } from "@tiptap/core";
import { Placeholder } from "@tiptap/extensions";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { VisibilityBadge } from "@/components/visibility-badge";
import { checklistTargetAt, nodePosition } from "@/lib/rich-text/checklist";
import { descriptionExtensions } from "@/lib/rich-text/extensions";
import { cn } from "@/lib/utils";
import type { ActionResult } from "@/lib/server-actions";
import { MAX_TITLE_LENGTH } from "@/lib/work-view";

import { EditorToolbar, markStates, toolbarMarks, type MarkKey } from "./editor-toolbar";

/** The description offers the checklist; the comment does not (comment-editor.tsx). */
const DESCRIPTION_MARKS: readonly MarkKey[] = ["bold", "italic", "strike", "code", "bulletList", "orderedList", "taskList"];

/**
 * `⌘⇧O` — the focused checklist item becomes a subtask (UI.md §6, panel
 * slice 13) — lives in the EDITOR's own keymap, never in the shell
 * registry (`src/lib/keymap.ts`). Two reasons, and either one alone
 * would settle it: the registry is inert while an editable element has
 * focus, which is the only place this key can mean anything, and it
 * answers no chord but ⌘K. ProseMirror's keymap plugin runs on the
 * editor's own node and `preventDefault`s what it handles, so a
 * keystroke this takes never reaches the window dispatcher at all.
 *
 * BOTH SPELLINGS are registered. prosemirror-keymap looks the event up
 * as `Shift-Ctrl-O` — `event.key` is uppercase while Shift is held — and
 * reaches a `Mod-Shift-o` binding only through its `event.keyCode`
 * fallback, which is the path every Tiptap `Mod-Shift-…` shortcut
 * depends on and one that a layout with no ASCII keyCode does not have.
 * Registering the uppercase name too makes the direct lookup hit.
 *
 * It adds no node and no mark, so the schema the server validates
 * against stays exactly the schema the browser edits with — the rule
 * `extensions.ts` states for every client-only trimming, and the reason
 * this is declared here rather than there.
 */
const ConvertChecklistItem = Extension.create<{ onConvert: () => boolean }>({
  name: "convertChecklistItem",
  addOptions() {
    return { onConvert: () => false };
  },
  addKeyboardShortcuts() {
    return {
      "Mod-Shift-o": () => this.options.onConvert(),
      "Mod-Shift-O": () => this.options.onConvert(),
    };
  },
});

/**
 * What `⌘⇧O` does here, injected by the route (description-field.tsx) —
 * `null` where it cannot mean anything: a Subtask has no children of its
 * own, and a member without `work_item:create` may not make one.
 */
export type ChecklistConvert = {
  /** What a child of THIS item is — an Epic's are Tasks. The copy's key. */
  readonly level: "TASK" | "SUBTASK";
  /** Creates the child from the line's text; answers with its human key ("ACME-42"). */
  readonly run: (title: string) => Promise<ActionResult<{ key: string }>>;
};

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
 *    must be beside the writing, not inferred. `convert` is required for
 *    the same reason — "may this task have children, and may you make
 *    one" is a fact about the item, and a default would answer it for
 *    the caller.
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
  convert,
}: {
  doc: unknown;
  token: string;
  visibility: "INTERNAL" | "CLIENT_VISIBLE";
  editable: boolean;
  save: (doc: unknown, baseToken: string) => Promise<SaveResult>;
  /** REQUIRED — `null` is a real value: `⌘⇧O` is not offered here. */
  convert: ChecklistConvert | null;
}) {
  const t = useTranslations("projects.item.description");
  // The toolbar's words are shared with the comment editor (`richText`).
  const tRich = useTranslations("richText");
  const [, startTransition] = useTransition();
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  /** What `⌘⇧O` last did, for the ear — the eye sees the line go. */
  const [converted, setConverted] = useState("");
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
  /** One conversion in flight at a time — checked before anything else happens. */
  const convertingRef = useRef(false);
  /**
   * Whether the keystroke being handled right now is an OS auto-repeat.
   *
   * A Tiptap keyboard shortcut is handed `{ editor }` and never the
   * event, so `repeat` — the one fact that separates "pressed ⌘⇧O" from
   * "leant on ⌘⇧O" — is invisible to it. The editor view's OWN
   * `handleKeyDown` runs before every plugin keymap (`someProp` reads
   * `_props` first), so it records the fact and lets the keymap match as
   * usual. It matters here and almost nowhere else in an editor: every
   * other key repeats harmlessly, while this one creates a row in the
   * database per repeat and walks down the checklist doing it, because
   * the delete maps the caret onto the next item.
   */
  const repeatRef = useRef(false);
  /**
   * The editor is built ONCE, so the keymap extension cannot close over
   * this render's props. It calls through a ref that every commit
   * refreshes — the same arrangement `commitRef` uses.
   */
  const convertRef = useRef<() => boolean>(() => false);

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
      // `react-hooks/refs` reports the closure below as a ref read during
      // render, and it is right to be suspicious: that is how a component
      // renders stale values. It is not what happens here. The closure is
      // BUILT once, handed to a ProseMirror keymap, and CALLED only from a
      // keystroke — never while anything renders — which is the whole
      // reason it must be a ref: `useEditor` builds the editor once, so an
      // extension configured with this render's props would answer with
      // them forever.
      // eslint-disable-next-line react-hooks/refs
      ConvertChecklistItem.configure({ onConvert: () => convertRef.current() }),
    ],
    content: (doc as object | null) ?? EMPTY,
    editable,
    // SSR: render nothing on the server rather than a mismatched tree.
    immediatelyRender: false,
    editorProps: {
      // Records auto-repeat for `handleConvert` and handles nothing:
      // returning false leaves every key to the plugin keymaps, exactly
      // as before (see `repeatRef`).
      handleKeyDown: (_view, event) => {
        repeatRef.current = event.repeat;
        return false;
      },
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

  /**
   * `⌘⇧O`: the focused checklist item becomes a subtask.
   *
   * CREATE FIRST, THEN REMOVE THE LINE — and the description keeps
   * exactly ONE writer, this editor, as it always had. A server action
   * that did both in one transaction would be a second writer of the
   * field, carrying a base token while the editor's own autosave — two
   * seconds behind every keystroke, and ⌘⇧O is pressed right after
   * typing the line — is holding the same one. One of the two would be
   * refused as stale and the member told "someone else saved this
   * description" about their own typing. So the action creates the child
   * and nothing else; the removal is an ordinary edit here, flushed at
   * once rather than left to the idle timer.
   *
   * The failure shapes follow from that order, and they are the point of
   * it. A refused create changes NOTHING — the line is where it was, and
   * the toast says so. A failed save leaves the words on screen and the
   * field dirty, which is this editor's standing contract. The one state
   * the order cannot produce is a line that vanished into a subtask that
   * does not exist.
   */
  const handleConvert = (): boolean => {
    // Not offered here — hand the key back to the browser rather than
    // swallowing it on a surface that advertises nothing.
    if (!editor || !editable || !convert) return false;
    // ONE conversion per press. A held key is one press: the delete maps
    // the caret onto the next item, so without this a leant-on ⌘⇧O would
    // walk down the checklist minting a row per line. Silent, because a
    // repeat is not a decision anybody made.
    if (repeatRef.current) return true;
    // …and one at a time. A SECOND press while a create is in flight is a
    // decision, so it is answered — under a fixed id, so leaning on the
    // key cannot stack toasts.
    if (convertingRef.current) {
      toast.info(t("convert.busy"), { id: "description-convert-busy" });
      return true;
    }
    // Whatever the last conversion said is no longer true of this one.
    // The region is never cleared otherwise, and every outcome that
    // speaks through a toast would leave the old sentence sitting in the
    // DOM for a screen reader to browse to.
    setConverted("");
    const { from, to } = editor.state.selection;
    const target = checklistTargetAt(editor.state.doc, from, to, MAX_TITLE_LENGTH);
    if (target.kind === "tooLong") {
      toast.error(t("convert.tooLong", { max: MAX_TITLE_LENGTH }));
      return true;
    }
    // The two refusals that name what the line would have BECOME — and a
    // WorkItem is a Task in the UI, never an "item" (AGENTS.md's
    // vocabulary), so they are keyed by level like every other sentence
    // here.
    if (target.kind === "complex" || target.kind === "checked") {
      toast.error(t(`convert.${target.kind}.${convert.level}`));
      return true;
    }
    if (target.kind !== "ok") {
      // `none` included: a key this panel advertises answers for itself,
      // rather than falling through to whatever the browser makes of
      // ⌘⇧O (Firefox opens its bookmark library) in the middle of a
      // sentence.
      toast.error(t(`convert.${target.kind}`));
      return true;
    }
    convertingRef.current = true;
    const { node, title } = target;
    const level = convert.level;
    startTransition(async () => {
      const r = await convert.run(title).catch(() => null);
      convertingRef.current = false;
      if (r === null) {
        toast.error(t(`convert.failed.${level}`));
        return;
      }
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      const key = r.value.key;
      // The peek can be closed while the child is being created. The
      // child exists and the line was never removed, which is the same
      // honest state as "kept" — there is simply nobody left to tell.
      if (editor.isDestroyed) return;
      // Where that line is NOW, by identity (`nodePosition`) — which
      // answers both questions the round trip opened: where it moved to,
      // and whether it is still the line that was converted.
      const at = nodePosition(editor.state.doc, node);
      if (at < 0) {
        // Edited while the child was being created. It stays, and the
        // member is TOLD — a line left behind is easy to miss, and
        // deleting a sentence they have since rewritten is worse.
        //
        // The toast and nothing else: sonner's region is a live region
        // too, so writing the same sentence to both would have a screen
        // reader say it twice. ONE live surface per outcome — the eye
        // needs this one, because nothing else on screen shows it.
        toast.info(t(`convert.kept.${level}`, { key }));
        return;
      }
      const chain = editor.chain();
      // Focus goes back to the editor only if it is still there, or if it
      // is nowhere — a member who moved on to a picker while the child
      // was being created is not pulled back (the Subtasks add row's
      // rule). The delete itself needs no focus; the selection lives in
      // the editor's state either way.
      if (editor.isFocused || document.activeElement === null || document.activeElement === document.body) {
        chain.focus();
      }
      chain
        .command(({ tr }) => {
          // ProseMirror's `deleteRange` on the transform, NOT Tiptap's
          // command of the same name: Tiptap's is a plain `tr.delete`,
          // which leaves an empty `taskList` behind when the converted
          // line was its only item. This one widens the range over any
          // parent the delete fully covers, which is the rule wanted.
          tr.deleteRange(at, at + node.nodeSize);
          return true;
        })
        .run();
      // That edit scheduled the ordinary 2 s autosave. The line is gone
      // from the screen and the subtask already exists, so the document
      // goes now instead of after a pause the member did not ask for.
      if (timerRef.current) clearTimeout(timerRef.current);
      commitRef.current();
      // ONE live surface per outcome (see the `kept` branch). Under a
      // CLIENT_VISIBLE parent the child starts visible too (§3.1), and a
      // keystroke has no field to hang the Subtasks add row's hint on —
      // so that disclosure is a TOAST, which the member sees, rather than
      // an sr-only line only a screen reader would get. Everywhere else
      // the eye already has the answer: the line went and the row
      // arrived, and the region carries the new key for the ear.
      if (visibility === "CLIENT_VISIBLE") toast.info(t(`convert.doneVisible.${level}`, { key }));
      else setConverted(t(`convert.done.${level}`, { key }));
    });
    return true;
  };

  useEffect(() => {
    convertRef.current = handleConvert;
  });

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

  // The marks' state through ONE selector (editor-toolbar.tsx's table).
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => markStates(e, DESCRIPTION_MARKS),
  });

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
        <EditorToolbar
          label={tRich("toolbar.description")}
          marks={toolbarMarks(editor, DESCRIPTION_MARKS, active, (key) => tRich(`format.${key}`))}
        />
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

      {/* ALWAYS mounted: a status region that appears together with its
          text is never announced. It speaks what ⌘⇧O did — the eye sees
          the line go and the row arrive, the ear gets the new key. */}
      <span role="status" aria-live="polite" className="sr-only" data-testid="description-convert-status">
        {converted}
      </span>
    </div>
  );
}
