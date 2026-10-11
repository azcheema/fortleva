import { AuthzError, deny } from "@/authz/errors";
import { authorizePortal, withPortalRead, type PortalPrincipal } from "@/portal";

import { partiesFromFrozen } from "./parties";
import { isContractLocale, readFrozenParties, type ContractLocale, type ContractParties } from "./print";

/**
 * THE CONTRACTS MODULE'S PORTAL PROJECTION — a client's contracts, as the
 * client reads them (Phase 4 slice 112b2; founder decisions C84, C85). Reads
 * only, under the contact principal, allow-listed; both tripwire tiers scan
 * this file (`src/authz/portal-projections.test.ts`).
 *
 * WHICH: every contract of the contact's own client that was WRITTEN in
 * Fortleva and SENT — waiting for a signature, signed, declined or withdrawn
 * (the client sees "Withdrawn": the design's §0). `contract`'s `portal_gate`
 * holds exactly that (the client, not a draft, sent) and
 * `portal_contract_primary` holds it to a MAIN contact (AUTHZ §8: contracts
 * are a main contact's, as invoices are); every read here restates the terms
 * and asks `portal.contract.view` as well. Since slice 112c, also every
 * contract SIGNED ELSEWHERE that the agency has chosen to SHOW (C86 (a): its
 * switch is off until someone turns it on) — read as its title, the day it was
 * signed, its term and its file: no text, parties, signatures or fingerprint
 * exist for one (the PDF is the record).
 *
 * WHAT A CLIENT IS TOLD: the title, the version, the language, the dates, the
 * status, the parties as the send froze them, the text, the fingerprint both
 * signatures attest to, whether each PDF is ready, and the two signatures by
 * NAME — who, what they typed, when, and the reason a client gave when
 * declining. NEVER: a member's id (the sender, the withdrawer, the author),
 * EITHER signature's email address (C85 (e): the portal shows the agency's
 * sender by name only), the template, the evidence of the client's signature
 * (class A), a draft.
 *
 * "WAITING FOR YOUR SIGNATURE" IS THE CONTRACT'S STATUS AND THE ROW'S, BOTH:
 * the contract SENT and its client row PENDING and this person's (the design's
 * §12 item 8). A withdrawn contract's client row stays PENDING for ever — the
 * row alone would count it.
 *
 * In SEQUENCE inside each transaction (AGENTS.md's `Promise.all` trap).
 */

export type PortalContractStatus = "SENT" | "SIGNED" | "DECLINED" | "WITHDRAWN";

export type PortalContractRow = {
  readonly id: string;
  readonly title: string;
  readonly version: number;
  readonly status: PortalContractStatus;
  /** Written in Fortleva and sent, or signed elsewhere and shown (slice 112c). */
  readonly origin: "WRITTEN" | "UPLOADED";
  /** When it was sent — a written contract's; null for one signed elsewhere. */
  readonly sentAt: Date | null;
  /** `YYYY-MM-DD`, the workspace's day — a signed contract's. */
  readonly signedOn: string | null;
  /** Sent, and waiting for THIS person's signature. */
  readonly waitingForYou: boolean;
};

export type PortalSignature = {
  readonly party: "TENANT" | "CLIENT";
  /** The signer as the record names them — the agency's sender, or the client's signer. */
  readonly name: string;
  /**
   * PENDING only while the CONTRACT waits; a withdrawn contract's client row,
   * which stays PENDING in the database for ever, reads NOT_SIGNED (the
   * "waiting" rule above, on the page too — the pre-apply review's low).
   */
  readonly status: "PENDING" | "SIGNED" | "DECLINED" | "NOT_SIGNED";
  /** What they typed to sign. */
  readonly typedName: string | null;
  readonly decidedAt: Date | null;
  /** The client's own words when declining (read back to every main contact of the client). */
  readonly declineReason: string | null;
};

export type PortalContractDetail = PortalContractRow & {
  readonly language: ContractLocale;
  /** `YYYY-MM-DD`. */
  readonly startsOn: string | null;
  readonly endsOn: string | null;
  /** Both parties as the send froze them, printed in the contract's language; null when unreadable. */
  readonly parties: ContractParties | null;
  /** The frozen text — a canonical ProseMirror document of the contract schema. */
  readonly body: unknown;
  /** What both signatures attest to (hashed by the database at sending). */
  readonly contentSha256: string | null;
  readonly pdfReady: boolean;
  readonly signedCopyReady: boolean;
  /** The agency's first, then the client's. */
  readonly signatures: readonly PortalSignature[];
  /** This person may sign or decline it now: waiting for them, and their profile holds the verb. */
  readonly canSign: boolean;
};

/** The most one read returns; one past it says there were more. */
export const PORTAL_CONTRACT_LIMIT = 200;

const day = (d: Date | null): string | null => (d === null ? null : d.toISOString().slice(0, 10));

const isShownStatus = (s: string): s is PortalContractStatus =>
  s === "SENT" || s === "SIGNED" || s === "DECLINED" || s === "WITHDRAWN";

/**
 * `portal_gate`'s terms on `contract`, restated: the client's own, not a
 * draft, and EITHER written in Fortleva and sent OR signed elsewhere and SHOWN
 * (slice 112c — C86 (a): off until someone turns it on).
 */
const contractGate = (principal: PortalPrincipal) => ({
  tenantId: principal.tenantId,
  clientId: principal.clientId,
  status: { not: "DRAFT" as const },
  OR: [
    { origin: "WRITTEN" as const, sentAt: { not: null } },
    { origin: "UPLOADED" as const, shownToClient: true },
  ],
});

const waitsFor = (
  principal: PortalPrincipal,
  status: string,
  rows: readonly { readonly status: string; readonly signerContactId: string | null }[],
): boolean =>
  status === "SENT" && rows.some((r) => r.status === "PENDING" && r.signerContactId === principal.contactId);

/** The contact's own client's sent contracts, newest sent first. */
export async function listPortalContracts(
  principal: PortalPrincipal,
): Promise<{ readonly contracts: readonly PortalContractRow[]; readonly truncated: boolean }> {
  return withPortalRead(principal, async (tx) => {
    await authorizePortal(tx, principal, "portal.contract.view", { kind: "client", clientId: principal.clientId });
    const rows = await tx.contract.findMany({
      where: contractGate(principal),
      // Newest first by when each entered Fortleva (a contract signed
      // elsewhere was never sent).
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: PORTAL_CONTRACT_LIMIT + 1,
      select: {
        id: true,
        title: true,
        version: true,
        status: true,
        origin: true,
        sentAt: true,
        createdAt: true,
        signedOn: true,
        // The client's row, to say whether it waits for this person — an
        // inline literal, as every portal select must be (the tripwire).
        signatures: { where: { party: "CLIENT" }, select: { status: true, signerContactId: true } },
      },
    });
    const truncated = rows.length > PORTAL_CONTRACT_LIMIT;
    rows.splice(PORTAL_CONTRACT_LIMIT);
    // Newest SENT first — one put in counts from when it was put in (it was
    // never sent): the order a client would expect (the code review's low).
    const at = (r: { sentAt: Date | null; createdAt: Date }) => (r.sentAt ?? r.createdAt).getTime();
    rows.sort((a, b) => at(b) - at(a) || (a.id < b.id ? 1 : -1));
    const contracts = rows.flatMap((r): PortalContractRow[] =>
      isShownStatus(r.status) && (r.origin === "UPLOADED" || r.sentAt !== null)
        ? [
            {
              id: r.id,
              title: r.title,
              version: r.version,
              status: r.status,
              origin: r.origin,
              sentAt: r.sentAt,
              signedOn: day(r.signedOn),
              waitingForYou: waitsFor(principal, r.status, r.signatures),
            },
          ]
        : [],
    );
    return { contracts, truncated };
  });
}

/** Whether the contact has any contract to see — the portal's nav entry (as Invoices). */
export async function portalContractsShown(principal: PortalPrincipal): Promise<boolean> {
  return withPortalRead(principal, async (tx) => {
    try {
      await authorizePortal(tx, principal, "portal.contract.view");
    } catch (e) {
      if (e instanceof AuthzError) return false;
      throw e;
    }
    // A yes or no on every portal page: the first row answers it (the code review's nit).
    return (await tx.contract.findFirst({ where: contractGate(principal), select: { id: true } })) !== null;
  });
}

/**
 * How many contracts wait for THIS person's signature — the home's card and
 * the weekly summary's line (C85 (d): the contract waits in the portal and on
 * the summary). Refused (an AuthzError) when the person may not see contracts:
 * the home reads that as none, the summary as a refused area.
 */
export async function countPortalContractsToSign(principal: PortalPrincipal): Promise<number> {
  return withPortalRead(principal, async (tx) => {
    await authorizePortal(tx, principal, "portal.contract.view");
    return tx.contractSignature.count({
      where: {
        tenantId: principal.tenantId,
        clientId: principal.clientId,
        party: "CLIENT",
        status: "PENDING",
        signerContactId: principal.contactId,
        // The CONTRACT's status too — never the row's alone (above).
        contract: { ...contractGate(principal), status: "SENT" },
      },
    });
  });
}

/** One sent contract, its text and its signatures. */
export async function readPortalContract(principal: PortalPrincipal, contractId: string): Promise<PortalContractDetail> {
  return withPortalRead(principal, async (tx) => {
    await authorizePortal(tx, principal, "portal.contract.view", { kind: "contract", contractId });
    const row = await tx.contract.findFirst({
      where: { id: contractId, ...contractGate(principal) },
      select: {
        id: true,
        title: true,
        version: true,
        status: true,
        origin: true,
        language: true,
        startsOn: true,
        endsOn: true,
        sentAt: true,
        signedOn: true,
        parties: true,
        body: true,
        contentSha256: true,
        pdfFileId: true,
        signedPdfFileId: true,
        signatures: {
          select: {
            party: true,
            signerName: true,
            signerContactId: true,
            status: true,
            typedName: true,
            decidedAt: true,
            declineReason: true,
          },
          orderBy: { party: "asc" }, // TENANT before CLIENT (the enum's declared order)
        },
      },
    });
    // Gone between the proof and this read (or malformed): the plane's one answer.
    if (!row || (row.origin === "WRITTEN" && row.sentAt === null) || !isShownStatus(row.status) || !isContractLocale(row.language)) {
      return deny("NOT_FOUND", "contract");
    }
    const frozen = readFrozenParties(row.parties);
    const waitingForYou = waitsFor(principal, row.status, row.signatures);
    let canSign = false;
    if (waitingForYou) {
      try {
        await authorizePortal(tx, principal, "portal.contract.sign", { kind: "contract", contractId });
        canSign = true;
      } catch (e) {
        if (!(e instanceof AuthzError)) throw e;
      }
    }
    return {
      id: row.id,
      title: row.title,
      version: row.version,
      status: row.status,
      origin: row.origin,
      sentAt: row.sentAt,
      signedOn: day(row.signedOn),
      waitingForYou,
      language: row.language,
      startsOn: day(row.startsOn),
      endsOn: day(row.endsOn),
      parties: frozen ? partiesFromFrozen(frozen, row.language) : null,
      body: row.body,
      contentSha256: row.contentSha256,
      pdfReady: row.pdfFileId !== null,
      signedCopyReady: row.status === "SIGNED" && row.signedPdfFileId !== null,
      signatures: row.signatures.map((s) => ({
        party: s.party,
        name: s.signerName,
        status: s.status === "PENDING" && row.status !== "SENT" ? "NOT_SIGNED" : s.status,
        typedName: s.typedName,
        decidedAt: s.decidedAt,
        declineReason: s.party === "CLIENT" ? s.declineReason : null,
      })),
      canSign,
    };
  });
}
