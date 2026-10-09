"use client";

import { ShieldCheckIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { Field } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeCheckbox } from "@/components/ui/native-checkbox";
import { Textarea } from "@/components/ui/textarea";
import type { FormResult } from "@/lib/server-actions";

/** An action's answer; `codeChecked: false` when it refused before checking the code (a typo). */
export type ProtectedResult = FormResult & { readonly codeChecked?: boolean };

export type ProtectedField = {
  readonly name: string;
  readonly label: string;
  readonly kind: "text" | "textarea" | "checkbox";
  /** Identifiers read in the mono face (§10.7). */
  readonly mono?: boolean;
  readonly maxLength?: number;
  readonly hint?: string;
  /** Spans both columns. */
  readonly wide?: boolean;
  /** A text field's hint while it is empty (e.g. the VAT number an org. number implies). */
  readonly placeholder?: string;
};

export type ProtectedValues = Readonly<Record<string, string | boolean | null>>;

/** Next rejects a server action's promise with its redirect, then navigates by itself. */
const isRedirect = (e: unknown): boolean => {
  const digest = typeof e === "object" && e !== null ? (e as { digest?: unknown }).digest : undefined;
  return typeof digest === "string" && digest.startsWith("NEXT_REDIRECT");
};

/**
 * A CARD WHOSE VALUES EVERY INVOICE PRINTS (Phase 4 slice 107; founder
 * decisions C75 (h), (i), (j)) — the company details and the payment details
 * on Settings → Invoicing. Read as text; a member who may change them presses
 * "Change …" and gets one inline form holding every value AND a field for
 * their authenticator code — "their code at that moment": the action verifies
 * it and the service accepts a factor no older than a minute, so the code
 * typed at sign-in never counts. Every owner is mailed on save. A member with
 * no authenticator is offered the way to set one up instead of a form.
 *
 * A FORM WITH A SAVE BUTTON, on purpose (UI.md §5.10's recorded exception):
 * values that are one decision, guarded by a code, are one act. The fields
 * are controlled and sent from a submit handler, never a `<form action>`
 * (React 19 resets a form around its action, AGENTS.md), so a refusal keeps
 * everything typed — the code too when the refusal came before it was checked
 * (a typo); after a code was checked it is cleared, being spent or wrong. Only
 * the fields changed since the form opened are sent.
 * Buttons are `aria-disabled`, never `disabled` (a disabled focused button
 * drops focus to the page), and focus goes to the first field on open and
 * back to "Change …" on close.
 */
export function ProtectedCard({
  testId,
  fields,
  values,
  editable,
  hasFactor,
  changed,
  action,
  enrolHref,
  labels,
}: {
  testId: string;
  fields: readonly ProtectedField[];
  values: ProtectedValues;
  /** `settings:edit` on all four gates. */
  editable: boolean;
  /** The member has an authenticator to type a code from. */
  hasFactor: boolean;
  /** Who last changed this card, and when (from the audit trail). */
  changed: { readonly by: string | null; readonly at: string } | null;
  action: (values: Record<string, string | boolean | null>, code: string) => Promise<ProtectedResult>;
  /** Where "Set up an authenticator" goes — the enrolment notice, back here after. */
  enrolHref: string;
  labels: { readonly change: string; readonly formLabel: string; readonly formIntro: string; readonly save: string };
}) {
  const t = useTranslations("settings.invoicing.protected");
  const tCommon = useTranslations("common");
  const format = useFormatter();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string | boolean>>(() => draftOf(fields, values));
  /** The values as the form opened on them: only what the member changed since is sent. */
  const [opened, setOpened] = useState<Record<string, string | boolean>>(() => draftOf(fields, values));
  const [code, setCode] = useState("");
  const [pending, start] = useTransition();
  const firstRef = useRef<HTMLElement | null>(null);
  const changeRef = useRef<HTMLButtonElement>(null);
  const codeId = `${testId}-code`;

  const openForm = () => {
    setDraft(draftOf(fields, values));
    setOpened(draftOf(fields, values));
    setCode("");
    setOpen(true);
    // After the form mounts: its first field (never `autoFocus`, AGENTS.md).
    requestAnimationFrame(() => firstRef.current?.focus());
  };

  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => changeRef.current?.focus());
  };

  const save = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (pending) return;
    // Only the fields changed since the form opened: a colleague's save in
    // between is never written back over (the fix-pass review's low).
    const edited = fields.filter((f) => {
      const a = draft[f.name];
      const b = opened[f.name];
      return typeof a === "string" && typeof b === "string" ? a.trim() !== b.trim() : a !== b;
    });
    if (edited.length === 0) {
      // Nothing to save, so no code is spent on it.
      toast.message(t("nothingChanged"));
      close();
      return;
    }
    const payload = Object.fromEntries(
      edited.map((f) => {
        const v = draft[f.name];
        return [f.name, typeof v === "boolean" ? v : (v ?? "").trim() === "" ? null : (v as string)];
      }),
    );
    start(async () => {
      let r: ProtectedResult;
      try {
        r = await action(payload, code);
      } catch (err) {
        if (isRedirect(err)) return;
        toast.error(t("unreachable"));
        return;
      }
      if (!r.ok) {
        // A refusal answered before the code was checked (a typo) leaves the
        // code where it is; otherwise it is spent or wrong.
        if (r.codeChecked !== false) setCode("");
        toast.error(r.message);
        return;
      }
      toast.success(r.message);
      close();
      router.refresh();
    });
  };

  const resting = (f: ProtectedField) => {
    const v = values[f.name];
    if (f.kind === "checkbox") return v ? tCommon("yes") : tCommon("no");
    if (typeof v === "string" && v !== "") return v;
    return null;
  };

  return (
    <div className="flex flex-col gap-4" data-testid={testId}>
      {!open ? (
        <>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
            {fields.map((f) => {
              const text = resting(f);
              return (
                <div key={f.name} className={f.wide ? "flex min-w-0 flex-col gap-0.5 sm:col-span-2" : "flex min-w-0 flex-col gap-0.5"}>
                  <dt className="text-xs text-muted-foreground">{f.label}</dt>
                  <dd
                    data-field={f.name}
                    className={
                      f.kind === "textarea"
                        ? "min-w-0 text-sm whitespace-pre-line"
                        : f.mono
                          ? "num-id min-w-0 font-mono text-sm wrap-break-word"
                          : "min-w-0 text-sm wrap-break-word"
                    }
                  >
                    {text ?? <span className="font-sans text-muted-foreground">{tCommon("notSet")}</span>}
                  </dd>
                </div>
              );
            })}
          </dl>
          <p className="text-xs text-muted-foreground" data-testid={`${testId}-changed`}>
            {changed
              ? t("changedBy", {
                  name: changed.by ?? t("someoneGone"),
                  when: format.dateTime(new Date(changed.at), { dateStyle: "medium", timeStyle: "short" }),
                })
              : t("protectedNote")}
          </p>
          {editable ? (
            hasFactor ? (
              <div>
                <Button ref={changeRef} type="button" variant="outline" onClick={openForm}>
                  <ShieldCheckIcon aria-hidden="true" />
                  {labels.change}
                </Button>
              </div>
            ) : (
              <p className="text-sm" data-testid={`${testId}-needs-factor`}>
                {t("needsFactor")}{" "}
                <Link
                  href={enrolHref}
                  className="rounded-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {t("setUpFactor")}
                </Link>
              </p>
            )
          ) : null}
        </>
      ) : (
        <form onSubmit={save} className="flex flex-col gap-3" aria-label={labels.formLabel}>
          <p className="text-sm text-muted-foreground">{labels.formIntro}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {fields.map((f, i) => {
              const id = `${testId}-${f.name}`;
              const setRef = (el: HTMLElement | null) => {
                if (i === 0) firstRef.current = el;
              };
              if (f.kind === "checkbox") {
                return (
                  <label key={f.name} htmlFor={id} className="flex items-center gap-2 text-sm sm:col-span-2">
                    <NativeCheckbox
                      id={id}
                      ref={setRef}
                      checked={draft[f.name] === true}
                      onChange={(ev) => setDraft((d) => ({ ...d, [f.name]: ev.target.checked }))}
                    />
                    {f.label}
                  </label>
                );
              }
              return (
                <div key={f.name} className={f.wide || f.kind === "textarea" ? "sm:col-span-2" : undefined}>
                  <Field label={f.label} htmlFor={id} hint={f.hint}>
                    {f.kind === "textarea" ? (
                      <Textarea
                        id={id}
                        ref={setRef}
                        value={String(draft[f.name] ?? "")}
                        onChange={(ev) => setDraft((d) => ({ ...d, [f.name]: ev.target.value }))}
                        maxLength={f.maxLength}
                        rows={3}
                      />
                    ) : (
                      <Input
                        id={id}
                        ref={setRef}
                        value={String(draft[f.name] ?? "")}
                        onChange={(ev) => setDraft((d) => ({ ...d, [f.name]: ev.target.value }))}
                        placeholder={f.placeholder}
                        maxLength={f.maxLength}
                        autoComplete="off"
                        spellCheck={false}
                        className={f.mono ? "num-id font-mono" : undefined}
                      />
                    )}
                  </Field>
                </div>
              );
            })}
          </div>
          <Field label={t("codeLabel")} htmlFor={codeId} hint={t("codeHint")}>
            <Input
              id={codeId}
              value={code}
              onChange={(ev) => setCode(ev.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={32}
              className="num-id w-40 font-mono"
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" aria-disabled={pending}>
              {labels.save}
            </Button>
            <Button type="button" variant="ghost" onClick={() => !pending && close()} aria-disabled={pending}>
              {tCommon("cancel")}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

function draftOf(fields: readonly ProtectedField[], values: ProtectedValues): Record<string, string | boolean> {
  return Object.fromEntries(
    fields.map((f) => {
      const v = values[f.name];
      return [f.name, f.kind === "checkbox" ? v === true : typeof v === "string" ? v : ""];
    }),
  );
}
