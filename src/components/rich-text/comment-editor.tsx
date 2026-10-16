"use client";

import { Extension } from "@tiptap/core";
import { Placeholder } from "@tiptap/extensions";
import { PluginKey } from "@tiptap/pm/state";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { Suggestion } from "@tiptap/suggestion";
import { useTranslations } from "next-intl";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Pending } from "@/components/semantic/field";
import { commentExtensions } from "@/lib/rich-text/extensions";
import { MENTION_NODE } from "@/lib/rich-text/mention-node";
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
 * is inserted first. Escape belongs to the editor ONLY when there is
 * something to close or cancel — an open @ list, or `onCancel` (the
 * in-place edit) — and it is taken at the WINDOW's capture phase for every
 * element inside (the text, the toolbar, the buttons), before the sheet's
 * layer and before ProseMirror, which ignores an already-prevented event
 * (the listener's comment says why `data-escape-local` cannot serve an
 * editor). With neither, Escape does what it does everywhere in the peek:
 * closes it.
 *
 * `footerStart` is where the composer's two-mode toggle goes: the
 * editor owns the buttons because only it knows whether there is
 * anything to post (`empty` disables the verb — an empty comment is
 * refused server-side as COMMENT_EMPTY, and a button that cannot
 * succeed should not be pressable). The options Tiptap compares by
 * reference (`extensions`, `editorProps`) are memoised: rebuilt every
 * render, Tiptap re-applied them to the view on every keystroke.
 *
 * @MENTIONS (slice 125, founder decision C101; `mentions` given). `@` at
 * the start of a line or after a space opens a list of the teammates who
 * may be mentioned — loaded once, on the first `@`, through the caller's
 * `load` (again on a fresh `@` after a failed load) — filtered by what
 * follows. The list sits IN THE FLOW under the
 * field, never a floating layer (a popover inside the peek's scroller runs
 * off a phone — the standing trap — and the section card clips anything
 * absolutely placed past its edge), and focus never leaves the text: ↑/↓ move,
 * Enter or Tab picks, Escape closes only the list (never the peek, never
 * the in-place edit — see above). The field carries the list attributes while it is
 * open (`aria-autocomplete`, `aria-controls`, `aria-activedescendant` —
 * never `aria-expanded`, which a textbox may not carry). `enabled` false
 * (Reply to client, or a client-visible comment)
 * turns the trigger off: a client never reads a teammate's name, and the
 * server refuses such a body anyway. A chip stores the member's id only;
 * the name it shows comes from `mentionNames` and the loaded list.
 */
const COMMENT_MARKS: readonly MarkKey[] = ["bold", "italic", "strike", "code", "bulletList", "orderedList"];

/** How many names the list shows at once — a narrower query is quicker than a scroll. */
const LIST_MAX = 8;

const MENTION_KEY = new PluginKey("mention");

export type MentionPerson = { readonly id: string; readonly name: string };

export type MentionConfig = {
  /** Whether `@` offers people right now (an internal note). */
  readonly enabled: boolean;
  /** The people who may be mentioned — called on the first `@`, and again on a fresh `@` after a failure. */
  readonly load: () => Promise<readonly MentionPerson[]>;
};

type ListState = {
  readonly items: readonly MentionPerson[];
  readonly index: number;
  readonly loading: boolean;
  /** The last load of the people failed — said, never shown as "no one matches". */
  readonly failed: boolean;
};

/** A name matches when it, or any word in it, starts with what was typed. */
function filterPeople(people: readonly MentionPerson[], query: string): MentionPerson[] {
  const q = query.trim().toLocaleLowerCase();
  if (q === "") return people.slice(0, LIST_MAX);
  return people
    .filter((p) => {
      const name = p.name.toLocaleLowerCase();
      return name.startsWith(q) || name.split(/\s+/).some((word) => word.startsWith(q));
    })
    .slice(0, LIST_MAX);
}

/**
 * What the `@` list needs between renders — the people, the names chips
 * show, the plugin's pick, the lit row — in a plain object the component
 * makes ONCE and the suggestion plugin calls into. Plain methods, never a
 * component or a hook: the React Compiler compiles neither (AGENTS.md's
 * module-binding trap), and the plugin runs outside React's render.
 */
class MentionBridge {
  private config: MentionConfig | undefined;
  private listener: ((next: ListState | null) => void) | null = null;
  private readonly names = new Map<string, string>();
  private people: Promise<MentionPerson[]> | null = null;
  private command: ((person: MentionPerson) => void) | null = null;
  private state: ListState | null = null;
  private lastFailed = false;

  /** The newest props, after every render. */
  update(
    config: MentionConfig | undefined,
    names: Readonly<Record<string, string | null>> | undefined,
    listener: (next: ListState | null) => void,
  ): void {
    this.config = config;
    this.listener = listener;
    for (const [id, name] of Object.entries(names ?? {})) {
      if (name) this.names.set(id, name);
    }
  }

  enabled(): boolean {
    return this.config?.enabled === true;
  }

  /** The name a chip shows while it is edited. */
  label(id: string | null): string {
    return (id ? this.names.get(id) : undefined) ?? "…";
  }

  /** The people — asked for once, on the first `@`; asked again after a failure. */
  load(): Promise<MentionPerson[]> {
    if (!this.people) {
      const config = this.config;
      this.people = (config ? config.load() : Promise.resolve([] as readonly MentionPerson[]))
        .then((people) => {
          this.lastFailed = false;
          for (const p of people) this.names.set(p.id, p.name);
          return [...people];
        })
        .catch(() => {
          // Said in the list (`failed`); asked again on the next `@` (`begin`),
          // never on every keystroke after this one.
          this.lastFailed = true;
          return [];
        });
    }
    return this.people;
  }

  /** A fresh `@`: a load that failed is asked again — once, here. */
  begin(): void {
    if (this.lastFailed) this.people = null;
  }

  remember(person: MentionPerson): void {
    this.names.set(person.id, person.name);
  }

  show(next: Omit<ListState, "failed"> | null, command: ((person: MentionPerson) => void) | null): void {
    this.state = next ? { ...next, failed: this.lastFailed } : null;
    this.command = command;
    this.listener?.(this.state);
  }

  current(): ListState | null {
    return this.state;
  }

  pick(person: MentionPerson): void {
    this.command?.(person);
  }

  /** ↑/↓ move, Enter or Tab picks; anything else is the editor's. */
  onKey(event: KeyboardEvent): boolean {
    const current = this.state;
    if (!current) return false;
    const count = current.items.length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (count === 0) return true;
      const step = event.key === "ArrowDown" ? 1 : -1;
      this.show({ ...current, index: (current.index + step + count) % count }, this.command);
      return true;
    }
    if ((event.key === "Enter" || event.key === "Tab") && count > 0) {
      const person = current.items[current.index];
      if (person) this.pick(person);
      return true;
    }
    return false;
  }
}

/**
 * The editor's extensions. Placeholder is CLIENT-ONLY on purpose: it adds
 * no node and no mark, so the schema the server validates against
 * (commentExtensions) stays exactly the schema the browser edits with;
 * `mentionLabel` is a render decision, not a schema one. The suggestion
 * PLUGIN adds no node either: the mention node is the schema's
 * (extensions.ts); this only offers people and inserts it.
 */
function buildExtensions(bridge: MentionBridge, placeholder: string, withMentions: boolean) {
  const base = [
    ...commentExtensions({ mentionLabel: (id) => bridge.label(id) }),
    Placeholder.configure({ placeholder }),
  ];
  if (!withMentions) return base;
  const suggestion = Extension.create({
    name: "mentionSuggestion",
    addProseMirrorPlugins() {
      return [
        Suggestion<MentionPerson, MentionPerson>({
          editor: this.editor,
          pluginKey: MENTION_KEY,
          char: "@",
          allow: () => bridge.enabled(),
          items: async ({ query }) => filterPeople(await bridge.load(), query),
          command: ({ editor, range, props }) => {
            bridge.remember(props);
            editor
              .chain()
              .focus()
              .insertContentAt(range, [
                { type: MENTION_NODE, attrs: { id: props.id } },
                { type: "text", text: " " },
              ])
              .run();
          },
          render: () => ({
            onStart: (props) => {
              bridge.begin();
              bridge.show({ items: props.items, index: 0, loading: props.loading }, props.command);
            },
            onUpdate: (props) => {
              const was = bridge.current();
              const index = was && was.index < props.items.length ? was.index : 0;
              bridge.show({ items: props.items, index, loading: props.loading }, props.command);
            },
            onExit: () => bridge.show(null, null),
            onKeyDown: ({ event }) => bridge.onKey(event),
          }),
        }),
      ];
    },
  });
  return [...base, suggestion];
}

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
  mentions,
  mentionNames,
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
  /** @mentions (slice 125) — absent, `@` is just a character. */
  mentions?: MentionConfig;
  /**
   * The names the document's existing chips show (member id → name) — apart
   * from `mentions`, so a member who may not list teammates still reads the
   * names in a note they edit.
   */
  mentionNames?: Readonly<Record<string, string | null>>;
  testId: string;
}) {
  const t = useTranslations("richText");
  const tCommon = useTranslations("common");
  // The newest handlers, read by ProseMirror's keymap (bound once).
  const submitRef = useRef<() => void>(() => {});
  const cancelRef = useRef<(() => void) | undefined>(onCancel);

  // The mention plumbing lives in ONE plain object made once (a class, not
  // refs): the suggestion plugin is built with the extensions and reads the
  // newest values when it runs, long after this render.
  const hasMentions = mentions !== undefined;
  const [bridge] = useState(() => new MentionBridge());
  const [list, setList] = useState<ListState | null>(null);
  const listId = useId();
  const listBoxRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bridge.update(mentions, mentionNames, setList);
  }, [bridge, mentions, mentionNames]);

  const extensions = useMemo(() => buildExtensions(bridge, placeholder, hasMentions), [bridge, placeholder, hasMentions]);

  const editorProps = useMemo(
    () => ({
      attributes: {
        class: "prose-body min-h-16 px-3 py-2 focus-visible:outline-none",
        "data-testid": testId,
        "aria-label": ariaLabel,
        ...(ariaDescribedBy ? { "aria-describedby": ariaDescribedBy } : {}),
        ...(hasMentions ? { "aria-autocomplete": "list" } : {}),
      },
      handleKeyDown: (_view: unknown, event: KeyboardEvent) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          submitRef.current();
          return true;
        }
        // Escape is NOT here: see the window-capture listener below.
        return false;
      },
    }),
    [testId, ariaLabel, ariaDescribedBy, hasMentions],
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
   * ESCAPE, TAKEN AT THE WINDOW'S CAPTURE PHASE — before the sheet's layer,
   * which listens on the document in capture, and before ProseMirror.
   * ProseMirror IGNORES any bubbling event that is already
   * `defaultPrevented` (`eventBelongsToView`), and the layer wrappers'
   * `data-escape-local` contract works by preventing the Escape so the
   * layer does not dismiss — so inside the peek no ProseMirror binding,
   * the suggestion plugin's own Escape included, ever saw the key (slice
   * 125, measured in a browser; the in-place edit's Escape-to-cancel had
   * been dead since slice 10 for the same reason). Here, first: an open @
   * list is closed (the plugin's own exit), else an in-place edit is
   * cancelled; either way the event is prevented, so the layer stays open
   * and nothing below acts on it twice. With neither, the key goes on to
   * the layer, which closes the peek as everywhere.
   */
  useEffect(() => {
    if (!editor) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const root = rootRef.current;
      if (!root || !(event.target instanceof Node) || !root.contains(event.target)) return;
      // An input method's own Escape (cancelling a composition) is the
      // IME's: nothing here acts on it — but it is PREVENTED, or the sheet's
      // layer (no composition guard of its own) would close the peek and
      // lose the draft (the fix review's LOW).
      if (event.isComposing || event.keyCode === 229) {
        event.preventDefault();
        return;
      }
      if (!editor.isInitialized) return;
      const view = editor.view;
      if (MENTION_KEY.getState(view.state)?.active) {
        event.preventDefault();
        view.dispatch(view.state.tr.setMeta(MENTION_KEY, { exit: true }));
        return;
      }
      if (cancelRef.current) {
        event.preventDefault();
        cancelRef.current();
      }
    };
    window.addEventListener("keydown", onEscape, true);
    return () => window.removeEventListener("keydown", onEscape, true);
  }, [editor]);

  // The list never outlives its reason: it closes AT ONCE when mentions are
  // turned off under it (the composer switched to "Reply to client" — a list
  // left open could still insert a teammate into a reply by a click: the
  // code review's LOW, which the server refuses anyway), and when focus
  // LEAVES THE EDITOR'S OWN BOX — watched as `focusout` on the box (it
  // bubbles), so a Tab to the mode toggle keeps it and the next Tab out of
  // the box closes it. Never mid-press: the list sits in the flow above the
  // footer, and collapsing it on the mouse-down pulled "Reply to client" up
  // from under the pointer so the click missed (measured in Chromium) — and
  // Safari and Firefox on macOS never focus a clicked button, so focus may
  // land on <body>. A focus change caused by a press that began inside the
  // box is therefore judged on the press's RELEASE, after its click has
  // landed. Leaving the window closes nothing (the `@` would come back
  // dismissed). Each check runs a moment after the event, when the new
  // focus is known. A pick never moves focus: the list acts on mouse DOWN,
  // prevented.
  const enabled = mentions?.enabled === true;
  useEffect(() => {
    const root = rootRef.current;
    if (!editor || !root) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pressInside = false;
    let judgeOnRelease = false;
    const exit = () => {
      if (!editor.isInitialized) return;
      const view = editor.view;
      if (MENTION_KEY.getState(view.state)?.active) view.dispatch(view.state.tr.setMeta(MENTION_KEY, { exit: true }));
    };
    const judge = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (!document.hasFocus() || root.contains(document.activeElement)) return;
        exit();
      }, 0);
    };
    const onFocusOut = () => {
      if (pressInside) {
        judgeOnRelease = true;
        return;
      }
      judge();
    };
    const onPointerDown = (event: PointerEvent) => {
      pressInside = event.target instanceof Node && root.contains(event.target);
      judgeOnRelease = false;
    };
    const onPointerEnd = () => {
      pressInside = false;
      if (judgeOnRelease) {
        judgeOnRelease = false;
        judge();
      }
    };
    if (!enabled) exit();
    root.addEventListener("focusout", onFocusOut);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointerup", onPointerEnd, true);
    window.addEventListener("pointercancel", onPointerEnd, true);
    return () => {
      root.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointerup", onPointerEnd, true);
      window.removeEventListener("pointercancel", onPointerEnd, true);
      if (timer) clearTimeout(timer);
    };
  }, [editor, enabled]);

  // The list attributes on the text while it is open — set on
  // the DOM, because ProseMirror owns that element and only leaves alone
  // the attributes it did not set itself.
  const active = list?.items[list.index] ?? null;
  const optionId = (index: number) => `${listId}-option-${index}`;
  useEffect(() => {
    if (!hasMentions || !editor?.isInitialized) return;
    // No `aria-expanded`: Tiptap's field is `role="textbox"`, where ARIA
    // does not allow it (the code review's NIT).
    const dom = editor.view.dom;
    if (list) dom.setAttribute("aria-controls", listId);
    else dom.removeAttribute("aria-controls");
    if (list && active) dom.setAttribute("aria-activedescendant", optionId(list.index));
    else dom.removeAttribute("aria-activedescendant");
  });

  // The list is under the field, which can be the last thing in a long
  // panel: bring it — and the lit row — into view, never scrolling more.
  const open = list !== null;
  const lit = list?.index ?? 0;
  useEffect(() => {
    if (!open) return;
    const box = listBoxRef.current;
    const row = box?.querySelector<HTMLElement>(`[data-index="${lit}"]`);
    (row ?? box)?.scrollIntoView({ block: "nearest" });
  }, [open, lit]);

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
    <div ref={rootRef} className="flex flex-col gap-2">
      <EditorToolbar
        label={toolbarLabel}
        marks={toolbarMarks(editor, COMMENT_MARKS, state?.marks ?? null, (key) => t(`format.${key}`))}
      />
      <div>
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
        {list ? (
          <div
            ref={listBoxRef}
            // IN THE FLOW, under the field: the section card clips anything
            // that overflows it, and a floating box would be cut at its edge.
            className="mt-1 max-h-60 overflow-y-auto rounded-card border border-border bg-popover p-1 text-sm text-popover-foreground"
            data-testid={`${testId}-mentions`}
            // A press anywhere in the list (its scrollbar too) keeps the
            // text focused, so the blur rule above never closes it mid-pick.
            onMouseDown={(e) => e.preventDefault()}
          >
            {list.items.length > 0 ? (
              <ul id={listId} role="listbox" aria-label={t("mention.list")} className="flex flex-col">
                {list.items.map((person, index) => (
                  <li
                    key={person.id}
                    id={optionId(index)}
                    role="option"
                    aria-selected={index === list.index}
                    data-index={index}
                    data-testid={`${testId}-mention-option`}
                    // Down, not click: the text keeps focus (and its caret)
                    // for the pick to land where the `@` was typed.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      bridge.pick(person);
                    }}
                    className={cn(
                      "cursor-pointer truncate rounded-sm px-2 py-1.5",
                      index === list.index && "bg-accent text-accent-foreground",
                    )}
                  >
                    {person.name}
                  </li>
                ))}
              </ul>
            ) : (
              <p id={listId} role="status" className="px-2 py-1.5 text-muted-foreground">
                {list.loading ? tCommon("loading") : list.failed ? t("mention.failed") : t("mention.none")}
              </p>
            )}
          </div>
        ) : null}
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
