import { randomUUID } from "node:crypto";

import { record } from "@/audit/record";
import { assertInScope, requireRecentMfa } from "@/authz/authorize";
import { decryptFieldV2, encryptFieldV2 } from "@/crypto/field-encryption";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { dateColumn, isoDateOf } from "@/lib/duration";
import { fail } from "@/lib/domain-error";

import { guarded, idsOnly, principalOf, type TimeCtx } from "./ctx";

/**
 * Rates (DATA_MODEL.md §6.15 "Rate resolution", plan §3.3, D4):
 *  - RateCard rows are IMMUTABLE (trigger) — a change = close + insert;
 *  - resolution happens at entry WRITE, never at read, and the entry
 *    stores a plaintext BILL snapshot + the card ids (cost = id only);
 *  - BILL tiers: SERVICE (iff the entry carries an agreement — an
 *    explicit pick outranks ambient defaults) → PROJECT_MEMBER → PROJECT
 *    → MEMBER → TENANT; COST: MEMBER → TENANT, never per agreement;
 *  - the COST amount is v2-encrypted with AAD tenant:rate_card:<id>:amount,
 *    omitted from every read by src/db/client.ts, and decrypted only
 *    here behind rate:view_cost ✦ + a fresh factor, audited.
 */

export type RateKind = "BILL" | "COST";
export type RateScope = "TENANT" | "MEMBER" | "PROJECT" | "PROJECT_MEMBER" | "SERVICE";
export type RateSource = "SERVICE" | "PROJECT_MEMBER" | "PROJECT" | "MEMBER" | "TENANT" | "MANUAL" | "NONE";

export type RateSnapshot = {
  billRate: string | null;
  currency: string | null;
  rateSource: RateSource;
  billRateCardId: string | null;
  costRateCardId: string | null;
};

export const COST_REVEAL_WINDOW_MINUTES = 10;

const AMOUNT_RE = /^\d{1,10}(?:[.,]\d{1,2})?$/;
const normalizeAmount = (raw: string): string => {
  const s = raw.trim().replace(",", ".");
  if (!AMOUNT_RE.test(s)) fail("INVALID_INPUT", "amount must be a non-negative number with at most two decimals");
  return s;
};
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isoDate = (raw: string): string => {
  if (!DATE_RE.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) fail("INVALID_INPUT", "date");
  return raw;
};

type Candidate = {
  id: string;
  kind: RateKind;
  scope: RateScope;
  memberId: string | null;
  projectId: string | null;
  serviceId: string | null;
  amount: { toString(): string } | null;
  currency: string;
};

/**
 * Resolve the snapshot for one entry write. `localDate` is the entry's
 * local start date (rates are dated by the day the work happened).
 */
export async function resolveRateSnapshot(
  tx: TenantDb,
  args: {
    tenantId: string;
    memberId: string;
    projectId: string | null;
    serviceId: string | null;
    localDate: Date;
    billable: boolean;
  },
): Promise<RateSnapshot> {
  const cards: Candidate[] = await tx.rateCard.findMany({
    where: {
      tenantId: args.tenantId,
      effectiveFrom: { lte: args.localDate },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: args.localDate } }],
    },
    select: {
      id: true,
      kind: true,
      scope: true,
      memberId: true,
      projectId: true,
      serviceId: true,
      amount: true,
      currency: true,
    },
  });
  const pick = (kind: RateKind, scope: RateScope, match: (c: Candidate) => boolean) =>
    cards.find((c) => c.kind === kind && c.scope === scope && match(c)) ?? null;

  const cost =
    pick("COST", "MEMBER", (c) => c.memberId === args.memberId) ?? pick("COST", "TENANT", () => true);

  if (!args.billable || args.projectId === null) {
    return { billRate: null, currency: null, rateSource: "NONE", billRateCardId: null, costRateCardId: cost?.id ?? null };
  }
  const tiers: [RateSource, Candidate | null][] = [
    ["SERVICE", args.serviceId ? pick("BILL", "SERVICE", (c) => c.serviceId === args.serviceId) : null],
    ["PROJECT_MEMBER", pick("BILL", "PROJECT_MEMBER", (c) => c.projectId === args.projectId && c.memberId === args.memberId)],
    ["PROJECT", pick("BILL", "PROJECT", (c) => c.projectId === args.projectId)],
    ["MEMBER", pick("BILL", "MEMBER", (c) => c.memberId === args.memberId)],
    ["TENANT", pick("BILL", "TENANT", () => true)],
  ];
  const hit = tiers.find(([, c]) => c !== null);
  if (!hit || !hit[1]) {
    return { billRate: null, currency: null, rateSource: "NONE", billRateCardId: null, costRateCardId: cost?.id ?? null };
  }
  const [source, card] = hit;
  return {
    billRate: card.amount?.toString() ?? null,
    currency: card.currency,
    rateSource: source,
    billRateCardId: card.id,
    costRateCardId: cost?.id ?? null,
  };
}

export type RateCardView = {
  id: string;
  kind: RateKind;
  scope: RateScope;
  memberId: string | null;
  projectId: string | null;
  serviceId: string | null;
  /** BILL: the plaintext amount. COST: null until revealCostRates(). */
  amount: string | null;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: Date;
};

const toView = (c: {
  id: string;
  kind: RateKind;
  scope: RateScope;
  memberId: string | null;
  projectId: string | null;
  serviceId: string | null;
  amount: { toString(): string } | null;
  currency: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  createdAt: Date;
}): RateCardView => ({
  id: c.id,
  kind: c.kind,
  scope: c.scope,
  memberId: c.memberId,
  projectId: c.projectId,
  serviceId: c.serviceId,
  amount: c.kind === "BILL" ? (c.amount?.toString() ?? null) : null,
  currency: c.currency,
  effectiveFrom: isoDateOf(c.effectiveFrom),
  effectiveTo: c.effectiveTo ? isoDateOf(c.effectiveTo) : null,
  createdAt: c.createdAt,
});

const viewSelect = {
  id: true,
  kind: true,
  scope: true,
  memberId: true,
  projectId: true,
  serviceId: true,
  amount: true,
  currency: true,
  effectiveFrom: true,
  effectiveTo: true,
  createdAt: true,
} as const;

/** Scope axes a card must carry for its scope (the CHECK is the floor). */
function axesFor(
  scope: RateScope,
  input: { memberId?: string | null; projectId?: string | null; serviceId?: string | null },
): { memberId: string | null; projectId: string | null; serviceId: string | null } {
  const m = input.memberId ?? null;
  const p = input.projectId ?? null;
  const s = input.serviceId ?? null;
  const need = (cond: boolean, what: string) => {
    if (!cond) fail("INVALID_INPUT", `rate card scope ${scope}: ${what}`);
  };
  switch (scope) {
    case "TENANT":
      need(!m && !p && !s, "no member/project/service");
      return { memberId: null, projectId: null, serviceId: null };
    case "MEMBER":
      need(!!m && !p && !s, "member only");
      return { memberId: m, projectId: null, serviceId: null };
    case "PROJECT":
      need(!m && !!p && !s, "project only");
      return { memberId: null, projectId: p, serviceId: null };
    case "PROJECT_MEMBER":
      need(!!m && !!p && !s, "member + project");
      return { memberId: m, projectId: p, serviceId: null };
    case "SERVICE":
      need(!m && !p && !!s, "service only");
      return { memberId: null, projectId: null, serviceId: s };
  }
}

async function assertCardScope(
  tx: TenantDb,
  ctx: TimeCtx,
  axes: { memberId: string | null; projectId: string | null; serviceId: string | null },
): Promise<void> {
  if (axes.projectId) await assertInScope(tx, ctx.actor, { projectId: axes.projectId });
  if (axes.serviceId) {
    const service = await tx.service.findFirst({
      where: { tenantId: ctx.tenantId, id: axes.serviceId },
      select: { clientId: true, projectId: true },
    });
    if (!service) fail("INVALID_INPUT", "unknown agreement");
    if (service!.projectId) await assertInScope(tx, ctx.actor, { projectId: service!.projectId });
    else await assertInScope(tx, ctx.actor, { clientId: service!.clientId });
  }
  if (axes.memberId) {
    const member = await tx.member.findFirst({
      where: { tenantId: ctx.tenantId, id: axes.memberId },
      select: { id: true },
    });
    if (!member) fail("INVALID_INPUT", "unknown member");
  }
}

async function requireKindAccess(tx: TenantDb, ctx: TimeCtx, kind: RateKind, verb: "manage" | "view") {
  if (kind === "BILL") {
    await requireAccess(tx, ctx.tenantId, ctx.actor, verb === "manage" ? "rate:manage_bill" : "rate:view_bill");
  } else {
    await requireAccess(tx, ctx.tenantId, ctx.actor, verb === "manage" ? "rate:manage_cost" : "rate:view_cost");
    await requireRecentMfa(ctx.actor, COST_REVEAL_WINDOW_MINUTES);
  }
}

/**
 * rate:manage_bill / rate:manage_cost (✦ + step-up). `closeOpen` closes
 * the currently open card of the same dimension at `effectiveFrom` in
 * the same transaction — the "change a rate" gesture; the UI wording is
 * pinned: "applies from <date>; past entries unchanged; use Reprice to
 * correct history". A conflicting open card without closeOpen is a
 * RATE_OVERLAP (the EXCLUDE constraint decides, not the app).
 */
export async function createRateCard(
  ctx: TimeCtx,
  input: {
    kind: RateKind;
    scope: RateScope;
    memberId?: string | null;
    projectId?: string | null;
    serviceId?: string | null;
    amount: string;
    currency: string;
    effectiveFrom: string;
    closeOpen?: boolean;
  },
): Promise<RateCardView> {
  const amount = normalizeAmount(input.amount);
  const effectiveFrom = isoDate(input.effectiveFrom);
  const currency = input.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) fail("INVALID_INPUT", "currency");
  if (input.kind === "COST" && !(input.scope === "MEMBER" || input.scope === "TENANT")) {
    fail("INVALID_INPUT", "COST cards are MEMBER or TENANT scoped — never per agreement or project");
  }
  const axes = axesFor(input.scope, input);

  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await requireKindAccess(tx, ctx, input.kind, "manage");
      await assertCardScope(tx, ctx, axes);

      if (input.closeOpen) {
        const open = await tx.rateCard.findFirst({
          where: {
            tenantId: ctx.tenantId,
            kind: input.kind,
            scope: input.scope,
            memberId: axes.memberId,
            projectId: axes.projectId,
            serviceId: axes.serviceId,
            effectiveTo: null,
          },
          select: { id: true, effectiveFrom: true },
        });
        if (open) {
          if (isoDateOf(open.effectiveFrom) > effectiveFrom) fail("RATE_OVERLAP", "new card starts before the open one");
          await tx.rateCard.update({ where: { id: open.id }, data: { effectiveTo: dateColumn(effectiveFrom) } });
          await record(tx, {
            action: "rate_card.closed",
            targetType: "RateCard",
            targetId: open.id,
            metadata: { effectiveTo: effectiveFrom, replacedBy: "new" },
          });
        }
      }

      const id = randomUUID();
      const amountCiphertext =
        input.kind === "COST"
          ? await encryptFieldV2(tx, { tenantId: ctx.tenantId, model: "rate_card", rowId: id, field: "amount" }, amount)
          : null;
      const row = await tx.rateCard.create({
        data: {
          id,
          tenantId: ctx.tenantId,
          kind: input.kind,
          scope: input.scope,
          memberId: axes.memberId,
          projectId: axes.projectId,
          serviceId: axes.serviceId,
          amount: input.kind === "BILL" ? amount : null,
          amountCiphertext,
          currency,
          effectiveFrom: dateColumn(effectiveFrom),
          createdByMemberId: ctx.actor.memberId,
        },
        select: viewSelect,
      });
      await record(tx, {
        action: "rate_card.created",
        targetType: "RateCard",
        targetId: id,
        // ids + dates only — never the cost amount (SECURITY.md §9.7.4)
        metadata: idsOnly({
          kind: input.kind,
          scope: input.scope,
          memberId: axes.memberId,
          projectId: axes.projectId,
          serviceId: axes.serviceId,
          currency,
          effectiveFrom,
        }),
      });
      return toView(row);
    }),
  );
}

/** Close an open card (the only mutation the trigger permits). */
export async function closeRateCard(ctx: TimeCtx, id: string, effectiveTo: string): Promise<void> {
  const to = isoDate(effectiveTo);
  await withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      const card = await tx.rateCard.findFirst({
        where: { tenantId: ctx.tenantId, id },
        select: { kind: true, memberId: true, projectId: true, serviceId: true, effectiveFrom: true, effectiveTo: true },
      });
      if (!card) fail("INVALID_INPUT", "unknown rate card");
      await requireKindAccess(tx, ctx, card!.kind, "manage");
      await assertCardScope(tx, ctx, { memberId: card!.memberId, projectId: card!.projectId, serviceId: card!.serviceId });
      if (card!.effectiveTo) fail("RATE_CARD_IMMUTABLE", "already closed");
      if (isoDateOf(card!.effectiveFrom) > to) fail("INVALID_INPUT", "effectiveTo before effectiveFrom");
      await tx.rateCard.update({ where: { id }, data: { effectiveTo: dateColumn(to) } });
      await record(tx, { action: "rate_card.closed", targetType: "RateCard", targetId: id, metadata: { effectiveTo: to } });
    }),
  );
}

/** rate:view_bill — BILL cards with amounts (optionally filtered). */
export async function listBillRateCards(
  ctx: TimeCtx,
  filter?: { projectId?: string; memberId?: string; serviceId?: string; scope?: RateScope; openOnly?: boolean },
): Promise<RateCardView[]> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "rate:view_bill");
    if (filter?.projectId) await assertInScope(tx, ctx.actor, { projectId: filter.projectId });
    const rows = await tx.rateCard.findMany({
      where: {
        tenantId: ctx.tenantId,
        kind: "BILL",
        ...(filter?.scope ? { scope: filter.scope } : {}),
        ...(filter?.projectId ? { projectId: filter.projectId } : {}),
        ...(filter?.memberId ? { memberId: filter.memberId } : {}),
        ...(filter?.serviceId ? { serviceId: filter.serviceId } : {}),
        ...(filter?.openOnly ? { effectiveTo: null } : {}),
      },
      orderBy: [{ scope: "asc" }, { effectiveFrom: "desc" }],
      select: viewSelect,
    });
    return rows.map(toView);
  });
}

/** rate:view_cost (✦ enrolment) — COST cards WITHOUT amounts (metadata only). */
export async function listCostRateCards(ctx: TimeCtx): Promise<RateCardView[]> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "rate:view_cost");
    const rows = await tx.rateCard.findMany({
      where: { tenantId: ctx.tenantId, kind: "COST" },
      orderBy: [{ scope: "asc" }, { effectiveFrom: "desc" }],
      select: viewSelect,
    });
    return rows.map(toView);
  });
}

/**
 * rate:view_cost ✦ + fresh factor: decrypt a handful of COST cards
 * (a cost aggregation is SUM(seconds) GROUP BY cost_rate_card_id → this).
 * Audited once per call with the ids — never the amounts.
 */
export async function revealCostRates(
  ctx: TimeCtx,
  cardIds: readonly string[],
): Promise<Record<string, string>> {
  if (cardIds.length === 0) return {};
  if (cardIds.length > 50) fail("INVALID_INPUT", "too many cards in one reveal");
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "rate:view_cost");
    await requireRecentMfa(ctx.actor, COST_REVEAL_WINDOW_MINUTES);
    const rows = await tx.rateCard.findMany({
      where: { tenantId: ctx.tenantId, kind: "COST", id: { in: [...cardIds] } },
      omit: { amountCiphertext: false },
    });
    const out: Record<string, string> = {};
    for (const r of rows) {
      if (!r.amountCiphertext) continue;
      out[r.id] = await decryptFieldV2(
        tx,
        { tenantId: ctx.tenantId, model: "rate_card", rowId: r.id, field: "amount" },
        r.amountCiphertext,
      );
    }
    await record(tx, {
      action: "rate_card.cost_revealed",
      targetType: "RateCard",
      targetId: rows[0]?.id,
      metadata: { count: rows.length, ids: rows.map((r) => r.id) },
    });
    return out;
  });
}
