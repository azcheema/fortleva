/**
 * AN ORG. NUMBER AS TEN DIGITS (Phase 4 slice 114b; the design review's R3,
 * S6) — which company's books an invoice belongs in. The digits of a Swedish
 * organisation (or personal identity) number, a 12-digit form's century
 * (16, 18, 19, 20 — `normalizeOrgNr`'s) dropped; null for anything that is not
 * ten digits then, so two missing numbers are never "the same company".
 *
 * The app's twin of the database's `invoice_org_digits` (migration
 * 20261020090000), which holds the per-seller rule in the entry guard: the
 * night plans only the entries whose seller is the connected company, and a
 * member's file only the others — by this function, so the guard never
 * refuses what the plan picked. `fortnox-send.dbtest.ts` holds the two equal.
 */
export function orgDigitsOf(raw: string | null | undefined): string | null {
  const d = (raw ?? "").replace(/[^0-9]/g, "");
  if (/^(16|18|19|20)[0-9]{10}$/.test(d)) return d.slice(2);
  return /^[0-9]{10}$/.test(d) ? d : null;
}
