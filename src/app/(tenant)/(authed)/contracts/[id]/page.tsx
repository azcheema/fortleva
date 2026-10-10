import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { AuthzError } from "@/authz/errors";
import { isUuid } from "@/db/context";
import { Callout, EmptyState, Page, PageHeader, SectionCard } from "@/components/semantic";
import { Badge } from "@/components/ui/badge";
import { requireTenantContext } from "@/members/tenant-context";
import { contractVerbs, readContract, type ContractDetail } from "@/modules/contracts";

import { ContractDraftMenu } from "./draft-menu";
import { DraftEditor } from "./draft-editor";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("contracts.draft");
  return { title: t("pageTitle") };
}

const LINK =
  "rounded-sm text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/**
 * /contracts/[id] (Phase 4 slice 112; C84) — one contract. A DRAFT is its
 * editor: the details, the text, the fill-ins still in it, Preview PDF, and
 * Delete draft for `contract:delete`. Sending for signature is slice 112b;
 * nothing past DRAFT exists before it. `contract:view` and the client in
 * DIRECT scope, else not found (the service decides; the page never says
 * which gate).
 */
export default async function ContractPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { membership, actor } = await requireTenantContext();
  const ctx = { tenantId: membership.tenantId, actor };
  const t = await getTranslations("contracts.draft");
  const tStatus = await getTranslations("contracts.status");
  const tList = await getTranslations("contracts.list");
  const tCommon = await getTranslations("common");

  let contract: ContractDetail | null = null;
  try {
    contract = await readContract(ctx, id);
  } catch (e) {
    if (!(e instanceof AuthzError)) throw e;
    if (e.reason === "NOT_FOUND") notFound();
  }
  if (!contract) {
    return (
      <Page>
        <PageHeader title={tList("title")} />
        <div className="mt-6">
          <SectionCard>
            <EmptyState variant="forbidden" title={tCommon("forbiddenTitle")} body={tList("noPermission")} />
          </SectionCard>
        </div>
      </Page>
    );
  }

  const verbs = await contractVerbs(ctx);
  const draft = contract.status === "DRAFT";
  const signerGone = contract.signerContactId !== null && contract.signer === null;

  return (
    <Page>
      <div className="mb-2">
        <Link href="/contracts" className={LINK}>
          {t("back")}
        </Link>
      </div>
      <PageHeader
        title={contract.title}
        description={
          contract.templateName
            ? `${contract.client.name} · ${t("fromTemplate", { name: contract.templateName })}`
            : contract.client.name
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={draft ? "neutral" : "brand"} data-testid="contract-status">
              {draft ? t("draftBadge") : tStatus(contract.status)}
            </Badge>
            {draft && verbs.delete ? <ContractDraftMenu contractId={contract.id} /> : null}
          </div>
        }
      />
      <div className="mt-6 flex flex-col gap-4">
        {signerGone ? <Callout tone="caution" title={t("signerGone")} /> : null}
        {/* Never keyed on the row's `updated_at`: a save must not remount the
            editor and drop what was typed meanwhile (the code review's medium). */}
        <DraftEditor
          contractId={contract.id}
          initial={{
            title: contract.title,
            signerContactId: contract.signer ? contract.signer.id : "",
            language: contract.language,
            startsOn: contract.startsOn ?? "",
            endsOn: contract.endsOn ?? "",
          }}
          // A signer who is no longer a contact starts the form at "not chosen"
          // while the row still names them: the form is dirty from the start,
          // and Save clears it (the code review's low).
          stored={{
            title: contract.title,
            signerContactId: contract.signerContactId ?? "",
            language: contract.language,
            startsOn: contract.startsOn ?? "",
            endsOn: contract.endsOn ?? "",
          }}
          initialBody={contract.body}
          initialRemaining={contract.remainingFillIns}
          signers={contract.signers}
          signer={contract.signer}
          canEdit={draft && verbs.edit}
        />
      </div>
    </Page>
  );
}
