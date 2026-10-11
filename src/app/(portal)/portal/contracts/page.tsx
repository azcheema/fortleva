import type { Metadata } from "next";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";

import { Callout, Page, PageHeader, SectionCard } from "@/components/semantic";
import { listPortalContracts } from "@/modules/contracts/portal";
import { portalReadOrNull } from "@/portal";
import { requirePortalContext } from "@/portal/context";

import { PortalFrame } from "../portal-frame";
import { PortalTasksEmpty } from "../task-list";
import { ContractStateBadge } from "./state-badge";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("portal.contracts");
  return { title: t("title") };
}

/**
 * `/portal/contracts` — THE CLIENT'S CONTRACTS (Phase 4 slice 112b2; founder
 * decisions C84, C85): every contract of their company the agency has SENT,
 * newest first — its title, version, the day it was sent and where it stands
 * (waiting for a signature — "for yours" when it is the reader's —, signed,
 * declined, withdrawn). Main contacts only (AUTHZ §8 — and the database's
 * `portal_contract_primary`).
 *
 * A LIST, NOT A TABLE: one row per contract whose facts wrap on a phone (the
 * invoices page's shape).
 *
 * NO VIEW-AS TWIN, as Invoices: View-as is open to members who hold no
 * `contract:view`, so it must not be a way to read contracts; the nav entry is
 * still drawn inside View-as's frame from a count.
 *
 * Every way this can be empty is one page (`portalReadOrNull`): not a main
 * contact, the module closed, nothing sent yet.
 */
export default async function PortalContractsPage() {
  const { principal, name } = await requirePortalContext();
  const t = await getTranslations("portal.contracts");
  const format = await getFormatter();
  const list = await portalReadOrNull("listPortalContracts", () => listPortalContracts(principal));
  const contracts = list?.contracts ?? [];

  return (
    <PortalFrame name={name} principal={principal} nav="contracts">
      <Page>
        <div className="flex flex-col gap-6">
          <PageHeader title={t("title")} description={t("description")} />
          {contracts.length === 0 ? (
            <PortalTasksEmpty />
          ) : (
            <>
              {list?.truncated ? <Callout tone="info">{t("truncated", { count: contracts.length })}</Callout> : null}
              <SectionCard contentClassName="p-0">
                <ul className="divide-y divide-border" data-testid="portal-contracts">
                  {contracts.map((c) => (
                    <li
                      key={c.id}
                      data-testid="portal-contract-row"
                      data-status={c.status}
                      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3"
                    >
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <Link
                          href={`/portal/contracts/${c.id}`}
                          prefetch={false}
                          className="rounded-sm text-sm font-medium break-words underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        >
                          {c.title}
                        </Link>
                        <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                          {c.origin === "WRITTEN" ? <span>{t("version", { version: c.version })}</span> : null}
                          {c.sentAt ? (
                            <span className="num">{t("sentOn", { date: format.dateTime(c.sentAt, { dateStyle: "medium" }) })}</span>
                          ) : c.signedOn ? (
                            // Signed elsewhere (slice 112c): the day it was signed, a stored day.
                            <span className="num">
                              {t("signedElsewhereOn", {
                                date: format.dateTime(new Date(`${c.signedOn}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" }),
                              })}
                            </span>
                          ) : null}
                        </span>
                      </span>
                      <ContractStateBadge status={c.status} waitingForYou={c.waitingForYou} />
                    </li>
                  ))}
                </ul>
              </SectionCard>
            </>
          )}
        </div>
      </Page>
    </PortalFrame>
  );
}
