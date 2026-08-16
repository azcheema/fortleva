"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { commitUploadAction, presignUploadAction } from "./actions";

/**
 * Upload = three hops, none of which stream bytes through the app:
 * 1) presign (server action → PENDING FileObject + signed PUT URL),
 * 2) PUT the bytes straight to storage with the signed headers,
 * 3) commit (server action → HEAD-verify → COMMITTED + Document).
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

export function UploadForm() {
  const t = useTranslations("files");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const file = inputRef.current?.files?.[0];
    if (!file) return;

    setPhase({ kind: "busy", step: "preparing" });
    const sha256 = await sha256Hex(file);
    const presign = await presignUploadAction({
      name: file.name,
      contentType: file.type,
      sizeBytes: file.size,
      sha256,
    });
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
    const commit = await commitUploadAction(presign.value.fileObjectId);
    if (!commit.ok) return setPhase({ kind: "error", message: commit.message });

    setPhase({ kind: "idle" });
    toast.success(t("upload.done", { name: file.name }));
    if (inputRef.current) inputRef.current.value = "";
    startTransition(() => router.refresh());
  };

  const busy = phase.kind === "busy";

  return (
    <form onSubmit={onSubmit} className="flex max-w-md flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="upload-file">{t("upload.file")}</Label>
        <Input id="upload-file" ref={inputRef} type="file" name="file" required disabled={busy} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="upload-visibility">{t("visibility.label")}</Label>
        <Select name="visibility" defaultValue="INTERNAL" disabled>
          <SelectTrigger id="upload-visibility" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="INTERNAL">{t("visibility.internal")}</SelectItem>
            <SelectItem value="CLIENT_VISIBLE">{t("visibility.clientVisible")}</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">{t("visibility.hint")}</span>
      </div>
      <Button type="submit" disabled={busy} className="self-start">
        {phase.kind === "busy" ? t(`upload.${phase.step}`) : t("upload.submit")}
      </Button>
      {phase.kind === "error" ? (
        <p role="alert" className="text-sm text-destructive">
          {phase.message}
        </p>
      ) : null}
    </form>
  );
}
