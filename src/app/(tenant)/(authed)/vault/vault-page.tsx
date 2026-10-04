import { LockIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { StepUpForm } from "@/app/(tenant)/(authed)/account/step-up/step-up-form";
import { AuthzError, type MfaRemedy } from "@/authz/errors";
import { enrolUrl } from "@/authz/redirects";
import { SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { requireTenantContext } from "@/members/tenant-context";
import { openVault, SECRET_FIELDS, type CredentialListing, type OpenVault, type VaultCtx } from "@/modules/vault";

import type { VaultSurface } from "./surface";
import { VaultRow, type VaultRowAbilities } from "./vault-row";
import type { VaultItem } from "./vault-shape";

/**
 * What every vault PAGE shares (Phase 3V slices 85–86): a client's tab, a
 * project's tab and the tenant's `/vault`.
 *
 * **THE WHOLE VAULT IS LOCKED** (C52 (a)). A page's reads go through
 * `openVaultPage`, which asks the vault module itself: `openVault` refuses a
 * factor older than `vault.stepUpMinutes` exactly as every vault service
 * does, and that refusal becomes THE DOOR — the one step-up form (UI.md
 * §5.7, never a second MFA prompt), returning to the page, or for a member
 * with no authenticator the way to set one up. Any other refusal is a 404
 * (UI.md §7.3) — impersonation included, which the services refuse.
 */

export type OpenedVault<T> =
  | {
      readonly kind: "open";
      readonly open: OpenVault;
      readonly data: T;
      /**
       * The time LEFT on the window, on the server's clock — what the lock
       * timer is handed, never a time to compare with the browser's.
       */
      readonly msLeft: number;
    }
  | { readonly kind: "door"; readonly door: React.ReactNode };

export async function openVaultPage<T>(next: string, read: (ctx: VaultCtx) => Promise<T>): Promise<OpenedVault<T>> {
  const { membership, actor } = await requireTenantContext();
  const ctx: VaultCtx = { tenantId: membership.tenantId, actor };
  let open: OpenVault;
  let data: T;
  try {
    open = await openVault(ctx);
    data = await read(ctx);
  } catch (e) {
    if (e instanceof AuthzError && e.reason === "MFA_REQUIRED") {
      return { kind: "door", door: <VaultDoor remedy={e.mfaRemedy ?? "step_up"} next={next} /> };
    }
    if (e instanceof AuthzError) notFound();
    throw e;
  }
  return { kind: "open", open, data, msLeft: open.locksAt.getTime() - Date.now() };
}

/**
 * THE DOOR (C52 (a)): the vault is locked until the member confirms it is
 * them. The step-up form is the product's ONE second-factor prompt, posting
 * back to `next`; a member with no authenticator is sent to set one up — the
 * vault never opens without one.
 */
async function VaultDoor({ remedy, next }: { remedy: MfaRemedy; next: string }) {
  const t = await getTranslations("vault.door");
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

/** A listed credential as a row draws it — names only, never a value. */
export const toVaultItem = (c: CredentialListing): VaultItem => ({
  id: c.id,
  type: c.type,
  name: c.name,
  username: c.username,
  url: c.url,
  notes: c.notes,
  secretFieldKeys: c.secretFieldKeys,
  hasTotp: c.hasTotp,
  needsRotation: c.needsRotation,
  project: c.project === null ? null : { key: c.project.key, name: c.project.name },
});

/** The row controls the open vault allows (`openVault().can`). */
export const rowAbilitiesOf = (open: OpenVault): VaultRowAbilities => ({
  edit: open.can.edit,
  delete: open.can.delete,
  reveal: open.can.reveal,
  share: open.can.share ? { maxHours: open.shareMaxHours } : null,
});

/** "You can see what is stored here…" — drawn above a list for a member who may not reveal. */
export async function NoRevealLine({ can }: { can: VaultRowAbilities }) {
  if (can.reveal) return null;
  const t = await getTranslations("vault.list");
  return <p className="hairline-b px-4 py-2 text-xs text-muted-foreground">{t("noReveal")}</p>;
}

/** One list of logins, every row the shared `VaultRow`. */
export function VaultList({
  surface,
  items,
  can,
  showProject,
}: {
  surface: VaultSurface;
  items: readonly CredentialListing[];
  can: VaultRowAbilities;
  showProject: boolean;
}) {
  return (
    <ul className="divide-y divide-border" data-testid="vault-list">
      {items.map((c) => (
        <VaultRow
          key={c.id}
          surface={surface}
          item={toVaultItem(c)}
          can={can}
          fieldsByType={SECRET_FIELDS}
          showProject={showProject}
        />
      ))}
    </ul>
  );
}
