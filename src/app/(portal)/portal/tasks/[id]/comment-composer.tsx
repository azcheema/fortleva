"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { Field } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { PORTAL_COMMENT_MAX } from "@/modules/work/portal-comment-input";

import { postCommentAction } from "../../actions";

/**
 * THE CLIENT'S COMMENT BOX (Phase 3 slice 75; UI.md §5.6's contact half)
 * — plain text, one button, and the two facts the reader needs BEFORE
 * sending: the agency will read it, and it cannot be changed afterwards
 * (a contact's comment is an INSERT the census admits and nothing more —
 * no edit, no delete). There is no mode toggle: a contact's comment is
 * always one the client can see (UI.md §5.6, "contact-authored comments
 * have no toggle"), and it follows its task afterwards (C37).
 *
 * THE RULES `task-done.tsx` RECORDS APPLY UNCHANGED: no toast on this
 * plane, so a refusal renders in place as `role="alert"` and the words
 * STAY in the box (an action failure must never look like a success —
 * or like a lost comment); guarded on its own `busy`, never a
 * transition's `isPending` (AGENTS.md's standing trap — the action
 * revalidates the page, and the window is seconds); a rejected action is
 * caught, or `busy` would stay true for ever.
 *
 * NOT a `<form action>`: React 19 resets such a form at the start of
 * every action, which would empty the box before the server had said
 * whether the words were saved. `onSubmit` calls the action itself, and
 * the box empties only on the server's yes — when the revalidated page
 * already draws the comment above it. A result line in an sr-only
 * `status` region says so, because the new row appears silently.
 *
 * `⌘Enter` / `Ctrl+Enter` sends from inside the box, as the member's
 * composer does (UI.md §5.6). A handler on the textarea, not a key
 * binding: the portal has no keymap, and this key means nothing outside
 * the field.
 *
 * IT RENDERS UNDER A MEMBER SESSION TOO — `/view-as/tasks/[id]` draws it
 * inside `inert` — so everything is a prop and the action holds the
 * identity. The field's id is derived from the task, never `useId`, so
 * the byte comparison sees the same markup on both planes.
 */
export function PortalCommentComposer({ itemId }: { itemId: string }) {
  const t = useTranslations("portal.comments");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const fieldId = `portal-comment-${itemId}`;
  const empty = text.trim().length === 0;

  const submit = () => {
    if (busy || empty) return;
    setBusy(true);
    setError(null);
    setSent(false);
    void postCommentAction(itemId, text)
      .catch(() => ({ ok: false as const, message: t("failed") }))
      .then((r) => {
        setBusy(false);
        if (r.ok) {
          setText("");
          setSent(true);
          return;
        }
        setError(r.message);
      });
  };

  return (
    <form
      data-slot="portal-comment-composer"
      className="flex flex-col gap-2 border-t border-border pt-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Field label={t("label")} htmlFor={fieldId} hint={t("hint")}>
        <Textarea
          id={fieldId}
          rows={3}
          maxLength={PORTAL_COMMENT_MAX}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setSent(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={t("placeholder")}
          data-testid="portal-comment-input"
        />
      </Field>
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={busy || empty} data-testid="portal-comment-send">
          {busy ? t("sending") : t("send")}
        </Button>
      </div>
      <span role="status" aria-live="polite" className="sr-only">
        {sent ? t("sent") : null}
      </span>
      {error ? (
        // `alert`, NEVER `status`: a polite region can be dropped if the
        // reader has moved on, and this plane has no toast to fall back on.
        <p role="alert" className="text-xs text-(--tone-danger-fg)" data-testid="portal-comment-error">
          {error}
        </p>
      ) : null}
    </form>
  );
}
