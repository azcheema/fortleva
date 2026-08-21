import { assertInScope, effectivePermissions } from "@/authz/authorize";
import { withTenant } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { fail } from "@/lib/domain-error";
import { readPreferences } from "@/preferences/service";

import { billAmountOf, money, principalOf, type TimeCtx } from "./ctx";
import { revealCostRates } from "./rates";
import { loadProjectEntries, type EntryRow, type Range } from "./rollup";

const REVEAL_BATCH = 50;

/** revealCostRates in ≤50-card batches (its cap), merged; each batch is its own audited reveal. */
async function revealCostRatesChunked(ctx: TimeCtx, cardIds: readonly string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (let i = 0; i < cardIds.length; i += REVEAL_BATCH) {
    Object.assign(out, await revealCostRates(ctx, cardIds.slice(i, i + REVEAL_BATCH)));
  }
  return out;
}

/**
 * The project money page (PLAN.md 2T screens; DATA_MODEL.md §6.15 "Who
 * sees money"; UI.md rule 14). Money is a ladder:
 *
 *  - **Value** — Σ billable seconds / 3600 × the `billRate` SNAPSHOT on
 *    each entry (resolved at write, never re-derived here). Needs
 *    `time:view_team` + `rate:view_bill` and scope on the project.
 *  - **Internal cost / margin** — the ✦ half. Cost is never stored on
 *    an entry: the aggregation is SUM(seconds) GROUP BY cost_rate_card_id
 *    and the handful of COST cards are decrypted by `revealCostRates`
 *    behind `rate:view_cost` + a fresh factor, audited once per reveal
 *    (ids only). The caller asks for it explicitly (`revealCost`); a
 *    holder with a stale factor gets MFA_REQUIRED, which the page turns
 *    into step-up navigation. Without the permission — or with the
 *    tenant's cost layer (`finance.costRates.enabled`) off — the request
 *    is ignored and cost stays null: nothing is leaked, nothing errors.
 *
 * Cost counts EVERY hour (non-billable time costs money too); value
 * counts billable hours only. Entries with no COST card behind them are
 * counted in `uncostedSeconds` so an understated cost is never silent.
 * A COST card in a currency other than the project's withholds cost and
 * margin (the flag explains why) — two currencies never sum; there is no
 * FX in time money (plan §3.3).
 */

export type MoneyLine = {
  key: string;
  label: string;
  seconds: number;
  billableSeconds: number;
  /** Σ billable seconds / 3600 × billRate snapshot, 2 dp. */
  value: string;
  /** Σ seconds / 3600 × the member's COST card amount, 2 dp; null unless revealed. */
  cost: string | null;
  /** value − cost, 2 dp; null unless revealed. */
  margin: string | null;
  /** margin / value × 100, 1 dp; null when margin is null or value is 0. */
  marginPercent: number | null;
  /** Seconds with no COST card behind them (revealed only; 0 otherwise). */
  uncostedSeconds: number;
};

export type MoneyTotals = Omit<MoneyLine, "key" | "label"> & {
  /** value / billable hours, 2 dp; null when nothing billable was logged. */
  effectiveRate: string | null;
};

export type ProjectMoney = {
  projectId: string;
  range: Range;
  /** Project.billingCurrency, else the currency the entries carry. */
  currency: string | null;
  /** The actor holds rate:view_cost AND the tenant's cost layer is on — the UI may offer the reveal. */
  canRevealCost: boolean;
  /** The reveal was requested and the ✦ gate passed — cost/margin are filled. */
  costRevealed: boolean;
  /** A revealed COST card is in another currency than the project — cost and margin withheld. */
  currencyMismatch: boolean;
  totals: MoneyTotals;
  byMember: MoneyLine[];
  byEpic: MoneyLine[];
  byItem: (MoneyLine & { epicKey: string | null })[];
  byAgreement: MoneyLine[];
};

const hours = (seconds: number): number => seconds / 3600;

type CostTable = Readonly<Record<string, string>> | null;

function sumLine(rows: EntryRow[], costOf: CostTable): Omit<MoneyLine, "key" | "label"> {
  let seconds = 0;
  let billableSeconds = 0;
  let value = 0;
  let cost = 0;
  let uncosted = 0;
  for (const r of rows) {
    seconds += r.durationSeconds;
    if (r.billable) billableSeconds += r.durationSeconds;
    value += billAmountOf(r);
    if (costOf) {
      const rate = r.costRateCardId ? costOf[r.costRateCardId] : undefined;
      if (rate !== undefined) cost += hours(r.durationSeconds) * Number(rate);
      else uncosted += r.durationSeconds;
    }
  }
  const margin = costOf ? value - cost : null;
  return {
    seconds,
    billableSeconds,
    value: money(value),
    cost: costOf ? money(cost) : null,
    margin: margin === null ? null : money(margin),
    marginPercent: margin !== null && value > 0 ? Math.round((margin / value) * 1000) / 10 : null,
    uncostedSeconds: costOf ? uncosted : 0,
  };
}

function groupLines(
  rows: EntryRow[],
  keyOf: (r: EntryRow) => string | null,
  labelOf: (r: EntryRow) => string,
  costOf: CostTable,
  fallbackKey: string,
): { line: MoneyLine; rows: EntryRow[] }[] {
  const buckets = new Map<string, { label: string; rows: EntryRow[] }>();
  for (const r of rows) {
    const k = keyOf(r);
    const key = k ?? fallbackKey;
    const b = buckets.get(key) ?? { label: k === null ? "" : labelOf(r), rows: [] };
    b.rows.push(r);
    buckets.set(key, b);
  }
  return [...buckets.entries()]
    .map(([key, b]) => ({ line: { key, label: b.label, ...sumLine(b.rows, costOf) }, rows: b.rows }))
    .sort((a, b) => Number(b.line.value) - Number(a.line.value) || b.line.seconds - a.line.seconds);
}

const lineOf = (g: { line: MoneyLine }): MoneyLine => g.line;

/** time:view_team + rate:view_bill + scope; `revealCost` adds the ✦ half (rate:view_cost + fresh factor, audited). */
export async function projectMoney(
  ctx: TimeCtx,
  projectId: string,
  range: Range,
  opts: { revealCost: boolean } = { revealCost: false },
): Promise<ProjectMoney> {
  const loaded = await withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "time:view_team");
    await requireAccess(tx, ctx.tenantId, ctx.actor, "rate:view_bill");
    await assertInScope(tx, ctx.actor, { projectId });
    const [project, held, prefs] = await Promise.all([
      tx.project.findFirst({ where: { tenantId: ctx.tenantId, id: projectId }, select: { billingCurrency: true } }),
      // Held, not "fresh": the control shows for holders; a stale factor becomes step-up on the reveal (AUTHZ.md §7.5).
      effectivePermissions(tx, ctx.actor.memberId),
      readPreferences(tx, ctx.tenantId),
    ]);
    if (!project) fail("INVALID_INPUT", "unknown project");
    const canRevealCost = held.has("rate:view_cost") && prefs.finance.costRatesEnabled;
    const rows = await loadProjectEntries(tx, ctx.tenantId, projectId, range);
    const cardIds = [...new Set(rows.map((r) => r.costRateCardId).filter((id): id is string => id !== null))];
    // Card currencies are metadata (the ciphertext is omitted globally); read only for a holder who may reveal.
    const cardCurrency = new Map<string, string>();
    if (canRevealCost && cardIds.length > 0) {
      const cards = await tx.rateCard.findMany({
        where: { tenantId: ctx.tenantId, kind: "COST", id: { in: cardIds } },
        select: { id: true, currency: true },
      });
      for (const c of cards) cardCurrency.set(c.id, c.currency);
    }
    const currency = project!.billingCurrency ?? rows.find((r) => r.currency)?.currency ?? null;
    return { currency, canRevealCost, rows, cardIds, cardCurrency };
  });

  // The ✦ half runs as its own audited transaction (rate:view_cost + fresh factor; ids only in the audit row).
  // revealCostRates caps one reveal at 50 cards; a long range on a large
  // project (one COST card per member per revision) degrades to more
  // reveals — each audited — never to an error.
  const costOf: CostTable = opts.revealCost && loaded.canRevealCost ? await revealCostRatesChunked(ctx, loaded.cardIds) : null;
  const costRevealed = costOf !== null;
  const currencyMismatch =
    costRevealed && loaded.currency !== null
      ? Object.keys(costOf).some((id) => (loaded.cardCurrency.get(id) ?? loaded.currency) !== loaded.currency)
      : false;
  // Two currencies never sum: on a mismatch the numbers are withheld and the flag says why.
  const usable: CostTable = currencyMismatch ? null : costOf;
  const rows = loaded.rows;

  const totals = sumLine(rows, usable);
  const effectiveRate = totals.billableSeconds > 0 ? money(Number(totals.value) / hours(totals.billableSeconds)) : null;

  return {
    projectId,
    range,
    currency: loaded.currency,
    canRevealCost: loaded.canRevealCost,
    costRevealed,
    currencyMismatch,
    totals: { ...totals, effectiveRate },
    byMember: groupLines(rows, (r) => r.memberId, (r) => r.memberName, usable, "__none").map(lineOf),
    byEpic: groupLines(rows, (r) => r.rootId, (r) => `${r.rootKey} ${r.rootTitle}`, usable, "__project").map(lineOf),
    byItem: groupLines(rows, (r) => r.workItemId, (r) => `${r.itemKey} ${r.itemTitle}`, usable, "__project").map(
      (g) => ({ ...g.line, epicKey: g.rows[0]?.rootKey ?? null }),
    ),
    byAgreement: groupLines(rows, (r) => r.serviceId, (r) => r.serviceName ?? "", usable, "__none").map(lineOf),
  };
}
