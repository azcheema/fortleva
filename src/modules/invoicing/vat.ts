/**
 * THE THREE VAT TREATMENTS (Phase 4; PLAN decision #3 — hard-coded, never a
 * tenant's own tax table). Pure: no database, so the unit suite covers it and
 * client components may import it.
 *
 *   SE_DOMESTIC        — Swedish VAT at 25, 12 or 6 % per line (EN 16931 "S").
 *   EU_REVERSE_CHARGE  — a business in another EU country with a VAT number:
 *                        no VAT charged, "Omvänd betalningsskyldighet" (AE).
 *   OUTSIDE_SCOPE      — a buyer outside the EU: services are outside the
 *                        scope of Swedish VAT (O).
 *
 * The seller is always the workspace's SWEDISH company (C75 (e), C19).
 */

export const VAT_PROFILES = ["SE_DOMESTIC", "EU_REVERSE_CHARGE", "OUTSIDE_SCOPE"] as const;
export type VatProfile = (typeof VAT_PROFILES)[number];

export const isVatProfile = (v: unknown): v is VatProfile =>
  typeof v === "string" && (VAT_PROFILES as readonly string[]).includes(v);

/**
 * The rates a line may carry under each treatment, in hundredths of a percent
 * (2500 = 25 %), the default first. The database restates the same table in
 * `invoice_line_guard` — change both together.
 */
export const VAT_RATES: Readonly<Record<VatProfile, readonly bigint[]>> = {
  SE_DOMESTIC: [2500n, 1200n, 600n],
  EU_REVERSE_CHARGE: [0n],
  OUTSIDE_SCOPE: [0n],
};

export const defaultRateFor = (profile: VatProfile): bigint => VAT_RATES[profile][0]!;

export const rateAllowed = (profile: VatProfile, rate: bigint): boolean => VAT_RATES[profile].includes(rate);

/**
 * The 27 EU member states by ISO 3166-1 alpha-2 — except that Greece's VAT
 * prefix is "EL", its country code "GR"; this list is COUNTRY codes, which is
 * what a client record holds.
 */
export const EU_COUNTRIES: ReadonlySet<string> = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
  "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
]);

/**
 * The treatment a new draft starts with when the client record has none saved:
 * a Swedish (or unknown-country) buyer pays Swedish VAT; a buyer elsewhere in
 * the EU with a VAT number is reverse charge; one without a VAT number is
 * treated as a consumer and pays Swedish VAT; a buyer outside the EU is outside
 * the scope. A suggestion only — the draft's select changes it, and issuing
 * checks it.
 */
export function suggestVatProfile(client: {
  readonly vatProfile: VatProfile | null;
  readonly countryCode: string | null;
  readonly vatNumber: string | null;
}): VatProfile {
  if (client.vatProfile) return client.vatProfile;
  const country = client.countryCode?.trim().toUpperCase() || null;
  if (country === null || country === "SE") return "SE_DOMESTIC";
  if (EU_COUNTRIES.has(country)) return client.vatNumber?.trim() ? "EU_REVERSE_CHARGE" : "SE_DOMESTIC";
  return "OUTSIDE_SCOPE";
}
