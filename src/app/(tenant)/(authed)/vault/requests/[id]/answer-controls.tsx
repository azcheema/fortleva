"use client";

import { useTranslations } from "next-intl";
import { startTransition, useActionState, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Field, FormMessage } from "@/components/semantic";
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
import { Textarea } from "@/components/ui/textarea";
import { useFocusReturn } from "@/components/ui/use-focus-return";
import type { FormResult } from "@/lib/server-actions";

import { approveSealedAskAction, denySealedAskAction } from "./actions";

/**
 * APPROVE OR DENY A CLIENT'S ASK (Phase 3V slice 93; C61 (b)) — two
 * buttons, each opening a dialog that says what it means. Approving asks
 * for the member's authenticator code every time (it hands the client
 * their sealed logins, at once, for 7 days); denying asks for none and
 * may carry a reason the client is shown.
 *
 * Each dialog's form lives INSIDE the content, which Radix unmounts on
 * close, so every opening starts blank. Forms submit through `onSubmit` + a
 * transition, never `<form action>` (React 19 resets a form after every
 * action, a refusal included — AGENTS.md's standing trap). Each dialog has
 * its button as a trigger-less origin, so focus comes back through
 * `useFocusReturn`.
 */
export function AnswerControls({
  requestId,
  canApprove,
  canDeny,
}: {
  requestId: string;
  canApprove: boolean;
  canDeny: boolean;
}) {
  const t = useTranslations("vault.requests");
  const [open, setOpen] = useState<"approve" | "deny" | null>(null);
  const close = useCallback(() => setOpen(null), []);
  return (
    <div className="flex flex-wrap gap-2" data-testid="sealed-answer">
      {canApprove ? (
        <Button type="button" onClick={() => setOpen("approve")}>
          {t("approve")}
        </Button>
      ) : null}
      {canDeny ? (
        <Button type="button" variant="outline" onClick={() => setOpen("deny")}>
          {t("deny")}
        </Button>
      ) : null}
      <AnswerDialog kind="approve" open={open === "approve"} onClose={close} requestId={requestId} />
      <AnswerDialog kind="deny" open={open === "deny"} onClose={close} requestId={requestId} />
    </div>
  );
}

function AnswerDialog({
  kind,
  open,
  onClose,
  requestId,
}: {
  kind: "approve" | "deny";
  open: boolean;
  onClose: () => void;
  requestId: string;
}) {
  const t = useTranslations("vault.requests");
  const focusReturn = useFocusReturn();
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent {...focusReturn} className="sm:max-w-md" data-testid={`sealed-${kind}-dialog`}>
        <DialogHeader>
          <DialogTitle>{kind === "approve" ? t("approveTitle") : t("denyTitle")}</DialogTitle>
          <DialogDescription>{kind === "approve" ? t("approveBody") : t("denyBody")}</DialogDescription>
        </DialogHeader>
        {kind === "approve" ? (
          <AnswerForm action={approveSealedAskAction} requestId={requestId} onDone={onClose} kind="approve" />
        ) : (
          <AnswerForm action={denySealedAskAction} requestId={requestId} onDone={onClose} kind="deny" />
        )}
      </DialogContent>
    </Dialog>
  );
}

function AnswerForm({
  action: run,
  requestId,
  onDone,
  kind,
}: {
  action: (prev: FormResult | null, formData: FormData) => Promise<FormResult>;
  requestId: string;
  onDone: () => void;
  kind: "approve" | "deny";
}) {
  const t = useTranslations("vault.requests");
  const tCommon = useTranslations("common");
  const [state, action, pending] = useActionState<FormResult | null, FormData>(run, null);

  useEffect(() => {
    if (state?.ok) {
      toast.success(state.message);
      onDone();
    }
  }, [state, onDone]);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        startTransition(() => action(fd));
      }}
      className="flex flex-col gap-3"
      data-testid={`sealed-${kind}-form`}
    >
      <input type="hidden" name="requestId" value={requestId} />
      {kind === "approve" ? (
        <Field label={t("code")} htmlFor="sealed-approve-code" hint={t("codeHint")} required>
          <Input
            id="sealed-approve-code"
            name="code"
            required
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={32}
            className="font-mono"
            disabled={pending}
          />
        </Field>
      ) : (
        <Field label={t("denyReason")} htmlFor="sealed-deny-reason" hint={t("denyReasonHint")}>
          <Textarea id="sealed-deny-reason" name="reason" maxLength={1000} rows={3} disabled={pending} />
        </Field>
      )}
      {state && !state.ok ? <FormMessage state={state} /> : null}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone} disabled={pending}>
          {tCommon("cancel")}
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? t("answering") : kind === "approve" ? t("approveSubmit") : t("denySubmit")}
        </Button>
      </DialogFooter>
    </form>
  );
}
