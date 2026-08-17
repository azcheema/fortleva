"use client";

import { UploadIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { Callout, Field, FileDropField, FormMessage } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { chosenFileFrom, type ChosenFile } from "@/lib/file-field";
import { cn } from "@/lib/utils";

import { commitUploadAction, presignUploadAction, type UploadTarget } from "./actions";

/**
 * Upload = three hops, none of which stream bytes through the app:
 * 1) presign (server action → PENDING FileObject + signed PUT URL),
 * 2) PUT the bytes straight to storage with the signed headers,
 * 3) commit (server action → HEAD-verify → COMMITTED + Document).
 * `target` attaches the document to a client or project (scope is
 * asserted server-side); the visibility select is enabled only there —
 * a tenant-internal file cannot be client-visible (schema CHECK).
 *
 * The affordance around those three hops: `<FileDropField>` — one
 * dashed surface with one outline "Choose file" affordance, the native
 * input sr-only behind it so keyboard and screen-reader users lose
 * nothing — a labelled three-phase progress bar rather than a spinner
 * — the phases are the only honest units, since a signed PUT gives no
 * byte progress — and, most importantly, a standing statement of where
 * this file will land. Private is the default and says so; choosing
 * "Client can see" swaps the reassurance for a caution that names who
 * will be able to open it.
 */

const sha256Hex = async (file: File): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

const STEPS = ["preparing", "uploading", "finishing"] as const;
type Step = (typeof STEPS)[number];

type Phase =
  | { kind: "idle" }
  | { kind: "busy"; step: Step }
  | { kind: "error"; message: string };

export function UploadForm({
  target = {},
  visibilityEnabled = false,
}: {
  target?: Omit<UploadTarget, "visibility">;
  visibilityEnabled?: boolean;
}) {
  const t = useTranslations("files");
  const tVis = useTranslations("visibility");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [visibility, setVisibility] = useState<"INTERNAL" | "CLIENT_VISIBLE">("INTERNAL");
  const [chosen, setChosen] = useState<ChosenFile | null>(null);
  const [, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const file = inputRef.current?.files?.[0];
    if (!file) return;
    const fullTarget: UploadTarget = { ...target, visibility };

    setPhase({ kind: "busy", step: "preparing" });
    const sha256 = await sha256Hex(file);
    const presign = await presignUploadAction(
      { name: file.name, contentType: file.type, sizeBytes: file.size, sha256 },
      fullTarget,
    );
    if (!presign.ok) return setPhase({ kind: "error", message: presign.message });

    setPhase({ kind: "busy", step: "uploading" });
    // Content-Length is a forbidden request header for fetch — the browser
    // sets it from the body; only Content-Type is sent explicitly.
    const put = await fetch(presign.value.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": presign.value.contentType },
      body: file,
    }).catch(() => null);
    if (!put || !put.ok) {
      return setPhase({
        kind: "error",
        message: t("upload.failed", { status: put?.status ?? "network" }),
      });
    }

    setPhase({ kind: "busy", step: "finishing" });
    const commit = await commitUploadAction(presign.value.fileObjectId, fullTarget);
    if (!commit.ok) return setPhase({ kind: "error", message: commit.message });

    setPhase({ kind: "idle" });
    toast.success(t("upload.done", { name: file.name }));
    if (inputRef.current) inputRef.current.value = "";
    setChosen(null);
    setVisibility("INTERNAL");
    startTransition(() => router.refresh());
  };

  const busy = phase.kind === "busy";
  const stepIndex = phase.kind === "busy" ? STEPS.indexOf(phase.step) + 1 : 0;
  const clientVisible = visibility === "CLIENT_VISIBLE";

  return (
    <form onSubmit={onSubmit} className="flex max-w-lg flex-col gap-4">
      <FileDropField
        id="upload-file"
        name="file"
        label={t("upload.file")}
        hint={t("upload.dropHint")}
        draggingHint={t("upload.dropNow")}
        chooseLabel={t("upload.choose")}
        chosen={chosen}
        onChange={(files) => setChosen(chosenFileFrom(files))}
        inputRef={inputRef}
        required
        disabled={busy}
      />

      <Field
        label={tVis("label")}
        htmlFor="upload-visibility"
        hint={!visibilityEnabled ? t("visibility.hint") : undefined}
      >
        {/* SAFETY-CRITICAL: the control wears the warm fill while it is set
            to CLIENT_VISIBLE, so the choice is legible before submitting
            and not only after the row renders. */}
        <NativeSelect
          id="upload-visibility"
          name="visibility"
          value={visibility}
          data-visibility={visibility}
          className={cn(
            clientVisible &&
              "border-vis-client-border bg-vis-client font-semibold text-vis-client-fg",
          )}
          onChange={(e) => setVisibility(e.target.value === "CLIENT_VISIBLE" ? "CLIENT_VISIBLE" : "INTERNAL")}
          disabled={!visibilityEnabled || busy}
        >
          <option value="INTERNAL">{tVis("internal")}</option>
          <option value="CLIENT_VISIBLE">{tVis("clientVisible")}</option>
        </NativeSelect>
      </Field>

      {clientVisible ? (
        <Callout tone="caution" role="status">
          {t("upload.clientVisibleWarning")}
        </Callout>
      ) : (
        <Callout tone="info">{t("upload.defaultPrivate")}</Callout>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy}>
          <UploadIcon />
          {busy ? t(`upload.${phase.step}`) : t("upload.submit")}
        </Button>
        {busy ? (
          <span className="num text-xs text-muted-foreground">
            {t("upload.step", { step: stepIndex, total: STEPS.length })}
          </span>
        ) : null}
      </div>

      {busy ? (
        <div
          role="progressbar"
          aria-label={t("upload.progressLabel")}
          aria-valuemin={0}
          aria-valuemax={STEPS.length}
          aria-valuenow={stepIndex}
          aria-valuetext={t(`upload.${phase.step}`)}
          className="h-1 w-full overflow-hidden rounded-full bg-muted"
        >
          <span
            className="block h-full rounded-full bg-(--tone-neutral-line)"
            style={{ inlineSize: `${(stepIndex / STEPS.length) * 100}%` }}
          />
        </div>
      ) : null}

      {phase.kind === "error" ? (
        <FormMessage state={{ ok: false, message: phase.message }} />
      ) : null}
    </form>
  );
}
