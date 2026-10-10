"use client";

import { PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import type { SignerOption } from "@/modules/contracts";

import { contractSignersAction, startContractAction } from "./actions";

/**
 * A NEW CONTRACT, inline (UI.md rule 1: no modal for create) — the client, a
 * template (or blank), optionally who signs for the client, and a title (the
 * template's name when left empty). "Start contract" makes it — the template's
 * fill-ins filled in — and opens it. Controlled fields and a click, never a
 * `<form action>` (React 19 resets a form around its action, so a refusal
 * would clear the picks). The signer list is the client's main contacts in the
 * portal, read when a client is picked.
 */
export function NewContract({
  clients,
  templates,
}: {
  clients: readonly { readonly id: string; readonly name: string }[];
  templates: readonly { readonly id: string; readonly name: string }[];
}) {
  const t = useTranslations("contracts.new");
  const router = useRouter();
  const [clientId, setClientId] = useState("");
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const [signers, setSigners] = useState<readonly SignerOption[] | null>(null);
  const [signerId, setSignerId] = useState("");
  const [title, setTitle] = useState("");
  const [pending, start] = useTransition();
  // The client the latest pick asked for: an answer for an earlier pick is
  // dropped, so a slow one never lists one client's people under another (the
  // code review's low).
  const askedFor = useRef("");

  const pickClient = (id: string) => {
    setClientId(id);
    setSignerId("");
    setSigners(null);
    askedFor.current = id;
    if (!id) return;
    void contractSignersAction(id).then((r) => {
      if (askedFor.current !== id) return;
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      setSigners(r.value);
    });
  };

  const create = () => {
    if (pending) return;
    if (!clientId) {
      toast.error(t("pickClient"));
      return;
    }
    if (!templateId && !title.trim()) {
      toast.error(t("titleNeeded"));
      return;
    }
    start(async () => {
      const r = await startContractAction({
        clientId,
        templateId: templateId || null,
        signerContactId: signerId || null,
        title: title.trim(),
      });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      router.push(`/contracts/${r.value}`);
    });
  };

  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-end" data-testid="new-contract">
      <div className="flex min-w-0 flex-col gap-1">
        <Label htmlFor="new-contract-client">{t("client")}</Label>
        <NativeSelect
          id="new-contract-client"
          className="w-full lg:w-56"
          value={clientId}
          onChange={(e) => pickClient(e.target.value)}
        >
          <option value="">{t("pickClientOption")}</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <Label htmlFor="new-contract-template">{t("template")}</Label>
        <NativeSelect
          id="new-contract-template"
          className="w-full lg:w-56"
          value={templateId}
          onChange={(e) => setTemplateId(e.target.value)}
        >
          {templates.map((tpl) => (
            <option key={tpl.id} value={tpl.id}>
              {tpl.name}
            </option>
          ))}
          <option value="">{t("blank")}</option>
        </NativeSelect>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <Label htmlFor="new-contract-signer">{t("signer")}</Label>
        <NativeSelect
          id="new-contract-signer"
          className="w-full lg:w-56"
          value={signerId}
          disabled={!clientId || signers === null || signers.length === 0}
          onChange={(e) => setSignerId(e.target.value)}
        >
          <option value="">{clientId && signers !== null && signers.length === 0 ? t("noSigners") : t("noSigner")}</option>
          {(signers ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <Label htmlFor="new-contract-title">{t("title")}</Label>
        <Input
          id="new-contract-title"
          className="w-full lg:w-56"
          value={title}
          maxLength={200}
          placeholder={templateId ? t("titlePlaceholder") : undefined}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <Button type="button" onClick={create} aria-disabled={pending} data-testid="new-contract-create">
        <PlusIcon aria-hidden="true" />
        {t("create")}
      </Button>
    </div>
  );
}
