"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Field, FormMessage, InlineConfirm } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import {
  askToOpenSealedAction,
  confirmSealedAskAction,
  withdrawSealedAskAction,
  type SealedActionResult,
} from "./actions";

/**
 * THE SEALED LOGINS' CONTROLS (Phase 3V slice 93; C52 (f), C61) — asking,
 * withdrawing and confirming, each a server action that answers a sentence.
 * A success refreshes the page, whose server render then draws where the
 * ask stands; a refusal stays on screen.
 *
 * The ask's form submits through `onSubmit` + a transition, never
 * `<form action>`: React 19 resets a form after EVERY action, a refusal
 * included, and a wrong password would empty the reason the client just
 * wrote (AGENTS.md's standing trap). The password is read once from the
 * form and never kept in state; on success the form is reset.
 */

const REASON_MAX = 1000;

/** ASK: a reason, and the portal password (C52 (f)). */
export function SealedAskForm() {
  const t = useTranslations("portal.logins.sealed");
  const router = useRouter();
  const [message, setMessage] = useState<SealedActionResult | null>(null);
  const [pending, start] = useTransition();

  const submit = (form: HTMLFormElement) => {
    const data = new FormData(form);
    const reason = data.get("reason");
    const password = data.get("password");
    start(async () => {
      const r = await askToOpenSealedAction(
        typeof password === "string" ? password : "",
        typeof reason === "string" ? reason : "",
      );
      setMessage(r);
      if (r.ok) {
        form.reset();
        router.refresh();
      } else {
        // Never keep a password that was refused in the field.
        const field = form.elements.namedItem("password");
        if (field instanceof HTMLInputElement) field.value = "";
      }
    });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit(e.currentTarget);
      }}
      className="flex flex-col gap-3"
      data-testid="sealed-ask-form"
    >
      <Field label={t("reason")} htmlFor="sealed-reason" hint={t("reasonHint")} required>
        <Textarea id="sealed-reason" name="reason" required maxLength={REASON_MAX} rows={3} disabled={pending} />
      </Field>
      <Field label={t("password")} htmlFor="sealed-password" required>
        <Input
          id="sealed-password"
          name="password"
          type="password"
          required
          maxLength={1024}
          autoComplete="current-password"
          disabled={pending}
        />
      </Field>
      {message ? <FormMessage state={message} /> : null}
      <Button type="submit" disabled={pending}>
        {pending ? t("asking") : t("ask")}
      </Button>
    </form>
  );
}

/** WITHDRAW an ask that has not opened — asked inline first. */
export function SealedWithdraw({ requestId }: { requestId: string }) {
  const t = useTranslations("portal.logins.sealed");
  const router = useRouter();
  const [message, setMessage] = useState<SealedActionResult | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-col gap-2" data-testid="sealed-withdraw">
      <div>
        <InlineConfirm
          label={t("withdraw")}
          question={t("withdrawQuestion")}
          pending={pending}
          onConfirm={() =>
            start(async () => {
              const r = await withdrawSealedAskAction(requestId);
              setMessage(r.ok ? null : r);
              if (r.ok) router.refresh();
            })
          }
        />
      </div>
      {message ? <FormMessage state={message} /> : null}
    </div>
  );
}

/**
 * CONFIRM after the silent wait — drawn only while the client's door is
 * open in this session (their password and the mailed code, a moment ago).
 */
export function SealedConfirm({ requestId }: { requestId: string }) {
  const t = useTranslations("portal.logins.sealed");
  const router = useRouter();
  const [message, setMessage] = useState<SealedActionResult | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-col gap-2" data-testid="sealed-confirm">
      <div>
        <Button
          type="button"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await confirmSealedAskAction(requestId);
              setMessage(r.ok ? null : r);
              if (r.ok) router.refresh();
            })
          }
        >
          {pending ? t("confirming") : t("confirm")}
        </Button>
      </div>
      {message ? <FormMessage state={message} /> : null}
    </div>
  );
}
