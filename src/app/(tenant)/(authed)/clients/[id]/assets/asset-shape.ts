import type { AssetFieldKind, AssetStatus, AssetType } from "@/modules/vault";

/**
 * What the Assets tab's client components are handed — a DIRECTIVE-FREE,
 * import-free module (a type import erases), because the vault module's
 * index reaches Prisma and must never be bundled for the browser. The
 * per-type field specs come down from the page as a prop (`fieldsByType`)
 * for the same reason. Everything that depends on TODAY — the days left,
 * the formatted date and cost — is computed on the server, so the browser
 * never renders a different day from the server's (the process-zone
 * hydration trap).
 */

export type AssetItem = {
  readonly id: string;
  readonly type: AssetType;
  readonly name: string;
  readonly provider: string | null;
  readonly url: string | null;
  readonly identifier: string | null;
  readonly status: AssetStatus;
  /** The renewal date as `YYYY-MM-DD`, or null. */
  readonly expiresOn: string | null;
  /** That date as the member reads it ("3 Mar 2027"), formatted on the server. */
  readonly expiresLabel: string | null;
  /** Whole days from the member's today to the renewal date; negative once it has passed. */
  readonly daysLeft: number | null;
  readonly autoRenew: boolean | null;
  /** Decimal(12,2) as a string, the value the cost input edits. */
  readonly renewalCost: string | null;
  readonly currency: string | null;
  /** The cost's AMOUNT as the member reads it ("1 200,00"), formatted on the server; the currency is drawn beside it. */
  readonly amountLabel: string | null;
  readonly fields: Readonly<Record<string, string | readonly string[] | number>>;
  readonly notes: string | null;
  /** The project it hangs on, or null for a client-level asset. */
  readonly project: { readonly key: string; readonly name: string } | null;
};

export type AssetFieldsByType = Readonly<Record<AssetType, readonly { readonly key: string; readonly kind: AssetFieldKind }[]>>;

/**
 * Every per-type field name any type has (`ASSET_FIELDS` in the vault
 * module, which this module may not import) — so a label can be looked up
 * by a TYPED key. `asset-shape.test.ts` holds the two lists together.
 */
export const ASSET_FIELD_KEYS = ["nameservers", "plan", "server", "domains", "mailboxes", "platform", "version", "seats"] as const;
export type AssetFieldKey = (typeof ASSET_FIELD_KEYS)[number];

/** A field name from the server as its label key; an unknown one reads as "plan" (never reached). */
export const assetFieldLabelKey = (key: string): `fields.${AssetFieldKey}` =>
  `fields.${(ASSET_FIELD_KEYS as readonly string[]).includes(key) ? (key as AssetFieldKey) : "plan"}`;

/** A stored field value as one line of text — a list joined, a count as digits. */
export const assetFieldText = (value: string | readonly string[] | number | undefined): string =>
  value === undefined ? "" : Array.isArray(value) ? value.join(", ") : String(value);

/**
 * The days a date input offers — the service refuses a year outside
 * 2000–2199 (`EXPIRY_YEAR_MIN/MAX` in the vault module, which this module
 * may not import; `asset-shape.test.ts` holds them together).
 */
export const DAY_MIN = "2000-01-01";
export const DAY_MAX = "2199-12-31";

/** How close a renewal date may come before the tab flags it. */
export const SOON_DAYS = 30;

/**
 * The cue a row and the "coming up" strip draw: nothing for a retired
 * asset or one with no date or a date further out than `SOON_DAYS`.
 */
export type ExpiryCue = "expired" | "today" | "soon";

export function expiryCue(status: AssetStatus, daysLeft: number | null): ExpiryCue | null {
  if (status !== "ACTIVE" || daysLeft === null) return null;
  if (daysLeft < 0) return "expired";
  if (daysLeft === 0) return "today";
  return daysLeft <= SOON_DAYS ? "soon" : null;
}

/** Whole days from `today` to `day`, both `YYYY-MM-DD` — calendar days, no zone involved. */
export function daysBetween(today: string, day: string): number {
  return Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}
