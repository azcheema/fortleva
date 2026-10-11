import { SOON_DAYS } from "@/app/(tenant)/(authed)/clients/[id]/assets/asset-shape";
import type { ExpirationEntry } from "@/modules/vault";

/*
 * The expirations row's pure rules — where it leads and the words and weight
 * of its date — kept apart from the server component so a unit test can pin
 * them (`expiration-row.test.ts`; slice 112c2's code review).
 */

/**
 * Where a row leads: the asset's own line on the client's Assets tab, the
 * client's Agreements tab, or a contract's own page — only where that page
 * would open for the member (`linkable`: `client:view`, and direct
 * assignment for an agreement; a contract's row is read under its page's
 * own rule).
 */
export function expirationHref(e: ExpirationEntry): string | null {
  if (!e.linkable) return null;
  if (e.kind === "contractEnds") return `/contracts/${e.id}`;
  return e.kind === "asset" ? `/clients/${e.client.id}/assets#asset-${e.id}` : `/clients/${e.client.id}/agreements`;
}

export type Cue = {
  readonly key:
    | "expired"
    | "expiresToday"
    | "expiresIn"
    | "renewsToday"
    | "renewsIn"
    | "endsToday"
    | "endsIn"
    | "endPassed"
    | "ended";
  readonly tone: "danger" | "caution" | "neutral" | "quiet";
};

/**
 * The words and the weight of a row's date — the Assets tab's cue, so one
 * asset reads the same in both places: past it is danger; an asset that
 * lapses TODAY is danger too; within `SOON_DAYS` is caution — or neutral
 * when it renews by itself, an agreement's renewal included — and an
 * agreement ending today is caution; further out it is quiet. A signed
 * contract's end reads like an agreement's, but once passed it is CAUTION,
 * not danger: nothing is wrong with a contract that has ended — the line
 * stays a while so a renewal that slipped is noticed (C86 (e)).
 */
export function cueOf(e: ExpirationEntry, days: number): Cue {
  const near = days <= SOON_DAYS;
  if (e.kind === "contractEnds") {
    if (days < 0) return { key: "ended", tone: "caution" };
    if (days === 0) return { key: "endsToday", tone: "caution" };
    return { key: "endsIn", tone: near ? "caution" : "quiet" };
  }
  if (e.kind === "agreementEnds") {
    if (days < 0) return { key: "endPassed", tone: "danger" };
    if (days === 0) return { key: "endsToday", tone: "caution" };
    return { key: "endsIn", tone: near ? "caution" : "quiet" };
  }
  const renews = e.kind === "agreementRenews" || e.autoRenew === true;
  // An agreement's renewal is never in the past here: the feed reads
  // renewals from today on (`expirations.ts`), so only an asset lapses.
  if (days < 0) return { key: "expired", tone: "danger" };
  if (days === 0) return renews ? { key: "renewsToday", tone: "neutral" } : { key: "expiresToday", tone: "danger" };
  if (renews) return { key: "renewsIn", tone: near ? "neutral" : "quiet" };
  return { key: "expiresIn", tone: near ? "caution" : "quiet" };
}
