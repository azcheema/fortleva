"use client";

import { DownloadIcon, Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { toast } from "sonner";

import { Callout, RowActions, SectionCard } from "@/components/semantic";
import { Field, Pending } from "@/components/semantic/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { isActionRedirect } from "@/lib/action-redirect";

import {
  contractPdfUrlAction,
  deleteUploadedContractAction,
  saveUploadedContractAction,
  setContractShownAction,
} from "../actions";

type Details = { title: string; signedOn: string; startsOn: string; endsOn: string };

/**
 * A CONTRACT SIGNED ELSEWHERE (Phase 4 slice 112c; founder decisions C84 (f),
 * C86) — what the agency can do with one once it is put in:
 *   - its DETAILS (title, the day it was signed, its term), saved with Save
 *     (`contract:edit`); its file can never be swapped (C86 (b));
 *   - SHOW TO THE CLIENT (`contract:send`), OFF until someone turns it on
 *     (C86 (a)) — a visibility control, so the switch draws the SERVER's state
 *     (the action revalidates the page) and is never optimistic: it says
 *     "shown" only once the database does (the project portal switch's rule);
 *   - Download (the file as it was put in) and Delete… (`contract:delete`, a
 *     danger confirmation — C86 (b): a wrong one is deleted and put in again).
 * Every failure is a toast, never a revert-looking silence (AGENTS.md); each
 * control is guarded on this island's own `busy`, never a transition.
 */
export function UploadedContract({
  contractId,
  stored,
  shown,
  canEdit,
  canShow,
  canDelete,
}: {
  contractId: string;
  stored: Details;
  /** Shown to the client's main contacts now — the server's answer. */
  shown: boolean;
  canEdit: boolean;
  canShow: boolean;
  canDelete: boolean;
}) {
  const t = useTranslations("contracts.uploaded");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const ids = { title: useId(), signedOn: useId(), startsOn: useId(), endsOn: useId(), shown: useId() };
  const [details, setDetails] = useState<Details>(stored);
  const [baseline, setBaseline] = useState<Details>(stored);
  const [busy, setBusy] = useState<"save" | "show" | "download" | "delete" | null>(null);
  const dirty = (Object.keys(details) as (keyof Details)[]).some((k) => details[k] !== baseline[k]);

  /** One action at a time; a refusal a toast; a thrown transport error a toast too. */
  const act = async (which: NonNullable<typeof busy>, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(which);
    try {
      await fn();
    } catch (e) {
      if (isActionRedirect(e)) return;
      toast.error(t("unreachable"));
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    act("save", async () => {
      const r = await saveUploadedContractAction(contractId, details);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      setBaseline(details);
      toast.success(r.message);
    });

  const setShown = (next: boolean) =>
    act("show", async () => {
      const r = await setContractShownAction(contractId, next);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success(r.message);
    });

  const download = () =>
    act("download", async () => {
      const r = await contractPdfUrlAction(contractId, "signed");
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      window.location.assign(r.value);
    });

  const remove = () =>
    act("delete", async () => {
      const r = await deleteUploadedContractAction(contractId);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success(r.message);
      router.push("/contracts");
    });

  const field = (key: keyof Details, label: string, type: "text" | "date", required = false) => (
    <Field label={label} htmlFor={ids[key]} required={required}>
      <Input
        id={ids[key]}
        type={type}
        value={details[key]}
        maxLength={type === "text" ? 200 : undefined}
        disabled={!canEdit || busy !== null}
        onChange={(e) => setDetails((d) => ({ ...d, [key]: e.target.value }))}
        data-testid={`uploaded-${key}`}
      />
    </Field>
  );

  return (
    <div className="flex flex-col gap-4" data-testid="uploaded-contract">
      <SectionCard
        title={t("title")}
        description={t("intro")}
        actions={
          canDelete ? (
            <RowActions
              label={t("menu")}
              items={[
                {
                  key: "delete",
                  label: t("delete"),
                  icon: Trash2Icon,
                  tone: "danger" as const,
                  confirm: t("deleteConfirm"),
                  onSelect: () => void remove(),
                },
              ]}
            />
          ) : null
        }
      >
        <Button type="button" variant="outline" size="sm" onClick={() => void download()} aria-disabled={busy !== null} data-testid="uploaded-download">
          <DownloadIcon aria-hidden="true" />
          {t("download")}
        </Button>
      </SectionCard>

      <SectionCard title={t("showTitle")}>
        <div className="flex items-start justify-between gap-3 rounded-md border border-input p-3">
          <div className="flex min-w-0 flex-col gap-1">
            <Label htmlFor={ids.shown} className="text-sm">
              {t("showLabel")}
            </Label>
            <span className="text-xs text-muted-foreground" data-testid="uploaded-shown-state">
              {shown ? t("showOn") : t("showOff")}
            </span>
          </div>
          {busy === "show" ? <Pending label={tCommon("loading")} className="mt-1" /> : null}
          <Switch
            id={ids.shown}
            checked={shown}
            disabled={!canShow || busy !== null}
            onCheckedChange={(next) => void setShown(next)}
            className="mt-1"
            data-testid="uploaded-shown"
          />
        </div>
        {!canShow ? <p className="mt-2 text-xs text-muted-foreground">{t("showNoPermission")}</p> : null}
      </SectionCard>

      <SectionCard title={t("detailsTitle")}>
        <form
          className="flex flex-col gap-3"
          aria-label={t("detailsTitle")}
          onSubmit={(e) => {
            e.preventDefault();
            if (canEdit && dirty) void save();
          }}
        >
          {field("title", t("contractTitle"), "text", true)}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {field("signedOn", t("signedOn"), "date", true)}
            {field("startsOn", t("startsOn"), "date")}
            {field("endsOn", t("endsOn"), "date")}
          </div>
          {canEdit ? (
            <div>
              <Button type="submit" size="sm" disabled={!dirty || busy !== null} data-testid="uploaded-save">
                {busy === "save" ? <Pending label={tCommon("loading")} /> : t("save")}
              </Button>
            </div>
          ) : (
            <Callout tone="info">{t("noEdit")}</Callout>
          )}
        </form>
      </SectionCard>
    </div>
  );
}
