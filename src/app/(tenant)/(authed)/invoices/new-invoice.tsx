"use client";

import { PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";

import { createDraftAction } from "./actions";

export type InvoiceableClient = {
  readonly id: string;
  readonly name: string;
  readonly projects: readonly { readonly id: string; readonly key: string; readonly name: string }[];
};

/**
 * A NEW DRAFT, inline (UI.md rule 1: no modal for create; rule 2: one
 * required choice) — the client, and optionally one of its live projects;
 * "Create draft" makes it and opens it. The selects are controlled and the
 * action is called from a click, never a `<form action>` (React 19 resets a
 * form around its action, so a refusal would clear the picks). Starts on the
 * list's filtered client when there is one.
 */
export function NewInvoice({ clients, initialClientId }: { clients: readonly InvoiceableClient[]; initialClientId: string }) {
  const t = useTranslations("invoices.new");
  const router = useRouter();
  const [clientId, setClientId] = useState(clients.some((c) => c.id === initialClientId) ? initialClientId : "");
  const [projectId, setProjectId] = useState("");
  const [pending, start] = useTransition();
  const projects = clients.find((c) => c.id === clientId)?.projects ?? [];

  const create = () => {
    if (pending) return;
    if (!clientId) {
      toast.error(t("pickClient"));
      return;
    }
    start(async () => {
      const r = await createDraftAction(clientId, projectId || null);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      router.push(`/invoices/${r.value}`);
    });
  };

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end" data-testid="new-invoice">
      <div className="flex min-w-0 flex-col gap-1">
        <Label htmlFor="new-invoice-client">{t("client")}</Label>
        <NativeSelect
          id="new-invoice-client"
          className="w-full sm:w-64"
          value={clientId}
          onChange={(e) => {
            setClientId(e.target.value);
            setProjectId("");
          }}
        >
          <option value="">{t("pickClientOption")}</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </NativeSelect>
      </div>
      {projects.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor="new-invoice-project">{t("project")}</Label>
          <NativeSelect
            id="new-invoice-project"
            className="w-full sm:w-56"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">{t("noProject")}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {t("projectOption", { key: p.key, name: p.name })}
              </option>
            ))}
          </NativeSelect>
        </div>
      ) : null}
      <Button type="button" onClick={create} aria-disabled={pending} data-testid="new-invoice-create">
        <PlusIcon aria-hidden="true" />
        {t("create")}
      </Button>
    </div>
  );
}
