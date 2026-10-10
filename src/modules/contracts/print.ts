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

/** Both parties — the shape slice 112b freezes into `contract.parties`. */
export type ContractParties = {
  readonly agency: ContractParty;
  readonly client: ContractParty;
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
