import { GlobeIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";

import { Callout, EmptyState, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { withTenant } from "@/db";
import { resolveTimeZone } from "@/i18n/resolve";
import { localDateString } from "@/lib/duration";
import { requireTenantContext } from "@/members/tenant-context";
import { ASSET_FIELDS, ASSET_TYPES, listAssets, type AssetView } from "@/modules/vault";
import { CURRENCIES, readPreferences } from "@/preferences/service";

import { loadClient } from "../data";

import { AddAssetForm, type AssetWhereOption } from "./add-asset";
import { AssetRow } from "./asset-row";
import { daysBetween, expiryCue, type AssetItem } from "./asset-shape";

/**
 * The client's Assets tab (Phase 3V slice 87; DATA_MODEL.md §6.17
 * `ClientAsset`): what the agency looks after for the client — domains,
 * hosting, certificates, mailboxes, licences — with when each renews and
 * what a renewal costs. Read-first rows, an inline add form, and a strip
 * of what renews within thirty days (or already has) at the top.
 *
 * NOT behind the vault's door: nothing here is a secret, and the card says
 * where logins go instead. The tab exists for `asset:view` on all four
 * gates (the client loader's cap); the list is the registry's own scoped
 * answer — a member reached through one project sees that project's
 * assets. Out of scope or without the code is a 404 (UI.md §7.3).
 *
 * TODAY is the member's (the tenant's zone), computed here on the server
 * with every date and cost label, so the browser never draws a different
 * day from the one the server rendered.
 */
export default async function ClientAssetsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const client = await loadClient(id);
  if (!client.caps.viewAssets) notFound();
  const { membership, actor } = await requireTenantContext();
  const ctx = { tenantId: membership.tenantId, actor };

  const assets = await listAssets(ctx, { clientId: client.id });
  const prefs = await withTenant(membership.tenantId, { type: "member", id: membership.memberId }, (tx) =>
    readPreferences(tx, membership.tenantId),
  );
  const t = await getTranslations("assets");
  const format = await getFormatter();
  const today = localDateString(new Date(), await resolveTimeZone());

  const toItem = (a: AssetView): AssetItem => {
    const day = a.expiresAt === null ? null : a.expiresAt.toISOString().slice(0, 10);
    return {
      id: a.id,
      type: a.type,
      name: a.name,
      provider: a.provider,
      url: a.url,
      identifier: a.identifier,
      status: a.status,
      expiresOn: day,
      expiresLabel: day === null ? null : format.dateTime(new Date(`${day}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" }),
      daysLeft: day === null ? null : daysBetween(today, day),
      autoRenew: a.autoRenew,
      renewalCost: a.renewalCost,
      currency: a.currency,
      amountLabel:
        a.renewalCost === null ? null : format.number(Number(a.renewalCost), { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      fields: a.fields,
      notes: a.notes,
      project: a.project === null ? null : { key: a.project.key, name: a.project.name },
    };
  };
  const items = assets.map(toItem);
  // What renews within the window, or already has — soonest first.
  const coming = items
    .filter((i) => expiryCue(i.status, i.daysLeft) !== null)
    .sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0));

  // Where a NEW asset may hang: the client itself only for a member assigned
  // to it directly (AUTHZ §4 — the service refuses anyone else), and any live
  // project of the client the member can reach. An archived client takes none.
  const where: AssetWhereOption[] =
    client.status === "ARCHIVED"
      ? []
      : [
          ...(client.direct ? [{ value: "", label: t("add.whereClient") }] : []),
          ...client.projects
            .filter((p) => p.status !== "ARCHIVED")
            .map((p) => ({ value: p.id, label: `${p.key} · ${p.name}` })),
        ];
  const canAdd = client.caps.manageAssets && where.length > 0;
  const can = { manage: client.caps.manageAssets, delete: client.caps.deleteAssets };

  return (
    <div className="flex flex-col gap-6">
      {coming.length > 0 ? (
        <Callout tone="caution" role="status" title={t("coming.title", { count: coming.length })}>
          <ul className="flex flex-col gap-0.5" data-testid="assets-coming">
            {coming.map((i) => (
              <li key={i.id}>
                <Link href={`#asset-${i.id}`} className="font-medium underline-offset-4 hover:underline">
                  {i.name}
                </Link>
                {" — "}
                {i.daysLeft !== null && i.daysLeft < 0
                  ? t("coming.expired", { date: i.expiresLabel ?? "" })
                  : i.daysLeft === 0
                    ? i.autoRenew
                      ? t("coming.renewsToday")
                      : t("coming.today")
                    : i.autoRenew
                      ? t("coming.renewsIn", { days: i.daysLeft ?? 0 })
                      : t("coming.expiresIn", { days: i.daysLeft ?? 0 })}
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}

      <SectionCard title={t("list.title")} description={t("list.description")} contentClassName="p-0">
        {items.length === 0 ? (
          <div className="px-4">
            {canAdd ? (
              <EmptyState
                variant="empty"
                icon={GlobeIcon}
                title={t("list.empty")}
                body={t("list.emptyDescription")}
                action={
                  <Button asChild size="sm">
                    <Link href="#new-asset">
                      <PlusIcon />
                      {t("add.title")}
                    </Link>
                  </Button>
                }
              />
            ) : client.status === "ARCHIVED" ? (
              // Not "none you can see": an archived client takes no new
              // asset, whoever is looking (the code review).
              <EmptyState variant="forbidden" icon={GlobeIcon} title={t("list.empty")} body={t("list.emptyArchived")} />
            ) : (
              <EmptyState variant="forbidden" icon={GlobeIcon} title={t("list.emptyReadOnly")} body={t("list.emptyReadOnlyDescription")} />
            )}
          </div>
        ) : (
          <ul className="divide-y divide-border" data-testid="asset-list">
            {items.map((item) => (
              <AssetRow
                key={item.id}
                clientId={client.id}
                item={item}
                can={can}
                types={ASSET_TYPES}
                fieldsByType={ASSET_FIELDS}
                currencies={CURRENCIES}
                defaultCurrency={prefs.currencyDefault}
                showProject
              />
            ))}
          </ul>
        )}
      </SectionCard>

      {canAdd ? (
        <SectionCard id="new-asset" className="scroll-mt-16" title={t("add.title")} description={t("add.description")}>
          <AddAssetForm
            clientId={client.id}
            where={where}
            types={ASSET_TYPES}
            fieldsByType={ASSET_FIELDS}
            currencies={CURRENCIES}
            defaultCurrency={prefs.currencyDefault}
          />
        </SectionCard>
      ) : null}
    </div>
  );
}
