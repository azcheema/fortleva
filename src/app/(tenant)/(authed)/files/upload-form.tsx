"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { Field, FormMessage } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
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
 */

const sha256Hex = async (file: File): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

type Phase =
  | { kind: "idle" }
  | { kind: "busy"; step: "preparing" | "uploading" | "finishing" }
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
    setVisibility("INTERNAL");
    startTransition(() => router.refresh());
  };

  const busy = phase.kind === "busy";

  return (
    <form onSubmit={onSubmit} className="flex max-w-md flex-col gap-3">
      <Field label={t("upload.file")} htmlFor="upload-file">
        <Input id="upload-file" ref={inputRef} type="file" name="file" required disabled={busy} />
      </Field>
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
            visibility === "CLIENT_VISIBLE" &&
              "border-vis-client-border bg-vis-client font-semibold text-vis-client-fg",
          )}
          onChange={(e) => setVisibility(e.target.value === "CLIENT_VISIBLE" ? "CLIENT_VISIBLE" : "INTERNAL")}
          disabled={!visibilityEnabled || busy}
        >
          <option value="INTERNAL">{tVis("internal")}</option>
          <option value="CLIENT_VISIBLE">{tVis("clientVisible")}</option>
        </NativeSelect>
      </Field>
      <Button type="submit" disabled={busy} className="self-start">
        {phase.kind === "busy" ? t(`upload.${phase.step}`) : t("upload.submit")}
      </Button>
      {phase.kind === "error" ? (
        <FormMessage state={{ ok: false, message: phase.message }} />
      ) : null}
    </form>
  );
}
