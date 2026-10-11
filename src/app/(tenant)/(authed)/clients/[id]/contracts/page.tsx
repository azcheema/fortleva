import { FileSignatureIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { EmptyState, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { requireTenantContext } from "@/members/tenant-context";
import { CONTRACT_LIST_LIMIT, CONTRACT_UPLOAD_MAX_BYTES, listContracts } from "@/modules/contracts";

import { ContractTable } from "../../../contracts/contract-table";
import { UploadContract } from "../../../contracts/upload-contract";
import { loadClient } from "../data";

/**
 * The client's Contracts tab (Phase 4 slice 112c; founder decisions C84, C86):
 * every contract of this client — written in Fortleva, or signed elsewhere and
 * put in — in the one contracts table (`/contracts`'s), with Put in a signed
 * contract… for this client and a way to write a new one. The tab exists for
 * `contract:view` on all four gates and a DIRECT assignment (the client
 * loader's cap — contracts are read by direct scope, as agreements are); a
 * member without them gets a 404 (UI.md §7.3).
 */
export default async function ClientContractsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const client = await loadClient(id);
  if (!client.caps.viewContracts) notFound();
  const { membership, actor } = await requireTenantContext();
  const ctx = { tenantId: membership.tenantId, actor };
  const t = await getTranslations("clients.contracts");
  const listed = await listContracts(ctx, { clientId: client.id });
  const verbs = client.caps.createContracts ? (
    <div className="flex flex-wrap items-center gap-2">
      <UploadContract clients={[{ id: client.id, name: client.name }]} fixedClientId={client.id} maxBytes={CONTRACT_UPLOAD_MAX_BYTES} />
      <Button asChild size="sm" variant="outline">
        <Link href="/contracts#new-contract">{t("write")}</Link>
      </Button>
    </div>
  ) : null;

  return (
    <SectionCard
      title={t("title")}
      description={t("description")}
      contentClassName={listed.rows.length === 0 ? undefined : "p-0"}
    >
      {listed.rows.length === 0 ? (
        verbs ? (
          <EmptyState variant="empty" icon={FileSignatureIcon} title={t("empty")} body={t("emptyBody")} action={verbs} />
        ) : (
          <EmptyState variant="filtered" icon={FileSignatureIcon} title={t("empty")} />
        )
      ) : (
        <>
          {/* The verbs in a toolbar that WRAPS, never the card's header:
              there two long labels side by side were clipped on a phone,
              Swedish worst (the code review's low). An empty list carries
              them in its empty state. */}
          {verbs ? <div className="border-b border-border px-4 py-3">{verbs}</div> : null}
          <ContractTable rows={listed.rows} showClient={false} label={t("title")} />
          {listed.more ? (
            <p className="px-4 py-3 text-xs text-muted-foreground" data-testid="client-contracts-limited">
              {t("limited", { count: CONTRACT_LIST_LIMIT })}
            </p>
          ) : null}
        </>
      )}
    </SectionCard>
  );
}
