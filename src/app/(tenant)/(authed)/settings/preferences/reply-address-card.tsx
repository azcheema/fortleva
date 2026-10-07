"use client";

import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Callout, Field } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useFocusReturn } from "@/components/ui/use-focus-return";
import type { ReplyAddressSettings } from "@/notify/reply-address";

import {
  cancelReplyAddressRequestAction,
  removeReplyAddressAction,
  requestReplyAddressAction,
} from "./actions";

/**
 * WHERE REPLIES TO THE WORKSPACE'S MAIL GO (Phase 5 slice 100; founder
 * decision C68 (c), (f), (i)). Reads as a sentence first — where replies go
 * NOW — and then, for `settings:edit`, the one way to change it: type an
 * address and Fortleva mails it a link; nothing changes until somebody
 * holding that mailbox confirms, which the card says while it waits, and
 * every owner is told when it does.
 *
 * The address field is controlled and sent from a submit handler, not a
 * `<form action>` (React 19 resets a form around its action, AGENTS.md); it
 * is cleared only when the server agreed. Every answer is a typed result,
 * toasted — a refusal never looks like a revert. "Stop using this address"
 * asks first: replies go back to the owner's own address at once.
 */
export function ReplyAddressCard({
  settings,
  editable,
}: {
  settings: ReplyAddressSettings;
  /** `settings:edit` — may ask for, cancel and remove an address. */
  editable: boolean;
}) {
  const t = useTranslations("settings.preferences.replies");
  const tCommon = useTranslations("common");
  const format = useFormatter();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [pending, start] = useTransition();
  const [removing, setRemoving] = useState(false);
  const focusReturn = useFocusReturn();
  const strong = (chunks: React.ReactNode) => <strong className="font-medium text-foreground">{chunks}</strong>;
  const day = (d: Date) => format.dateTime(d, { dateStyle: "medium" });

  const run = (call: () => Promise<{ ok: boolean; message: string }>, after?: () => void) =>
    start(async () => {
      // A failure the action could not type — the network, an unmapped
      // error — would otherwise reach the error boundary and replace the
      // whole settings page (the code review's low; `confirm-form.tsx` beside
      // the public page catches the same). A STEP-UP OR ENROLMENT REDIRECT
      // (C68 (k): asking needs a fresh factor) also REJECTS the call — Next's
      // server-action reducer rejects with its NEXT_REDIRECT error and then
      // navigates by itself — so that one is said nothing about (the fix-pass
      // review's medium; `secret-field.tsx` reads the same digest).
      let r: { ok: boolean; message: string };
      try {
        r = await call();
      } catch (e) {
        const digest = typeof e === "object" && e !== null ? (e as { digest?: unknown }).digest : undefined;
        if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) return;
        toast.error(t("unreachable"));
        return;
      }
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success(r.message);
      after?.();
      router.refresh();
    });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (pending) return;
    run(() => requestReplyAddressAction(email), () => setEmail(""));
  };

  return (
    <div className="flex flex-col gap-4" data-testid="reply-address">
      <p className="text-sm text-muted-foreground" data-testid="reply-address-now">
        {settings.confirmed
          ? t.rich("nowConfirmed", { email: settings.confirmed.email, date: day(settings.confirmed.confirmedAt), strong })
          : settings.ownerEmail
            ? t.rich("nowOwner", { email: settings.ownerEmail, strong })
            : t("nowNone")}
      </p>

      {settings.pending ? (
        <Callout tone="info">
          <span data-testid="reply-address-pending">
            {t.rich("waiting", { email: settings.pending.email, date: day(settings.pending.expiresAt), strong })}
          </span>
          {editable ? (
            <span className="mt-2 block">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => run(() => cancelReplyAddressRequestAction())}
              >
                {t("cancel")}
              </Button>
            </span>
          ) : null}
        </Callout>
      ) : null}

      {editable ? (
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Field htmlFor="reply-address-email" label={t("label")} hint={t("hint")}>
            <Input
              id="reply-address-email"
              type="email"
              autoComplete="email"
              required
              maxLength={254}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={pending}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={pending || email.trim() === ""}>
              {t("send")}
            </Button>
            {settings.confirmed ? (
              <Button type="button" variant="ghost" disabled={pending} onClick={() => setRemoving(true)}>
                {t("remove")}
              </Button>
            ) : null}
          </div>
        </form>
      ) : null}

      <Dialog open={removing} onOpenChange={(open) => (pending ? null : setRemoving(open))}>
        <DialogContent {...focusReturn} className="sm:max-w-md" data-testid="reply-address-remove-confirm">
          <DialogHeader>
            <DialogTitle>{t("removeTitle")}</DialogTitle>
            <DialogDescription>
              {settings.ownerEmail ? t("removeBody", { email: settings.ownerEmail }) : t("removeBodyNone")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setRemoving(false)} disabled={pending}>
              {tCommon("cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={() => run(() => removeReplyAddressAction(), () => setRemoving(false))}
            >
              {t("removeSubmit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
