"use client";

import { FileSignatureIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";

import { Field, Pending } from "@/components/semantic/field";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeCheckbox } from "@/components/ui/native-checkbox";
import { Textarea } from "@/components/ui/textarea";
import { isActionRedirect } from "@/lib/action-redirect";
import { DECLINE_REASON_MAX, SIGN_NAME_MAX } from "@/modules/contracts/sign-input";

import { decideContractAction } from "../actions";
import { OUTCOME_ID } from "./outcome-id";

/**
 * A decision was just made in this tab: the outcome line that mounts with the
 * re-rendered page takes focus (the card that held it is gone — the agency's
 * sent view's hand-over, `focusSignaturesNext`). Keyed by the CONTRACT,
 * consumed once, and only for a few seconds, so another contract's page is
 * never handed focus (the fix re-check's nit: a refusal that keeps the card
 * leaves its request unconsumed).
 */
const FOCUS_REQUEST_MS = 5_000;
let focusRequest: { readonly contractId: string; readonly at: number } | null = null;

/*
 * READ AND CLEARED ONLY IN THESE TWO PLAIN FUNCTIONS, never inside a component
 * or a hook (CI run 38132836202; AGENTS.md's standing trap): the React
 * Compiler's constant propagation treats a module-level binding as a constant,
 * so `const asked = focusRequest; …; focusRequest = null; … asked.at` inside
 * `OutcomeFocus`'s effect became `h = null, … h.at` — the local replaced by
 * the module variable it copied, read AFTER the write — and the client's page
 * died with "Cannot read properties of null (reading 'at')" the moment they
 * signed. The compiler does not compile a plain function.
 */
function requestOutcomeFocus(contractId: string): void {
  focusRequest = { contractId, at: Date.now() };
}

/** This tab's request, consumed: true when it was THIS contract's and is fresh. */
function takeOutcomeFocus(contractId: string): boolean {
  const asked = focusRequest;
  if (asked === null || asked.contractId !== contractId) return false;
  focusRequest = null;
  return Date.now() - asked.at <= FOCUS_REQUEST_MS;
}

/** Rendered by the page beside the outcome line: takes focus when a decision made here, on THIS contract, asked it to. */
export function OutcomeFocus({ contractId }: { contractId: string }) {
  useEffect(() => {
    if (takeOutcomeFocus(contractId)) document.getElementById(OUTCOME_ID)?.focus();
  }, [contractId]);
  return null;
}

/**
 * SIGN THIS CONTRACT — the client signer's control (Phase 4 slice 112b2;
 * founder decisions C84 (b)–(d), C85). Drawn by the page only while the
 * contract waits for THIS person (`canSign`): a portal screen with a button
 * whose only outcome is a refusal is a bug (UI.md §4).
 *
 * SIGN: "I have read and accept this contract" ticked and the full name typed —
 * the same act as the agency's signature at sending, so both read alike on the
 * signed copy. DECLINE…: a dialog with an optional reason, the client's own
 * words, which the agency reads and the client's other main contacts see.
 *
 * In place, no toast — the portal's islands' rule (`../../sign-off.tsx`): a
 * refusal renders under the control as `role="alert"` and re-reads the page;
 * the guard is the island's own `busy` (never a transition's `isPending`,
 * AGENTS.md); a success re-renders the page from the server (the action
 * revalidates it), whose outcome line then takes focus (`OutcomeFocus`).
 */
export function SignCard({ contractId }: { contractId: string }) {
  const t = useTranslations("portal.contracts.sign");
  const tCommon = useTranslations("common");
  const formId = useId();
  const nameId = useId();
  const acceptId = useId();
  const reasonId = useId();
  const [accepted, setAccepted] = useState(false);
  const [typedName, setTypedName] = useState("");
  const [busy, setBusy] = useState<"sign" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [declineError, setDeclineError] = useState<string | null>(null);
  const declineTrigger = useRef<HTMLButtonElement>(null);
  const decidedRef = useRef(false);
  const router = useRouter();

  const decide = async (decision: "SIGNED" | "DECLINED") => {
    if (busy) return;
    setBusy(decision === "SIGNED" ? "sign" : "decline");
    const fail = decision === "SIGNED" ? setError : setDeclineError;
    fail(null);
    try {
      const r = await decideContractAction(
        contractId,
        decision === "SIGNED" ? { decision, accepted, typedName } : { decision, reason },
      );
      if (!r.ok) {
        fail(r.message);
        // Re-read the page (the code review's low): a refusal is most often
        // the agency having withdrawn it meanwhile, which the page then says
        // instead of offering this card again. A typing mistake keeps the card
        // and the message — its props do not change. If the card goes, its
        // outcome line takes focus, as after a decision.
        requestOutcomeFocus(contractId);
        router.refresh();
        return;
      }
      // The page re-renders without this card; its outcome line takes focus.
      decidedRef.current = true;
      requestOutcomeFocus(contractId);
      setDeclining(false);
    } catch (e) {
      if (isActionRedirect(e)) return;
      fail(t("failed"));
    } finally {
      setBusy(null);
    }
  };

  const canSubmit = accepted && typedName.trim() !== "" && busy === null;

  return (
    <div className="flex flex-col gap-4" data-testid="portal-contract-sign">
      {/* The decline dialog's form is NOT inside this one: React bubbles a
          submit through the component tree, across the dialog's portal, so a
          nested decline would have reached the sign form's handler too. The
          Sign button submits this form by its id from the row below. */}
      <form
        id={formId}
        className="flex flex-col gap-4"
        aria-label={t("title")}
        onSubmit={(ev) => {
          ev.preventDefault();
          if (canSubmit) void decide("SIGNED");
        }}
      >
        <label htmlFor={acceptId} className="flex items-start gap-2.5 text-sm">
          <NativeCheckbox
            id={acceptId}
            checked={accepted}
            onChange={(ev) => setAccepted(ev.target.checked)}
            className="mt-0.5"
            data-testid="portal-contract-accept"
          />
          <span>{t("accept")}</span>
        </label>
        <Field label={t("name")} htmlFor={nameId} hint={t("nameHint")}>
          <Input
            id={nameId}
            value={typedName}
            maxLength={SIGN_NAME_MAX}
            autoComplete="name"
            onChange={(ev) => setTypedName(ev.target.value)}
            data-testid="portal-contract-name"
          />
        </Field>
        {error ? (
          <p role="alert" className="text-sm text-(--tone-danger-fg)" data-testid="portal-contract-sign-error">
            {error}
          </p>
        ) : null}
      </form>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" form={formId} disabled={!canSubmit} data-testid="portal-contract-sign-confirm">
          {busy === "sign" ? (
            <Pending label={tCommon("loading")} />
          ) : (
            <>
              <FileSignatureIcon aria-hidden="true" />
              {t("confirm")}
            </>
          )}
        </Button>
        <Dialog
          open={declining}
          onOpenChange={(next) => {
            if (busy) return;
            if (next) {
              setReason("");
              setDeclineError(null);
            }
            setDeclining(next);
          }}
        >
          <DialogTrigger asChild>
            <Button ref={declineTrigger} type="button" variant="outline" disabled={busy !== null} data-testid="portal-contract-decline-open">
              <XIcon aria-hidden="true" />
              {t("decline")}
            </Button>
          </DialogTrigger>
          <DialogContent
            className="sm:max-w-md"
            data-testid="portal-contract-decline-dialog"
            onCloseAutoFocus={(event) => {
              // Declined: the trigger goes with this card; the page's outcome
              // line takes focus as it mounts (`OutcomeFocus`).
              if (decidedRef.current || !declineTrigger.current?.isConnected) {
                event.preventDefault();
                document.getElementById(OUTCOME_ID)?.focus();
              }
            }}
          >
            <DialogHeader>
              <DialogTitle>{t("declineTitle")}</DialogTitle>
              <DialogDescription>{t("declineBody")}</DialogDescription>
            </DialogHeader>
            <form
              className="flex flex-col gap-3"
              aria-label={t("declineTitle")}
              onSubmit={(ev) => {
                ev.preventDefault();
                void decide("DECLINED");
              }}
            >
              <Field label={t("reason")} htmlFor={reasonId} hint={t("reasonHint")}>
                <Textarea
                  id={reasonId}
                  value={reason}
                  maxLength={DECLINE_REASON_MAX}
                  rows={4}
                  onChange={(ev) => setReason(ev.target.value)}
                  data-testid="portal-contract-reason"
                />
              </Field>
              {declineError ? (
                <p role="alert" className="text-sm text-(--tone-danger-fg)">
                  {declineError}
                </p>
              ) : null}
              <DialogFooter>
                <Button type="button" variant="ghost" size="sm" onClick={() => setDeclining(false)} disabled={busy !== null}>
                  {tCommon("cancel")}
                </Button>
                <Button type="submit" variant="destructive" size="sm" disabled={busy !== null} data-testid="portal-contract-decline-confirm">
                  {busy === "decline" ? <Pending label={tCommon("loading")} /> : t("declineConfirm")}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
