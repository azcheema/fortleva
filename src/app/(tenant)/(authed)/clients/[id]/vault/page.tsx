import { KeyRoundIcon, LockIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { StepUpForm } from "@/app/(tenant)/(authed)/account/step-up/step-up-form";
import { AuthzError, type MfaRemedy } from "@/authz/errors";
import { enrolUrl } from "@/authz/redirects";
import { EmptyState, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { VaultLockTimer } from "@/components/vault/vault-lock-timer";
import { requireTenantContext } from "@/members/tenant-context";
import {
  CREDENTIAL_TYPES,
  listCredentials,
  openVault,
  SECRET_FIELDS,
  type CredentialView,
  type OpenVault,
} from "@/modules/vault";

import { loadClient } from "../data";
import { AddCredentialForm, type WhereOption } from "./add-credential";
import { VaultRow } from "./vault-rows";
import type { VaultItem } from "./vault-shape";

/**
 * The client's Vault tab (Phase 3V; founder decision C52).
 *
 * **THE WHOLE VAULT IS LOCKED.** The tab exists for anyone with
 * `credential:view` (the client loader's cap); what it shows is the vault
 * module's own answer. `openVault` refuses a factor older than
 * `vault.stepUpMinutes` exactly as every vault service does, and the page
 * turns that refusal into THE DOOR: the one step-up form (UI.md §5.7 —
 * never a second MFA prompt), returning here, or — for a member with no
 * authenticator — the way to set one up. Inside, the list carries a lock
 * time, and when it passes the page refreshes into the door again.
 *
 * Out of scope or without the code is a 404 (UI.md §7.3), as on every tab.
 * Impersonation is refused by the services and lands there too.
 */
export default async function ClientVaultPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const client = await loadClient(id);
  if (!client.caps.viewCredentials) notFound();
  const { membership, actor } = await requireTenantContext();
  const ctx = { tenantId: membership.tenantId, actor };
  const here = `/clients/${client.id}/vault`;

  let open: OpenVault;
  let credentials: CredentialView[];
  try {
    open = await openVault(ctx);
    credentials = await listCredentials(ctx, { clientId: client.id });
  } catch (e) {
    if (e instanceof AuthzError && e.reason === "MFA_REQUIRED") {
      return <VaultDoor remedy={e.mfaRemedy ?? "step_up"} next={here} />;
    }
    if (e instanceof AuthzError) notFound();
    throw e;
  }

  const t = await getTranslations("clients.vault");
  // The server's clock is the one the door keeps: the lock timer gets the
  // time LEFT on it, never a time to compare with the browser's.
  const now = new Date();
  const projectById = new Map(client.projects.map((p) => [p.id, { key: p.key, name: p.name }]));
  const items: VaultItem[] = credentials.map((c) => ({
    id: c.id,
    type: c.type,
    name: c.name,
    username: c.username,
    url: c.url,
    notes: c.notes,
    secretFieldKeys: c.secretFieldKeys,
    hasTotp: c.hasTotp,
    needsRotation: c.needsRotation,
    project: c.projectId === null ? null : (projectById.get(c.projectId) ?? null),
  }));

  // Where a NEW login may hang: the client itself only for a member
  // assigned to it directly (AUTHZ §4 — the service refuses anyone else),
  // and any live project of the client the member can reach. An archived
  // client takes none (the service refuses it).
  const where: WhereOption[] =
    client.status === "ARCHIVED"
      ? []
      : [
          ...(client.direct ? [{ value: "client", label: t("add.whereClient") }] : []),
          ...client.projects
            .filter((p) => p.status !== "ARCHIVED")
            .map((p) => ({ value: p.id, label: `${p.key} · ${p.name}` })),
        ];
  const canAdd = open.can.create && where.length > 0;
  const can = { edit: open.can.edit, delete: open.can.delete, reveal: open.can.reveal };

  return (
    <div className="flex flex-col gap-6">
      <SectionCard
        title={t("title")}
        description={t("logged")}
        actions={<VaultLockTimer locksAt={open.locksAt.toISOString()} msLeft={open.locksAt.getTime() - now.getTime()} />}
        contentClassName="p-0"
      >
        {items.length === 0 ? (
          <div className="px-4">
            {canAdd ? (
              <EmptyState
                variant="empty"
                icon={KeyRoundIcon}
                title={t("empty")}
                body={t("emptyDescription")}
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
              <EmptyState variant="forbidden" icon={KeyRoundIcon} title={t("emptyReadOnly")} body={t("emptyReadOnlyDescription")} />
            )}
          </div>
        ) : (
          <>
            {can.reveal ? null : <p className="hairline-b px-4 py-2 text-xs text-muted-foreground">{t("noReveal")}</p>}
            <ul className="divide-y divide-border" data-testid="vault-list">
              {items.map((item) => (
                <VaultRow key={item.id} clientId={client.id} item={item} can={can} fieldsByType={SECRET_FIELDS} />
              ))}
            </ul>
          </>
        )}
      </SectionCard>

      {canAdd ? (
        <SectionCard id="new-credential" className="scroll-mt-16" title={t("add.title")} description={t("add.description")}>
          <AddCredentialForm clientId={client.id} where={where} types={CREDENTIAL_TYPES} fieldsByType={SECRET_FIELDS} />
        </SectionCard>
      ) : null}
    </div>
  );
}

/**
 * THE DOOR (C52 (a)): the vault is locked until the member confirms it is
 * them. The step-up form is the product's ONE second-factor prompt, posting
 * back here; a member with no authenticator is sent to set one up — the
 * vault never opens without one.
 */
async function VaultDoor({ remedy, next }: { remedy: MfaRemedy; next: string }) {
  const t = await getTranslations("clients.vault.door");
  // The step-up page's own anti-phishing line: one prompt, one promise.
  const tStep = await getTranslations("account.stepUp");
  const enrol = remedy === "enrol";
  return (
    <SectionCard>
      <div className="mx-auto flex max-w-sm flex-col gap-4 py-6" data-testid="vault-door" data-remedy={remedy}>
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="inline-flex size-10 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <LockIcon aria-hidden="true" className="size-5" />
          </span>
          <div>
            <h2 className="text-lg font-semibold text-foreground">{enrol ? t("enrolTitle") : t("title")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{enrol ? t("enrolBody") : t("body")}</p>
          </div>
        </div>
        {enrol ? (
          <Button asChild className="w-full">
            <Link href={enrolUrl(next)}>{t("enrolAction")}</Link>
          </Button>
        ) : (
          <StepUpForm next={next} />
        )}
        <p className="text-center text-xs text-muted-foreground">{tStep("reassurance")}</p>
      </div>
    </SectionCard>
  );
}
