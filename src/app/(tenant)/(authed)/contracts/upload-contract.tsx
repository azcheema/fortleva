"use client";

import { UploadIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";

import { FileDropField } from "@/components/semantic";
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
import { NativeSelect } from "@/components/ui/native-select";
import { isActionRedirect } from "@/lib/action-redirect";

import { commitContractUploadAction, presignContractUploadAction } from "./actions";

const sha256Hex = async (file: File): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

const STEPS = ["preparing", "uploading", "finishing"] as const;
type Step = (typeof STEPS)[number];

/** Today in this browser, `YYYY-MM-DD` — the first check; the server holds the workspace's day again. */
const localToday = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * PUT IN A SIGNED CONTRACT… (Phase 4 slice 112c; founder decisions C84 (f),
 * C86) — a contract signed on paper or in the client's own tool: its client,
 * its title, the day it was signed and its term, and the signed PDF (PDF only
 * — C86 (d)) in the product's one file field (`FileDropField`, UI.md §5.13).
 * The documents' upload: the file is hashed here, a presigned PUT asked for,
 * the bytes sent STRAIGHT to the bucket, then the commit — where the server
 * reads the bytes back before the contract exists. It is put in SIGNED and NOT
 * shown to the client (C86 (a)); its page opens, where Show to the client is.
 *
 * The details are checked HERE first — a signing day still to come, an end
 * before the start — so a mistake never costs a 20 MB upload (the code
 * review's medium); and if the server refuses the details all the same, the
 * file already uploaded is committed again with the corrected details rather
 * than uploaded twice (its placeholder is still waiting).
 *
 * `fixedClientId` is the client page's Contracts tab: the client is chosen.
 * Opened from a trigger, so focus returns to it; a success navigates away.
 */
export function UploadContract({
  clients,
  fixedClientId,
  maxBytes,
}: {
  clients: readonly { readonly id: string; readonly name: string }[];
  fixedClientId?: string;
  maxBytes: number;
}) {
  const t = useTranslations("contracts.upload");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const ids = { client: useId(), title: useId(), signedOn: useId(), startsOn: useId(), endsOn: useId(), file: useId() };
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [clientId, setClientId] = useState(fixedClientId ?? "");
  const [title, setTitle] = useState("");
  const [signedOn, setSignedOn] = useState("");
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [file, setFile] = useState<File | null>(null);
  /** A file already in the bucket, waiting for a commit with corrected details. */
  const [uploaded, setUploaded] = useState<{ readonly file: File; readonly fileObjectId: string; readonly clientId: string } | null>(null);
  const [step, setStep] = useState<Step | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The date picker's limit — taken each time the dialog opens, never once per page (the fix re-check's low). */
  const [today, setToday] = useState(localToday);
  const mb = Math.round(maxBytes / (1024 * 1024));

  const reset = () => {
    setClientId(fixedClientId ?? "");
    setTitle("");
    setSignedOn("");
    setStartsOn("");
    setEndsOn("");
    setFile(null);
    setUploaded(null);
    setError(null);
    setToday(localToday());
  };

  const ready = clientId !== "" && title.trim() !== "" && signedOn !== "" && file !== null && step === null;

  const submit = async () => {
    if (!ready || !file) return;
    // Said here first; the server holds every rule again.
    if (!/\.pdf$/i.test(file.name)) return setError(t("notPdf"));
    if (file.size <= 0) return setError(t("empty"));
    if (file.size > maxBytes) return setError(t("tooLarge", { mb }));
    if (signedOn > localToday()) return setError(t("signedLater"));
    if (startsOn && endsOn && endsOn < startsOn) return setError(t("endsBefore"));
    setError(null);
    setStep("preparing");
    try {
      let fileObjectId = uploaded && uploaded.file === file && uploaded.clientId === clientId ? uploaded.fileObjectId : null;
      const reused = fileObjectId !== null;
      if (!fileObjectId) {
        const sha256 = await sha256Hex(file);
        const ticket = await presignContractUploadAction({
          clientId,
          fileName: file.name,
          contentType: file.type || "application/pdf",
          sizeBytes: file.size,
          sha256,
        });
        if (!ticket.ok) return setError(ticket.message);
        setStep("uploading");
        const put = await fetch(ticket.value.uploadUrl, { method: "PUT", headers: ticket.value.headers, body: file });
        if (!put.ok) return setError(t("failed"));
        fileObjectId = ticket.value.fileObjectId;
        setUploaded({ file, fileObjectId, clientId });
      }
      setStep("finishing");
      const made = await commitContractUploadAction({ fileObjectId, clientId, title, signedOn, startsOn, endsOn });
      if (!made.ok) {
        // A second refusal of a re-used upload: the next try uploads afresh
        // (its placeholder may be gone — the file was not a PDF, say).
        if (reused || made.uploadGone) setUploaded(null);
        return setError(made.message);
      }
      setUploaded(null);
      toast.success(t("done"));
      setOpen(false);
      router.push(`/contracts/${made.value}`);
    } catch (e) {
      if (isActionRedirect(e)) return;
      setError(t("failed"));
    } finally {
      setStep(null);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (step !== null) return;
        if (next) reset();
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="outline" data-testid="upload-contract-open">
          <UploadIcon aria-hidden="true" />
          {t("button")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg" data-testid="upload-contract-dialog">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("body")}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          aria-label={t("title")}
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {fixedClientId ? null : (
            <Field label={t("client")} htmlFor={ids.client} required>
              <NativeSelect id={ids.client} value={clientId} onChange={(e) => setClientId(e.target.value)} disabled={step !== null} data-testid="upload-contract-client">
                <option value="">{t("chooseClient")}</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          )}
          <Field label={t("contractTitle")} htmlFor={ids.title} required>
            <Input id={ids.title} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} disabled={step !== null} data-testid="upload-contract-title" />
          </Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label={t("signedOn")} htmlFor={ids.signedOn} required>
              <Input
                id={ids.signedOn}
                type="date"
                value={signedOn}
                max={today}
                onChange={(e) => setSignedOn(e.target.value)}
                disabled={step !== null}
                data-testid="upload-contract-signed"
              />
            </Field>
            <Field label={t("startsOn")} htmlFor={ids.startsOn}>
              <Input id={ids.startsOn} type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} disabled={step !== null} />
            </Field>
            <Field label={t("endsOn")} htmlFor={ids.endsOn}>
              <Input id={ids.endsOn} type="date" value={endsOn} min={startsOn || undefined} onChange={(e) => setEndsOn(e.target.value)} disabled={step !== null} />
            </Field>
          </div>
          <FileDropField
            id={ids.file}
            name="file"
            label={t("file")}
            hint={t("dropHint", { mb })}
            draggingHint={t("dropNow")}
            chooseLabel={t("choose")}
            chosen={file ? { name: file.name, size: file.size } : null}
            onChange={(files) => setFile(files?.[0] ?? null)}
            onClear={() => setFile(null)}
            inputRef={inputRef}
            accept=".pdf,application/pdf"
            required
            disabled={step !== null}
            progress={step ? { value: STEPS.indexOf(step) + 1, max: STEPS.length, label: t(`steps.${step}`) } : undefined}
          />
          {error ? (
            <p role="alert" className="text-sm text-(--tone-danger-fg)" data-testid="upload-contract-error">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={step !== null}>
              {tCommon("cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={!ready} data-testid="upload-contract-confirm">
              {step ? <Pending label={t(`steps.${step}`)} /> : t("confirm")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
