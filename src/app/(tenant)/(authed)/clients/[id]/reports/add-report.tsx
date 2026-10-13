"use client";

import { UploadIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { Callout, Field, FileDropField, FormMessage } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isActionRedirect } from "@/lib/action-redirect";
import { chosenFileFrom, type ChosenFile } from "@/lib/file-field";

import { presignUploadAction } from "../../../files/actions";
import { commitReportUploadAction } from "./actions";
import { MonthPicker } from "./month-picker";

/**
 * ADD A REPORT (Phase 6 slice 115; C91) — the month it covers, an optional
 * name, the file. The Files page's three hops, none streaming bytes through
 * the app: presign (`presignUploadAction` — the client as its target,
 * INTERNAL), PUT straight to storage, then the REPORT's own commit
 * (`commitReportUploadAction`). A report is always uploaded private and says
 * so: nobody at the client sees it until someone presses Publish.
 */

const sha256Hex = async (file: File): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
};

const STEPS = ["preparing", "uploading", "finishing"] as const;
type Step = (typeof STEPS)[number];
type Phase = { kind: "idle" } | { kind: "busy"; step: Step } | { kind: "error"; message: string };

export function AddReport({
  clientId,
  defaultMonth,
  latestMonth,
}: {
  clientId: string;
  /** `YYYY-MM` — last month in the workspace's zone. */
  defaultMonth: string;
  /** `YYYY-MM` — the workspace's current month, the newest offered. */
  latestMonth: string;
}) {
  const t = useTranslations("clients.reports.add");
  const tFiles = useTranslations("files");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [month, setMonth] = useState(defaultMonth);
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<ChosenFile | null>(null);
  const [, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const returnTo = `/clients/${clientId}/reports`;

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    try {
      await upload();
    } catch (err) {
      // A redirect (an expired session, a step-up) rejects the action's
      // promise and then navigates by itself: let it pass silently.
      if (isActionRedirect(err)) return;
      // Never stuck at "Finishing…": any rejection the hops did not turn into
      // a message of their own is said here (the code review's L1).
      setPhase({ kind: "error", message: t("failed") });
    }
  };

  const upload = async () => {
    const file = inputRef.current?.files?.[0];
    if (!file) return;

    setPhase({ kind: "busy", step: "preparing" });
    const sha256 = await sha256Hex(file);
    const presign = await presignUploadAction(
      { name: file.name, contentType: file.type, sizeBytes: file.size, sha256 },
      { clientId, visibility: "INTERNAL", returnTo },
    );
    if (!presign.ok) return setPhase({ kind: "error", message: presign.message });

    setPhase({ kind: "busy", step: "uploading" });
    const put = await fetch(presign.value.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": presign.value.contentType },
      body: file,
    }).catch(() => null);
    if (!put || !put.ok) {
      return setPhase({ kind: "error", message: tFiles("upload.failed", { status: put?.status ?? "network" }) });
    }

    setPhase({ kind: "busy", step: "finishing" });
    const commit = await commitReportUploadAction({
      fileObjectId: presign.value.fileObjectId,
      clientId,
      month,
      ...(name.trim() ? { name: name.trim() } : {}),
    });
    if (!commit.ok) return setPhase({ kind: "error", message: commit.message });

    setPhase({ kind: "idle" });
    toast.success(t("done"));
    if (inputRef.current) inputRef.current.value = "";
    setChosen(null);
    setName("");
    setMonth(defaultMonth);
    startTransition(() => router.refresh());
  };

  const busy = phase.kind === "busy";
  const stepIndex = phase.kind === "busy" ? STEPS.indexOf(phase.step) + 1 : 0;

  return (
    <form onSubmit={onSubmit} className="flex max-w-lg flex-col gap-4" data-testid="add-report">
      <MonthPicker id="add-report" value={month} latest={latestMonth} onChange={setMonth} disabled={busy} />
      <Field label={t("name")} htmlFor="add-report-name" hint={t("nameHint")}>
        <Input
          id="add-report-name"
          value={name}
          maxLength={255}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
          data-testid="report-name"
        />
      </Field>
      <FileDropField
        id="add-report-file"
        name="file"
        label={tFiles("upload.file")}
        hint={t("fileHint")}
        draggingHint={tFiles("upload.dropNow")}
        chooseLabel={tFiles("upload.choose")}
        chosen={chosen}
        onChange={(files) => setChosen(chosenFileFrom(files))}
        inputRef={inputRef}
        required
        disabled={busy}
      />
      <Callout tone="info">{t("private")}</Callout>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy} data-testid="add-report-submit">
          <UploadIcon />
          {busy ? tFiles(`upload.${phase.step}`) : t("submit")}
        </Button>
        {busy ? (
          <span className="num text-xs text-muted-foreground">
            {tFiles("upload.step", { step: stepIndex, total: STEPS.length })}
          </span>
        ) : null}
      </div>
      {busy ? (
        <div
          role="progressbar"
          aria-label={tFiles("upload.progressLabel")}
          aria-valuemin={0}
          aria-valuemax={STEPS.length}
          aria-valuenow={stepIndex}
          aria-valuetext={tFiles(`upload.${phase.step}`)}
          className="h-1 w-full overflow-hidden rounded-full bg-muted"
        >
          <span
            className="block h-full rounded-full bg-(--tone-neutral-line)"
            style={{ inlineSize: `${(stepIndex / STEPS.length) * 100}%` }}
          />
        </div>
      ) : null}
      {phase.kind === "error" ? <FormMessage state={{ ok: false, message: phase.message }} /> : null}
    </form>
  );
}
