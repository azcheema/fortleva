import type { ServiceRow } from "@/services/service";

/**
 * One agreement as its read-first row draws it (slice 113). Directive-free
 * (AGENTS.md: a `"use client"` module's constant in a server component's
 * markup becomes a client reference), so the server page builds it with
 * every label already formatted — money and dates go through the server's
 * formatters, the text the row shows is the text the server rendered.
 */
export type AgreementItem = {
  readonly id: string;
  readonly name: string;
  readonly kind: ServiceRow["kind"];
  readonly billingInterval: ServiceRow["billingInterval"];
  readonly status: ServiceRow["status"];
  readonly project: { readonly key: string } | null;
  /** The stored price as typed back into its field ("1200.00"), or null. */
  readonly price: string | null;
  /** The price's AMOUNT ("1 200,00"), or null — the row draws its currency beside it. */
  readonly priceLabel: string | null;
  /** The agreement's own currency, or null (then the workspace's default is shown). */
  readonly currency: string | null;
  /** `YYYY-MM-DD` (the stored date's UTC day), and its label. */
  readonly renewsOn: string | null;
  readonly renewsLabel: string | null;
  readonly endsOn: string | null;
  readonly endsLabel: string | null;
  /** The open bill rate, formatted; undefined = the reader lacks `rate:view_bill` (the field does not exist, UI.md rule 14). */
  readonly rate?: string | null;
  /** This month's hours on it, formatted, or null for none. */
  readonly thisMonth: string | null;
};

/** The earliest and latest day a date field offers — the service's own range (2000–2199). */
export const DAY_MIN = "2000-01-01";
export const DAY_MAX = "2199-12-31";

/** The UTC day of a stored date — every form writes UTC midnight. */
export const utcDayOf = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);
