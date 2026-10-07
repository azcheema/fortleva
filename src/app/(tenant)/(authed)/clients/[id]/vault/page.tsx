import { KeyRoundIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { AddCredentialForm, type WhereOption } from "@/app/(tenant)/(authed)/vault/add-credential";
import { LoginAsksSection } from "@/app/(tenant)/(authed)/vault/login-asks";
import { clientSurface, clientWhere, projectWhere } from "@/app/(tenant)/(authed)/vault/surface";
import { NoRevealLine, openVaultPage, rowAbilitiesOf, VaultList } from "@/app/(tenant)/(authed)/vault/vault-page";
import { EmptyState, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { VaultLockTimer } from "@/components/vault/vault-lock-timer";
import { CREDENTIAL_TYPES, listCredentials, listLoginAsks, loginAskTargets, SECRET_FIELDS } from "@/modules/vault";

import { loadClient } from "../data";

/**
 * The client's Vault tab (Phase 3V; founder decision C52).
 *
 * **THE WHOLE VAULT IS LOCKED.** The tab exists for anyone with
 * `credential:view` (the client loader's cap); what it shows is the vault
 * module's own answer, through `openVaultPage` — the door until the member
 * has a fresh factor, then the list with its lock time, and at that time
 * the page refreshes into the door again. The list is every login of the
 * client the member's scope reaches: its client-level ones for a member
 * assigned to it directly, and each reachable project's, badged with the
 * project's key.
 *
 * Out of scope or without the code is a 404 (UI.md §7.3), as on every tab.
 */
export default async function ClientVaultPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const client = await loadClient(id);
  if (!client.caps.viewCredentials) notFound();
  const surface = clientSurface(client.id);

  // The logins, then the asks of the client and what an ask may offer
  // (slice 98) — each through the same door, in sequence.
  const opened = await openVaultPage(`/clients/${client.id}/vault`, async (ctx) => {
    const credentials = await listCredentials(ctx, { clientId: client.id });
    const asks = await listLoginAsks(ctx, { clientId: client.id });
    const targets = await loginAskTargets(ctx, { clientId: client.id, projectId: null });
    return { credentials, asks, targets };
  });
  if (opened.kind === "door") return opened.door;
  const {
    open,
    data: { credentials, asks, targets },
    msLeft,
  } = opened;

  const t = await getTranslations("vault");
  // Where a NEW login may hang: the client itself only for a member
  // assigned to it directly (AUTHZ §4 — the service refuses anyone else),
  // and any live project of the client the member can reach. An archived
  // client takes none (the service refuses it).
  const where: WhereOption[] =
    client.status === "ARCHIVED"
      ? []
      : [
          ...(client.direct ? [{ value: clientWhere(client.id), label: t("add.whereClient") }] : []),
          ...client.projects
            .filter((p) => p.status !== "ARCHIVED")
            .map((p) => ({ value: projectWhere(p.id), label: `${p.key} · ${p.name}` })),
        ];
  const canAdd = open.can.create && where.length > 0;
  const can = rowAbilitiesOf(open);

  return (
    <div className="flex flex-col gap-6">
      <SectionCard
        title={t("list.title")}
        description={t("list.logged")}
        actions={<VaultLockTimer locksAt={open.locksAt.toISOString()} msLeft={msLeft} />}
        contentClassName="p-0"
      >
        {credentials.length === 0 ? (
          <div className="px-4">
            {canAdd ? (
              <EmptyState
                variant="empty"
                icon={KeyRoundIcon}
                title={t("client.empty")}
                body={t("client.emptyDescription")}
                action={
                  <Button asChild size="sm">
                    <Link href="#new-credential">
                      <PlusIcon />
                      {t("add.title")}
                    </Link>
                  </Button>
                }
              />
            ) : (
              <EmptyState
                variant="forbidden"
                icon={KeyRoundIcon}
                title={t("client.emptyReadOnly")}
                body={t("client.emptyReadOnlyDescription")}
              />
            )}
          </div>
        ) : (
          <>
            <NoRevealLine can={can} />
            <VaultList surface={surface} items={credentials} can={can} showProject />
          </>
        )}
      </SectionCard>

      <LoginAsksSection surface={surface} clientId={client.id} clientName={client.name} asks={asks} targets={targets} />

      {canAdd ? (
        <SectionCard id="new-credential" className="scroll-mt-16" title={t("add.title")} description={t("add.description")}>
          <AddCredentialForm surface={surface} where={where} types={CREDENTIAL_TYPES} fieldsByType={SECRET_FIELDS} />
        </SectionCard>
      ) : null}
    </div>
  );
}
