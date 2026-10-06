import type { Metadata } from "next";
import { KeyRoundIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { Callout, EmptyState, Page, PageHeader, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { VaultLockTimer } from "@/components/vault/vault-lock-timer";
import {
  CREDENTIAL_TYPES,
  listAllCredentials,
  listCredentials,
  SECRET_FIELDS,
  vaultIndex,
  VAULT_LIST_LIMIT,
  type CredentialListing,
} from "@/modules/vault";

import { AddCredentialForm } from "./add-credential";
import { ExportDialog, type ExportOption } from "./export-dialog";
import { SealedAsksBanner } from "./sealed-asks-banner";
import { AGENCY_WHERE, TENANT_SURFACE } from "./surface";
import { VaultFilter, type VaultFilterOption } from "./vault-filter";
import { openVaultPage, rowAbilitiesOf, VaultList } from "./vault-page";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("vault.tenant");
  return { title: t("title") };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The filter's "Change soon" view (slice 94): every login marked for a change. */
const CHANGE_SOON = "change-soon";

/**
 * THE TENANT'S VAULT — `/vault` (Phase 3V slice 86; UI.md §3.1's rail item).
 * Every login the member's scope reaches, in one place: OUR OWN first — the
 * agency's logins that belong to no client (the registrar, the agency's own
 * hosting), which only a member whose scope is the whole tenant reaches
 * (founder decision C49) — then each client's, by name, with a filter
 * (`?client=` — `agency` or a client's id) that narrows to one.
 *
 * Behind the same door as every vault page (`vault-page.tsx`, C52 (a)): the
 * index — which clients have logins, how many — is read through it too. The
 * list is capped at `VAULT_LIST_LIMIT` rows; past it the page says how many
 * there are and asks for a client.
 *
 * LOGINS TO CHANGE (slice 94): removing a member marks the logins they
 * could know "Change soon". While any are marked, a line above the list
 * says how many and the filter offers them on their own (`?client=change-
 * soon` — the filter's one parameter, as "our own" is), grouped as ever.
 *
 * EXPORT (slice 95, C63): a member who may export (`open.can.export`) gets
 * "Export…" beside the lock timer — everything they reach, our own, or one
 * client, as a file for a password manager (`export-dialog.tsx`); its link
 * to the exports page shows for a tenant-wide scope only.
 *
 * Adding here adds one of OUR OWN logins, and only for a member who reaches
 * them and may create: a client's logins are added where they belong, on
 * the client's or the project's Vault tab, which every client card links to.
 */
export default async function VaultPage({ searchParams }: { searchParams: Promise<{ client?: string | string[] }> }) {
  const { client: raw } = await searchParams;
  const asked =
    typeof raw === "string" && (raw === AGENCY_WHERE || raw === CHANGE_SOON || UUID.test(raw)) ? raw.toLowerCase() : null;
  const t = await getTranslations("vault");

  const opened = await openVaultPage(asked === null ? "/vault" : `/vault?client=${asked}`, async (ctx) => {
    const index = await vaultIndex(ctx);
    // A filter the index does not offer — our own for a member who does
    // not reach them, a client with nothing the member can see — shows all.
    const pick =
      asked === AGENCY_WHERE
        ? index.agency === null
          ? null
          : AGENCY_WHERE
        : asked === CHANGE_SOON
          ? index.changeSoon === 0
            ? null
            : CHANGE_SOON
          : asked !== null && index.clients.some((c) => c.id === asked)
            ? asked
            : null;
    // The cap belongs to the views across clients; one anchor is never capped.
    const listed =
      pick === null || pick === CHANGE_SOON
        ? await listAllCredentials(ctx, { changeSoon: pick === CHANGE_SOON })
        : {
            rows: await listCredentials(ctx, pick === AGENCY_WHERE ? { agencyOwn: true } : { clientId: pick }),
            cut: null,
          };
    return { index, pick, items: listed.rows, cut: listed.cut };
  });

  const header = (actions: React.ReactNode) => (
    <PageHeader title={t("tenant.title")} description={t("tenant.description")} actions={actions} />
  );
  if (opened.kind === "door") {
    return (
      <Page width="wide">
        {header(null)}
        <div className="mt-6 flex flex-col gap-6">
          <SealedAsksBanner />
          {opened.door}
        </div>
      </Page>
    );
  }

  const { open, msLeft } = opened;
  const { index, pick, items, cut } = opened.data;
  const truncated = cut !== null;
  /** Whether the cap's cut went through this card: its anchor is the first row left out. */
  const cutThrough = (clientId: string | null) => cut !== null && cut.clientId === clientId;
  const can = rowAbilitiesOf(open);
  const total = (index.agency ?? 0) + index.clients.reduce((n, c) => n + c.count, 0);
  const countOf = new Map(index.clients.map((c) => [c.id, c.count]));
  const changeSoonView = pick === CHANGE_SOON;

  const showOwn = index.agency !== null && (pick === null || pick === AGENCY_WHERE || changeSoonView);
  // Adding belongs to the views of a place, not to a list of logins to change.
  const canAddOwn = showOwn && open.can.create && !changeSoonView;
  const own = items.filter((c) => c.client === null);
  // The client rows arrive ordered by client name; group them in that order.
  const byClient = new Map<string, { name: string; rows: CredentialListing[] }>();
  for (const c of items) {
    if (c.client === null) continue;
    const group = byClient.get(c.client.id) ?? { name: c.client.name, rows: [] };
    group.rows.push(c);
    byClient.set(c.client.id, group);
  }

  const options: VaultFilterOption[] = [
    { value: "", label: t("tenant.all", { count: total }) },
    ...(index.changeSoon === 0 ? [] : [{ value: CHANGE_SOON, label: t("tenant.changeSoon", { count: index.changeSoon }) }]),
    ...(index.agency === null ? [] : [{ value: AGENCY_WHERE, label: t("tenant.agency", { count: index.agency }) }]),
    ...index.clients.map((c) => ({ value: c.id, label: t("tenant.client", { name: c.name, count: c.count }) })),
  ];

  // The export's choices (slice 95, C63 (c)): everything, our own (where the
  // member reaches them), or one client — the filter's own, without the
  // "Change soon" view, which is a list to work through, not a place.
  const exportOptions: ExportOption[] = [
    { value: "", label: t("tenant.all", { count: total }) },
    ...(index.agency === null ? [] : [{ value: AGENCY_WHERE, label: t("tenant.agency", { count: index.agency }) }]),
    ...index.clients.map((c) => ({ value: c.id, label: t("tenant.client", { name: c.name, count: c.count }) })),
  ];

  const addOwnLink = (
    <Button asChild size="sm">
      <Link href="#new-credential">
        <PlusIcon />
        {t("tenant.addAgency")}
      </Link>
    </Button>
  );

  return (
    <Page width="wide">
      {header(
        <div className="flex flex-wrap items-center gap-2">
          {open.can.export && total > 0 ? (
            // The exports page is for a tenant-wide scope only (`listVaultExports`),
            // which is exactly when the index reaches our own logins.
            <ExportDialog options={exportOptions} historyHref={index.agency === null ? null : "/vault/exports"} />
          ) : null}
          <VaultLockTimer locksAt={open.locksAt.toISOString()} msLeft={msLeft} />
        </div>,
      )}

      <div className="mt-6 flex flex-col gap-6">
        <SealedAsksBanner />
        <div className="flex flex-col gap-2">
          <VaultFilter value={pick ?? ""} options={options} />
          <p className="text-xs text-muted-foreground">{t("list.logged")}</p>
          {/* Once for the page, not once per card — and only over a list. */}
          {can.reveal || items.length === 0 ? null : <p className="text-xs text-muted-foreground">{t("list.noReveal")}</p>}
        </div>

        {index.changeSoon > 0 && !changeSoonView ? (
          <div data-testid="vault-change-soon">
            <Callout tone="caution">
              <span>{t("tenant.changeSoonLine", { count: index.changeSoon })} </span>
              <Link
                href={`/vault?client=${CHANGE_SOON}`}
                className="rounded-sm text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              >
                {t("tenant.changeSoonShow")}
              </Link>
            </Callout>
          </div>
        ) : null}

        {truncated ? (
          <Callout tone="caution" role="status">
            {/* The total is the index's, read a moment apart from the list:
                never let it claim fewer rows than the list just proved. */}
            {/* On the "Change soon" list a client's view would mix in logins
                that need nothing, and a card cut part way says nothing: the
                rest come into this list as these are changed. */}
            {changeSoonView
              ? t("tenant.changeSoonTruncated", {
                  limit: VAULT_LIST_LIMIT,
                  total: Math.max(index.changeSoon, VAULT_LIST_LIMIT + 1),
                })
              : t("tenant.truncated", { limit: VAULT_LIST_LIMIT, total: Math.max(total, VAULT_LIST_LIMIT + 1) })}
          </Callout>
        ) : null}

        {showOwn && (own.length > 0 || canAddOwn) ? (
          <div data-testid="vault-group" data-group="agency">
            <SectionCard title={t("tenant.agencyTitle")} description={t("tenant.agencyDescription")} contentClassName="p-0">
              {own.length === 0 ? (
                <div className="px-4">
                  <EmptyState
                    variant="empty"
                    icon={KeyRoundIcon}
                    title={t("tenant.emptyAgency")}
                    body={t("tenant.emptyAgencyDescription")}
                    action={addOwnLink}
                  />
                </div>
              ) : (
                <>
                  <VaultList surface={TENANT_SURFACE} items={own} can={can} showProject />
                  {cutThrough(null) && !changeSoonView ? (
                    <PartialLine shown={own.length} count={index.agency ?? 0} href={`/vault?client=${AGENCY_WHERE}`} />
                  ) : null}
                </>
              )}
            </SectionCard>
          </div>
        ) : null}

        {[...byClient].map(([clientId, group]) => (
          <div key={clientId} data-testid="vault-group" data-group={clientId}>
            <SectionCard
              title={
                <Link
                  href={`/clients/${clientId}/vault`}
                  className="rounded-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  {group.name}
                </Link>
              }
              contentClassName="p-0"
            >
              <VaultList surface={TENANT_SURFACE} items={group.rows} can={can} showProject />
              {cutThrough(clientId) && !changeSoonView ? (
                <PartialLine shown={group.rows.length} count={countOf.get(clientId) ?? 0} href={`/vault?client=${clientId}`} />
              ) : null}
            </SectionCard>
          </div>
        ))}

        {items.length === 0 && !canAddOwn ? (
          <SectionCard>
            {/* Nothing to add HERE (a client's logins are added on its tab), so
                not the `empty` variant, whose contract is a verb on this page. */}
            <EmptyState variant="forbidden" icon={KeyRoundIcon} title={t("tenant.empty")} body={t("tenant.emptyDescription")} />
          </SectionCard>
        ) : null}

        {canAddOwn ? (
          <div className="max-w-(--content-form)">
            <SectionCard id="new-credential" className="scroll-mt-16" title={t("tenant.addAgency")} description={t("add.description")}>
              <AddCredentialForm
                surface={TENANT_SURFACE}
                where={[{ value: AGENCY_WHERE, label: t("tenant.agencyPlace") }]}
                types={CREDENTIAL_TYPES}
                fieldsByType={SECRET_FIELDS}
              />
            </SectionCard>
          </div>
        ) : null}
      </div>
    </Page>
  );
}

/**
 * Under the card the cap cut part way (slice 86's security review): the
 * card's title is the client's name, and a member rotating "every Acme
 * login" must not take 4 of 10 for all of them. Drawn on exactly the card
 * the list read says it cut (`cut`); the count is the index's, read a
 * moment apart, so it is never allowed to claim fewer than the cut proved.
 * The link is the one-client view, which is never capped.
 */
async function PartialLine({ shown, count, href }: { shown: number; count: number; href: string }) {
  const t = await getTranslations("vault.tenant");
  const total = Math.max(count, shown + 1);
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border px-4 py-2 text-xs text-muted-foreground" data-testid="vault-partial">
      <span>{t("partial", { shown, count: total })}</span>
      <Link
        href={href}
        className="rounded-sm text-foreground underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {t("showAll", { count: total })}
      </Link>
    </p>
  );
}
