"use client";

import { FileTextIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { ContractBodyEditor } from "@/components/contracts/contract-body-editor";
import { Callout, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import type { FillInKey, SignerOption } from "@/modules/contracts";

import { saveContractDraftAction } from "../actions";

type Fields = {
  readonly title: string;
  readonly signerContactId: string;
  readonly language: "sv" | "en";
  readonly startsOn: string;
  readonly endsOn: string;
};

/** The plain text of a ProseMirror document — for the "is the signer named?" check only. */
function textOf(node: unknown): string {
  if (node === null || typeof node !== "object") return "";
  const n = node as { text?: unknown; content?: unknown };
  if (typeof n.text === "string") return n.text;
  return Array.isArray(n.content) ? n.content.map(textOf).join(" ") : "";
}

/**
 * A CONTRACT DRAFT'S EDITOR (Phase 4 slice 112; C84). The details — title, who
 * signs for the client (the client's main contacts in the portal only), the
 * language of its PDF and mails, its start and end dates — and its text, saved
 * together by **Save**: only what changed is sent, and the service writes and
 * audits only what changed. Controlled fields called from a click (React 19's
 * form reset). The fill-ins still in the text are named above it; the signer's
 * name missing from the text is a warning (C84 (e) fills it once, at start).
 *
 * NEVER REMOUNTED BY A SAVE (the code review's medium): the page does not key
 * this on the row's `updated_at`, and a save moves the "saved" baseline here,
 * so text typed while a save is in flight stays — and stays unsaved, because
 * the body's baseline is a VERSION counted per edit: a save clears the dirty
 * mark only if no edit came after the snapshot it sent. Guarded on the action
 * itself (`saving`), not on a transition that would stay pending while the
 * revalidated page re-renders (AGENTS.md).
 */
export function DraftEditor({
  contractId,
  initial,
  stored,
  initialBody,
  initialRemaining,
  signers,
  signer,
  canEdit,
}: {
  contractId: string;
  initial: Fields;
  /** What the row holds, when it differs from what the form starts with (a signer who is no longer a contact). */
  stored: Fields;
  initialBody: unknown;
  initialRemaining: readonly FillInKey[];
  signers: readonly SignerOption[];
  /** The signer the draft names, when they are no longer among `signers` (can't sign, or gone). */
  signer: { readonly id: string; readonly name: string; readonly canSign: boolean } | null;
  canEdit: boolean;
}) {
  const t = useTranslations("contracts.draft");
  const tFill = useTranslations("contracts.fillIns");
  const [saved, setSaved] = useState<Fields>(stored);
  const [fields, setFields] = useState<Fields>(initial);
  const [body, setBody] = useState<unknown>(initialBody);
  // Edits counted; `savedVersion` is the count the last successful save sent.
  const [bodyVersion, setBodyVersion] = useState(0);
  const [savedVersion, setSavedVersion] = useState(0);
  const [remaining, setRemaining] = useState<readonly FillInKey[]>(initialRemaining);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  const changed = (Object.keys(fields) as (keyof Fields)[]).filter((k) => fields[k] !== saved[k]);
  const bodyDirty = bodyVersion !== savedVersion;
  const dirty = changed.length > 0 || bodyDirty;
  const set = <K extends keyof Fields>(key: K, value: Fields[K]) => setFields((f) => ({ ...f, [key]: value }));

  const save = async () => {
    if (savingRef.current || !dirty) return;
    const patch: Record<string, unknown> = {};
    for (const key of changed) patch[key] = fields[key] === "" ? null : fields[key];
    if (bodyDirty) patch["body"] = body;
    const sentFields = fields;
    const sentVersion = bodyVersion;
    savingRef.current = true;
    setSaving(true);
    try {
      const r = await saveContractDraftAction(contractId, patch);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      setSaved(sentFields);
      setSavedVersion(sentVersion);
      setRemaining(r.value);
      // The action revalidates the page; no refresh here.
      toast.success(t("saved"));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const chosen = signers.find((s) => s.id === fields.signerContactId) ?? null;
  const namedInText = chosen === null || textOf(body).includes(chosen.name);
  const signerElsewhere = signer !== null && !signers.some((s) => s.id === signer.id) && fields.signerContactId === signer.id;

  return (
    <div className="flex flex-col gap-4" data-testid="contract-draft-editor">
      <SectionCard title={t("details")}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-1 sm:col-span-2">
            <Label htmlFor="contract-title">{t("title")}</Label>
            <Input
              id="contract-title"
              value={fields.title}
              maxLength={200}
              readOnly={!canEdit}
              onChange={(e) => set("title", e.target.value)}
              data-testid="contract-title"
            />
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <Label htmlFor="contract-signer">{t("signer")}</Label>
            <NativeSelect
              id="contract-signer"
              value={fields.signerContactId}
              disabled={!canEdit}
              onChange={(e) => set("signerContactId", e.target.value)}
              data-testid="contract-signer"
            >
              <option value="">{t("noSigner")}</option>
              {signerElsewhere ? <option value={signer!.id}>{signer!.name}</option> : null}
              {signers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </NativeSelect>
            <p className="text-xs text-muted-foreground">{t("signerHint")}</p>
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <Label htmlFor="contract-language">{t("language")}</Label>
            <NativeSelect
              id="contract-language"
              value={fields.language}
              disabled={!canEdit}
              onChange={(e) => set("language", e.target.value === "en" ? "en" : "sv")}
              data-testid="contract-language"
            >
              <option value="sv">{t("languages.sv")}</option>
              <option value="en">{t("languages.en")}</option>
            </NativeSelect>
            <p className="text-xs text-muted-foreground">{t("languageHint")}</p>
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <Label htmlFor="contract-starts">{t("startsOn")}</Label>
            <Input
              id="contract-starts"
              type="date"
              value={fields.startsOn}
              readOnly={!canEdit}
              onChange={(e) => set("startsOn", e.target.value)}
              data-testid="contract-starts"
            />
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <Label htmlFor="contract-ends">{t("endsOn")}</Label>
            <Input
              id="contract-ends"
              type="date"
              value={fields.endsOn}
              readOnly={!canEdit}
              onChange={(e) => set("endsOn", e.target.value)}
              data-testid="contract-ends"
            />
          </div>
          <p className="text-xs text-muted-foreground sm:col-span-2">{t("datesHint")}</p>
        </div>
      </SectionCard>

      {signerElsewhere ? (
        <Callout tone="caution" title={t("signerCannotSign", { name: signer!.name })}>
          {t("signerHint")}
        </Callout>
      ) : null}
      {remaining.length > 0 ? (
        <div data-testid="contract-remaining">
          <Callout tone="caution" title={t("remainingTitle")}>
            {t("remainingBody", { keys: remaining.map((k) => tFill(`keys.${k}`)).join(", ") })}
          </Callout>
        </div>
      ) : null}
      {!namedInText ? (
        <div data-testid="contract-signer-not-named">
          <Callout tone="caution" title={t("signerNotInText", { name: chosen!.name })} />
        </div>
      ) : null}

      <SectionCard title={t("text")}>
        <ContractBodyEditor
          id="contract-body"
          initialDoc={initialBody}
          placeholder={t("textPlaceholder")}
          ariaLabel={t("text")}
          fillIns={false}
          readOnly={!canEdit}
          testId="contract-body"
          onChange={(doc) => {
            setBody(doc);
            setBodyVersion((v) => v + 1);
          }}
        />
      </SectionCard>

      <div className="flex flex-wrap items-center gap-2">
        {canEdit ? (
          <Button type="button" onClick={() => void save()} aria-disabled={saving || !dirty} data-testid="contract-save">
            {t("save")}
          </Button>
        ) : null}
        <Button asChild variant="outline">
          <a href={`/contracts/${contractId}/preview`} data-testid="contract-preview">
            <FileTextIcon aria-hidden="true" />
            {t("preview")}
          </a>
        </Button>
        {dirty ? (
          <span className="text-xs text-muted-foreground" data-testid="contract-unsaved">
            {t("unsaved")}
          </span>
        ) : null}
      </div>
    </div>
  );
}
