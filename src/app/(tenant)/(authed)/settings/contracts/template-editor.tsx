"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { ContractBodyEditor } from "@/components/contracts/contract-body-editor";
import { SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { saveContractTemplateAction } from "./actions";

/**
 * A CONTRACT TEMPLATE'S EDITOR (Phase 4 slice 112; C84 (e), (g)) — its name and
 * its text, with Insert fill-in. One button: Create (a new template, which then
 * opens) or Save. A save warns, as a caution toast, of any fill-in split by
 * formatting — it would never be filled in (the design review's item 14).
 */
export function TemplateEditor({
  templateId,
  initialName,
  initialBody,
}: {
  templateId: string | null;
  initialName: string;
  initialBody: unknown;
}) {
  const t = useTranslations("contracts.templates");
  const tFill = useTranslations("contracts.fillIns");
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [body, setBody] = useState<unknown>(initialBody);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  // Guarded on the action, not a transition (AGENTS.md); never remounted by a
  // save, so what is typed meanwhile stays in the editor (the code review's medium).
  const save = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    // A created template's editor is LEAVING (to its own address): it stays
    // "saving" until it is gone, or a second click in the navigation's window
    // would post a second create and be refused as a taken name (the fix
    // re-check's low).
    let leaving = false;
    try {
      const r = await saveContractTemplateAction(templateId, { name, body });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      if (r.value.splitFillIns.length > 0) {
        toast.warning(tFill("split", { keys: r.value.splitFillIns.map((k) => tFill(`keys.${k}`)).join(", ") }));
      } else {
        toast.success(templateId === null ? t("created") : t("saved"));
      }
      if (templateId === null) {
        leaving = true;
        router.push(`/settings/contracts/${r.value.id}`);
      }
    } finally {
      if (!leaving) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="contract-template-editor">
      <SectionCard>
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor="template-name">{t("name")}</Label>
          <Input
            id="template-name"
            value={name}
            maxLength={120}
            placeholder={t("namePlaceholder")}
            onChange={(e) => setName(e.target.value)}
            data-testid="template-name"
          />
        </div>
      </SectionCard>
      <SectionCard title={t("text")}>
        <ContractBodyEditor
          id="template-body"
          initialDoc={initialBody}
          placeholder={t("textPlaceholder")}
          ariaLabel={t("text")}
          fillIns
          testId="template-body"
          onChange={setBody}
        />
      </SectionCard>
      <div>
        <Button type="button" onClick={() => void save()} aria-disabled={saving} data-testid="template-save">
          {templateId === null ? t("create") : t("save")}
        </Button>
      </div>
    </div>
  );
}
