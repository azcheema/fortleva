"use client";

import { SendIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { toast } from "sonner";

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
import { isActionRedirect } from "@/lib/action-redirect";

import { sendContractAction } from "../actions";
import { focusSignaturesNext, SENT_HEADING_ID } from "./sent-contract";

const NAME_MAX = 200;

/**
 * SEND FOR SIGNATURE… (Phase 4 slice 112b; founder decisions C84 (b), (d), C85
 * (c)). The sender types their name — that IS the agency's signature, so the
 * dialog says so in so many words — and the contract goes to the signer named
 * in the draft, a main contact of the client in the portal. No authenticator
 * code (C85 (c)). The send is bound to the draft as the page read it
 * (`seen`): a draft changed since — by a colleague, in another tab — is
 * refused and the person looks again. Shown only once the draft is saved,
 * has a signer who can sign and holds no fill-in (UI.md §3.1: hidden, never
 * disabled — the editor says what is missing instead).
 * Opened from a trigger, so focus returns to it — and once sent, the page
 * re-renders as the sent contract.
 */
export function SendDialog({
  contractId,
  seen,
  title,
  signerName,
}: {
  contractId: string;
  seen: string;
  title: string;
  signerName: string;
}) {
  const t = useTranslations("contracts.send");
  const tCommon = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [typedName, setTypedName] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const sentRef = useRef(false);

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (busy || typedName.trim() === "") return;
    setBusy(true);
    try {
      const r = await sendContractAction(contractId, seen, typedName);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      if (r.caution) toast.warning(r.message);
      else toast.success(r.message);
      // The page re-renders as the sent contract; it takes focus when it mounts.
      sentRef.current = true;
      focusSignaturesNext();
      setOpen(false);
    } catch (e) {
      if (isActionRedirect(e)) return;
      toast.error(t("unreachable"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (next) setTypedName("");
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button ref={triggerRef} type="button" data-testid="contract-send-open">
          <SendIcon aria-hidden="true" />
          {t("button")}
        </Button>
      </DialogTrigger>
      <DialogContent
        className="sm:max-w-md"
        data-testid="contract-send-dialog"
        onCloseAutoFocus={(event) => {
          // Sent: the sent view takes focus as it mounts (`focusSignaturesNext`);
          // the trigger is about to go, so focus is not handed back to it.
          if (sentRef.current) {
            event.preventDefault();
            document.getElementById(SENT_HEADING_ID)?.focus();
            return;
          }
          if (triggerRef.current?.isConnected) return;
          event.preventDefault();
          document.getElementById(SENT_HEADING_ID)?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("body", { title, signer: signerName })}</DialogDescription>
        </DialogHeader>
        <form onSubmit={(ev) => void submit(ev)} className="flex flex-col gap-3" aria-label={t("title")}>
          <Field label={t("typedName")} htmlFor={`send-name-${contractId}`} hint={t("typedNameHint")}>
            <Input
              id={`send-name-${contractId}`}
              value={typedName}
              maxLength={NAME_MAX}
              autoComplete="name"
              onChange={(ev) => setTypedName(ev.target.value)}
              required
              data-testid="contract-send-name"
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={busy}>
              {tCommon("cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={busy || typedName.trim() === ""} data-testid="contract-send-confirm">
              {busy ? <Pending label={tCommon("loading")} /> : t("confirm")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
