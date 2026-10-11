/**
 * WHAT A CONTRACT'S PDF IS DRAWN FROM (Phase 4 slice 112; founder decision
 * C84 (a)) — a plain value, so the renderer stays a pure drawing and the
 * tests can build one without a database.
 *
 * Slice 112 draws a DRAFT's preview from the live client card and workspace
 * details; slice 112b draws the PDF as sent from the `parties` snapshot the
 * send froze (the same shape — `ContractParties`), and adds the signatures.
 */

export type ContractLocale = "en" | "sv";

export const CONTRACT_LOCALES: readonly ContractLocale[] = ["en", "sv"];

export const isContractLocale = (value: unknown): value is ContractLocale => value === "en" || value === "sv";

/** One party as printed: a name, and what the card holds of the rest. */
export type ContractParty = {
  readonly name: string;
  readonly orgNr: string | null;
  /** One line (`addressLine`), or null. */
  readonly address: string | null;
};

/** Both parties, as printed. */
export type ContractParties = {
  readonly agency: ContractParty;
  readonly client: ContractParty;
};

/**
 * One party as the SEND froze it into `contract.parties` (slice 112b) — the
 * guard's `jsonb_build_object`, so the database, not the app, decides what was
 * signed. The address is kept in its parts and printed in the contract's
 * language at drawing (`parties.ts`).
 */
export type FrozenParty = {
  readonly name: string;
  readonly orgNr: string | null;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly postalCode: string | null;
  readonly city: string | null;
  readonly countryCode: string | null;
};

const textOrNull = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

function frozenParty(raw: unknown): FrozenParty | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = textOrNull(r["name"]);
  if (name === null) return null;
  return {
    name,
    orgNr: textOrNull(r["orgNr"]),
    addressLine1: textOrNull(r["addressLine1"]),
    addressLine2: textOrNull(r["addressLine2"]),
    postalCode: textOrNull(r["postalCode"]),
    city: textOrNull(r["city"]),
    countryCode: textOrNull(r["countryCode"]),
  };
}

/** `contract.parties` read STRICTLY: both sides, each with a name — or null (a drawing refuses). */
export function readFrozenParties(raw: unknown): { readonly agency: FrozenParty; readonly client: FrozenParty } | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const agency = frozenParty(r["agency"]);
  const client = frozenParty(r["client"]);
  return agency && client ? { agency, client } : null;
}

/** One signature, as the signed copy's signature page prints it. */
export type SignaturePrint = {
  readonly party: "TENANT" | "CLIENT";
  /** The signer as the record names them. */
  readonly name: string;
  readonly email: string;
  /** What they typed to sign. */
  readonly typedName: string;
  /** When, already written out in the contract's language and the workspace's time zone. */
  readonly when: string;
};

export type ContractPrint = {
  readonly locale: ContractLocale;
  readonly title: string;
  readonly version: number;
  /** A draft's preview: every page says it is not the contract sent. */
  readonly draft: boolean;
  readonly parties: ContractParties;
  /** The normalised ProseMirror document (`normalizeContractBody`), or null for an empty draft. */
  readonly body: unknown;
  /**
   * Slice 112b — the SIGNED COPY: both signatures and the fingerprint they
   * attest to, drawn as a page of their own after the contract. Absent on a
   * preview and on the PDF as sent.
   */
  readonly signed?: {
    readonly signatures: readonly SignaturePrint[];
    readonly contentSha256: string;
  };
};

/** A file name a person recognises, safe on every filesystem. */
export function contractPdfFileName(title: string, version: number): string {
  const slug =
    title
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .toLowerCase() || "contract";
  return `${slug}-v${version}.pdf`;
}
