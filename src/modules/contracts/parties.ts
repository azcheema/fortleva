import type { TenantDb } from "@/db";
import { fail } from "@/lib/domain-error";
import { todayIn } from "@/lib/due-date";
import { readPreferences } from "@/preferences/service";

import { addressLine, type FillInValues } from "./fill-ins";
import type { ContractLocale, ContractParties, ContractParty } from "./print";

/**
 * THE TWO PARTIES, READ LIVE (Phase 4 slice 112) — what a DRAFT's preview
 * prints and what its fill-ins are filled with: the workspace's company as
 * Settings → Invoicing → Company holds it (the legal name, else the
 * workspace's name), and the client's card. Slice 112b's send freezes the
 * same shape into `contract.parties`, built by the database.
 *
 * Plain reads under the member's own RLS — the caller has asked for the code
 * already. In SEQUENCE, never a `Promise.all` (AGENTS.md).
 */

type AddressParts = {
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly postalCode: string | null;
  readonly city: string | null;
  readonly countryCode: string | null;
};

/** "Storgatan 1, 111 22 Stockholm" — and the country's name when it is not Sweden. */
export function printedAddress(a: AddressParts, locale: ContractLocale): string | null {
  if (!a.addressLine1?.trim()) return null;
  const town = [a.postalCode?.trim(), a.city?.trim()].filter(Boolean).join(" ");
  const country = a.countryCode && a.countryCode !== "SE" ? countryName(a.countryCode, locale) : null;
  return addressLine([a.addressLine1, a.addressLine2, town, country]);
}

function countryName(code: string, locale: ContractLocale): string {
  try {
    return new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** "10 October 2026" / "10 oktober 2026" — a calendar day, written out. */
export function printedDay(isoDay: string, locale: ContractLocale): string {
  const [y, m, d] = isoDay.split("-").map(Number);
  return new Intl.DateTimeFormat(locale === "sv" ? "sv-SE" : "en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y!, m! - 1, d!)));
}

export type LiveParties = {
  readonly parties: ContractParties;
  /** The client's own language for documents, when its card says one. */
  readonly clientLocale: ContractLocale | null;
  readonly workspaceLocale: ContractLocale;
  readonly timezone: string;
};

/** Both parties as their records hold them now, printed in `locale`. */
export async function readLiveParties(
  tx: TenantDb,
  tenantId: string,
  clientId: string,
  locale: ContractLocale | null,
): Promise<LiveParties> {
  const tenant = await tx.tenant.findFirst({
    where: { id: tenantId },
    select: {
      name: true,
      legalName: true,
      orgNr: true,
      addressLine1: true,
      addressLine2: true,
      postalCode: true,
      city: true,
      countryCode: true,
      defaultLocale: true,
    },
  });
  if (!tenant) fail("INVALID_INPUT", "tenant");
  const client = await tx.client.findFirst({
    where: { tenantId, id: clientId },
    select: {
      name: true,
      orgNr: true,
      addressLine1: true,
      addressLine2: true,
      postalCode: true,
      city: true,
      countryCode: true,
      invoiceLocale: true,
    },
  });
  if (!client) fail("INVALID_INPUT", "client");
  const prefs = await readPreferences(tx, tenantId);
  const workspaceLocale: ContractLocale = tenant!.defaultLocale === "en" ? "en" : "sv";
  const clientLocale: ContractLocale | null =
    client!.invoiceLocale === "sv" || client!.invoiceLocale === "en" ? client!.invoiceLocale : null;
  const printIn = locale ?? clientLocale ?? workspaceLocale;
  const agency: ContractParty = {
    name: tenant!.legalName?.trim() || tenant!.name,
    orgNr: tenant!.orgNr?.trim() || null,
    address: printedAddress(tenant!, printIn),
  };
  const party: ContractParty = {
    name: client!.name,
    orgNr: client!.orgNr?.trim() || null,
    address: printedAddress(client!, printIn),
  };
  return { parties: { agency, client: party }, clientLocale, workspaceLocale, timezone: prefs.timezone };
}

/** What each fill-in is filled with when a contract is started (C84 (e)). */
export function fillInValuesFor(
  live: LiveParties,
  signerName: string | null,
  locale: ContractLocale,
  now: Date = new Date(),
): FillInValues {
  const { agency, client } = live.parties;
  return {
    client_name: client.name,
    client_org_nr: client.orgNr,
    client_address: client.address,
    signer_name: signerName,
    agency_name: agency.name,
    agency_org_nr: agency.orgNr,
    agency_address: agency.address,
    today: printedDay(todayIn(live.timezone, now), locale),
  };
}
