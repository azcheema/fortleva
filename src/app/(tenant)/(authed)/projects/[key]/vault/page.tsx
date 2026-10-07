import { KeyRoundIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { AddCredentialForm } from "@/app/(tenant)/(authed)/vault/add-credential";
import { LoginAsksSection } from "@/app/(tenant)/(authed)/vault/login-asks";
import { projectSurface, projectWhere } from "@/app/(tenant)/(authed)/vault/surface";
import { NoRevealLine, openVaultPage, rowAbilitiesOf, VaultList } from "@/app/(tenant)/(authed)/vault/vault-page";
import { EmptyState, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { VaultLockTimer } from "@/components/vault/vault-lock-timer";
import { CREDENTIAL_TYPES, listCredentials, listLoginAsks, loginAskTargets, SECRET_FIELDS } from "@/modules/vault";

import { loadProject } from "../data";

/**
 * A project's Vault tab (Phase 3V slice 86; PLAN 3V's "Project → Vault
 * (filtered)"): the logins that hang on THIS project — the hosting, the
 * CMS, staging — behind the same door, with the same rows, as the client's
 * tab (`vault/vault-page.tsx`). A login of the client as a whole is not
 * listed here: it is the client's, reached only by a member assigned to the
 * client directly (AUTHZ §4), on the client's tab. No line points there:
 * a member who reaches the project alone may open the client's page but
 * not those logins, and would be sent to a list without them.
 *
 * A new login added here hangs on this project, so there is nothing to
 * choose; an archived project takes none (the service refuses it).
 * Without `credential:view` on all four gates there is no tab, and the
 * typed URL is a 404 (UI.md §7.3).
 */
export default async function ProjectVaultPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const project = await loadProject(key);
  if (!project.caps.viewCredentials) notFound();
  const surface = projectSurface(project.key);

  // The logins, then this project's asks and what an ask may offer here
  // (slice 98) — each through the same door, in sequence.
  const opened = await openVaultPage(`/projects/${project.key}/vault`, async (ctx) => {
    const credentials = await listCredentials(ctx, { projectId: project.id });
    const asks = await listLoginAsks(ctx, { projectId: project.id });
    const targets = await loginAskTargets(ctx, { clientId: project.client.id, projectId: project.id });
    return { credentials, asks, targets };
  });
  if (opened.kind === "door") return opened.door;
  const {
    open,
    data: { credentials, asks, targets },
    msLeft,
  } = opened;

  const t = await getTranslations("vault");
  const canAdd = open.can.create && project.status !== "ARCHIVED";
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
                title={t("project.empty")}
                body={t("project.emptyDescription")}
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
                title={t("project.emptyReadOnly")}
                body={t("project.emptyReadOnlyDescription")}
              />
            )}
          </div>
        ) : (
          <>
            <NoRevealLine can={can} />
            <VaultList surface={surface} items={credentials} can={can} showProject={false} />
          </>
        )}
      </SectionCard>

      <LoginAsksSection
        surface={surface}
        clientId={project.client.id}
        clientName={project.client.name}
        asks={asks}
        targets={targets}
      />

      {canAdd ? (
        <SectionCard id="new-credential" className="scroll-mt-16" title={t("add.title")} description={t("add.description")}>
          <AddCredentialForm
            surface={surface}
            where={[{ value: projectWhere(project.id), label: `${project.key} · ${project.name}` }]}
            types={CREDENTIAL_TYPES}
            fieldsByType={SECRET_FIELDS}
          />
        </SectionCard>
      ) : null}
    </div>
  );
}
