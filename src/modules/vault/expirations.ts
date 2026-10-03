import { resolveScope } from "@/authz/authorize";
import { AuthzError } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { accessibleCodes, requireAccess } from "@/entitlements/resolver";
import { fail } from "@/lib/domain-error";

import type { AssetType } from "./asset-fields";
import { principalOf, type VaultCtx } from "./ctx";
import { cutOf, mergeSources, type Source } from "./expirations-merge";
import { anchorScopeWhere } from "./scope";

/**
 * THE EXPIRATIONS FEED (Phase 3V slice 88; DATA_MODEL.md §6.17 "a computed
 * UNION — no table"): what renews or ends soon, across every client the
 * member reaches, for `/expirations` and the Home card.
 *
 *   - ASSETS in use with a renewal date (`asset:view` — the feed's own
 *     gate: without it there is no feed);
 *   - AGREEMENTS not ended (`service:view` — joined only when it is open,
 *     all four gates): a renewal date from TODAY on, and an end date,
 *     passed or coming (a running agreement past its renewal has renewed,
 *     and nothing moves `renewsAt` on — see `readFeed`);
 *   - LOGINS with an expiry date, as a COUNT per client and never by name
 *     (`credential:view`) — founder decision C54, 2026-10-03: which logins
 *     stays behind the vault's door (C52 (a)), so this read does NOT enter
 *     through it and returns nothing a door would guard. The agency's own
 *     logins (no client) are counted only for a member whose scope reaches
 *     them (C49), by the same filter as everything else.
 *
 * ONE SCOPE FILTER FOR ALL THREE (`anchorScopeWhere`): a project's row on
 * the project axis, a client-level row for DIRECT assignment only (AUTHZ
 * §4 and its slice-87 amendment). It is the services' own rule too —
 * `resolveScope`'s project list already holds a directly assigned
 * client's projects — so an agreement is listed here exactly when
 * `listServices` would list it.
 *
 * A LAPSED date stays in the feed for as long as the row says it is in
 * use — a domain whose date passed while it is still ACTIVE is the most
 * urgent line on the page, not a line to hide; an agreement's lapsed END
 * the same. An agreement's lapsed RENEWAL does not (above). Rows are read in SEQUENCE
 * on the one transaction (AGENTS.md's `Promise.all` trap), and each source
 * is capped, the cut said, never silent.
 */

export const EXPIRATIONS_DAYS = 90;
/** How far ahead the Home card looks — the Assets tab's "coming up" window. */
export const GLANCE_DAYS = 30;
/** Rows read per source at most; past it the feed says it was cut. */
export const EXPIRATIONS_LIMIT = 200;
/** Rows the Home card draws. */
export const GLANCE_ROWS = 5;

export type ExpirationKind = "asset" | "agreementRenews" | "agreementEnds";

export type ExpirationEntry = {
  readonly kind: ExpirationKind;
  /** The asset's or the agreement's id. */
  readonly id: string;
  readonly name: string;
  /** The day it renews, expires or ends, `YYYY-MM-DD` (the UTC day of the stored date). */
  readonly date: string;
  readonly client: { readonly id: string; readonly name: string };
  readonly project: { readonly key: string; readonly name: string } | null;
  /** An asset's type; null for an agreement. */
  readonly assetType: AssetType | null;
  /** An asset's "renews automatically"; null for an agreement or when not known. */
  readonly autoRenew: boolean | null;
  /**
   * Whether the member may open the client's own page for this row's tab.
   * An asset is always reachable there (the client's page opens on the
   * lifted scope); an agreement's tab wants DIRECT assignment, so a member
   * reached through one project gets the line without the link.
   */
  readonly linkable: boolean;
};

export type LoginExpirations = {
  /** null = the agency's own logins (C49). */
  readonly client: { readonly id: string; readonly name: string } | null;
  readonly count: number;
};

export type ExpirationsFeed = {
  /** The last day the feed covers, `YYYY-MM-DD` (inclusive). */
  readonly until: string;
  /** Soonest first; lapsed dates first of all. */
  readonly entries: readonly ExpirationEntry[];
  /**
   * A source had more rows than `EXPIRATIONS_LIMIT`: the entries are then
   * complete for every day BEFORE `cutAt`, partial on it, and there is more.
   */
  readonly truncated: boolean;
  /** The day the list was cut on when `truncated`; null otherwise. */
  readonly cutAt: string | null;
  /**
   * null without `credential:view` — and always under impersonation, which
   * never reaches into the vault (`door.ts`, AUTHZ §9) — otherwise per
   * client, by name, our own first.
   */
  readonly logins: readonly LoginExpirations[] | null;
};


const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayOf = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * `today` as midnight UTC, and the window it opens: the last day covered
 * (`until`, inclusive) and the exclusive bound after it (`before`). A day
 * that does not exist — `2031-02-30`, which `Date.parse` quietly rolls into
 * March — is refused by the round trip (both reviews).
 */
function span(today: string, days: number): { start: Date; until: string; before: Date } {
  const start = typeof today === "string" && DAY.test(today) ? Date.parse(`${today}T00:00:00Z`) : Number.NaN;
  if (Number.isNaN(start) || dayOf(new Date(start)) !== today) return fail("INVALID_INPUT", "today");
  if (!Number.isInteger(days) || days < 0 || days > 366) return fail("INVALID_INPUT", "days");
  return {
    start: new Date(start),
    until: dayOf(new Date(start + days * 86_400_000)),
    before: new Date(start + (days + 1) * 86_400_000),
  };
}


const clientAndProject = { client: { select: { id: true, name: true } }, project: { select: { key: true, name: true } } } as const;

async function readFeed(
  tx: TenantDb,
  ctx: VaultCtx,
  today: string,
  opts: { readonly days: number; readonly limit: number; readonly logins: boolean },
): Promise<ExpirationsFeed> {
  const { start, until, before } = span(today, opts.days);
  const { limit } = opts;
  // One read for the two optional sources' gates (all four gates each).
  const open = await accessibleCodes(tx, ctx.tenantId, ctx.actor, ["service:view", "credential:view"]);
  const scope = await resolveScope(tx, ctx.actor);
  const inScope = anchorScopeWhere(scope);
  const direct = (clientId: string) => scope.all || scope.directClientIds.includes(clientId);
  const sources: Source[] = [];
  const cutBy = <T>(rows: readonly T[], dateOf: (row: T) => Date) => cutOf(rows, limit, (r) => dayOf(dateOf(r)));

  // ASSETS in use, by their renewal date — a lapsed one included: a domain
  // whose date passed while it is still ACTIVE is the most urgent line.
  const assets = await tx.clientAsset.findMany({
    where: { AND: [{ tenantId: ctx.tenantId, status: "ACTIVE", expiresAt: { not: null, lt: before } }, inScope] },
    orderBy: [{ expiresAt: "asc" }, { name: "asc" }, { id: "asc" }],
    take: limit + 1,
    select: { id: true, name: true, type: true, expiresAt: true, autoRenew: true, ...clientAndProject },
  });
  sources.push({
    cut: cutBy(assets, (a) => a.expiresAt!),
    entries: assets.slice(0, limit).map((a) => ({
      kind: "asset",
      id: a.id,
      name: a.name,
      date: dayOf(a.expiresAt!),
      client: a.client,
      project: a.project,
      assetType: a.type,
      autoRenew: a.autoRenew,
      linkable: true,
    })),
  });

  if (open.has("service:view")) {
    const agreement = (s: { id: string; name: string; client: { id: string; name: string }; project: { key: string; name: string } | null }) => ({
      id: s.id,
      name: s.name,
      client: s.client,
      project: s.project,
      assetType: null,
      autoRenew: null,
      linkable: direct(s.client.id),
    });
    // RENEWALS FROM TODAY ON. A running agreement past its renewal date has,
    // in practice, renewed — and nothing in the product rolls `renewsAt`
    // forward or lets a member edit it, so a lapsed renewal would sit at
    // the top of the page and the Home card for ever with no verb that
    // clears it (the code review's medium; UI.md §5.8). Each date is its
    // own read, ordered by THAT date, so a cut drops the latest of each.
    const renewals = await tx.service.findMany({
      where: { AND: [{ tenantId: ctx.tenantId, status: { not: "ENDED" }, renewsAt: { gte: start, lt: before } }, inScope] },
      orderBy: [{ renewsAt: "asc" }, { name: "asc" }, { id: "asc" }],
      take: limit + 1,
      select: { id: true, name: true, renewsAt: true, ...clientAndProject },
    });
    sources.push({
      cut: cutBy(renewals, (s) => s.renewsAt!),
      entries: renewals.slice(0, limit).map((s) => ({ ...agreement(s), kind: "agreementRenews", date: dayOf(s.renewsAt!) })),
    });
    // ENDS, a passed one included: an agreement still running past its end
    // date is ended (or its date fixed) on the Agreements tab — "End" is the
    // verb that takes the line away.
    const ends = await tx.service.findMany({
      where: { AND: [{ tenantId: ctx.tenantId, status: { not: "ENDED" }, endsAt: { not: null, lt: before } }, inScope] },
      orderBy: [{ endsAt: "asc" }, { name: "asc" }, { id: "asc" }],
      take: limit + 1,
      select: { id: true, name: true, endsAt: true, ...clientAndProject },
    });
    sources.push({
      cut: cutBy(ends, (s) => s.endsAt!),
      entries: ends.slice(0, limit).map((s) => ({ ...agreement(s), kind: "agreementEnds", date: dayOf(s.endsAt!) })),
    });
  }

  // LOGINS, as a count per client (C54) — never under impersonation, which
  // the vault refuses before it reads anything (`door.ts`; the security
  // review), and the agency's own on TWO checks (C49: the scope filter, and
  // tenant-wide scope itself), as every other vault list does.
  let logins: LoginExpirations[] | null = null;
  if (opts.logins && open.has("credential:view") && !ctx.actor.impersonated) {
    const groups = await tx.credentialItem.groupBy({
      by: ["clientId"],
      where: { AND: [{ tenantId: ctx.tenantId, deletedAt: null, expiresAt: { not: null, lt: before } }, inScope] },
      _count: { _all: true },
    });
    const ids = groups.flatMap((g) => (g.clientId === null ? [] : [g.clientId]));
    // In sequence after the counts (AGENTS.md's `Promise.all` trap).
    const named =
      ids.length === 0
        ? []
        : await tx.client.findMany({
            where: { tenantId: ctx.tenantId, id: { in: ids } },
            orderBy: [{ name: "asc" }, { id: "asc" }],
            select: { id: true, name: true },
          });
    const count = new Map(groups.map((g) => [g.clientId, g._count._all]));
    const ours = scope.all ? (count.get(null) ?? 0) : 0;
    logins = [
      ...(ours > 0 ? [{ client: null, count: ours }] : []),
      ...named.map((c) => ({ client: c, count: count.get(c.id) ?? 0 })),
    ];
  }

  // ONE list, cut to the earliest day a source was cut on: past it,
  // another source's later rows would be drawn while the cut one's were
  // dropped — "soonest first" would be false (the code review). Complete
  // for every day BEFORE `cutAt` (`expirations-merge.ts`).
  const { entries, cutAt } = mergeSources(sources);
  return { until, entries, truncated: cutAt !== null, cutAt, logins };
}

/**
 * asset:view — the feed for `/expirations`: everything lapsed, and
 * everything due within `EXPIRATIONS_DAYS` of `today` (the member's own
 * day, `YYYY-MM-DD`, worked out by the caller in the member's zone).
 */
export async function expirationsFeed(ctx: VaultCtx, today: string): Promise<ExpirationsFeed> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "asset:view");
    return readFeed(tx, ctx, today, { days: EXPIRATIONS_DAYS, limit: EXPIRATIONS_LIMIT, logins: true });
  });
}

export type ExpirationsGlance = {
  /** The first `GLANCE_ROWS` entries lapsed or due within `GLANCE_DAYS`. */
  readonly entries: readonly ExpirationEntry[];
  /** How many more there are past those. */
  readonly more: number;
  /** The read was cut: there are at LEAST `more` more. */
  readonly moreAtLeast: boolean;
};

/**
 * The Home card: `null` without `asset:view` on all four gates — the
 * other Home cards' rule, so a member or tenant without the registry
 * meets no card and no refusal — otherwise what is lapsed or due within
 * `GLANCE_DAYS`, soonest first. Logins are not read at all: the card is a
 * list of things to renew, and C54 keeps logins to a count on the page.
 */
export async function expirationsGlance(ctx: VaultCtx, today: string): Promise<ExpirationsGlance | null> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    try {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "asset:view");
    } catch (e) {
      if (e instanceof AuthzError) return null;
      throw e;
    }
    const feed = await readFeed(tx, ctx, today, { days: GLANCE_DAYS, limit: EXPIRATIONS_LIMIT, logins: false });
    return {
      entries: feed.entries.slice(0, GLANCE_ROWS),
      more: Math.max(0, feed.entries.length - GLANCE_ROWS),
      moreAtLeast: feed.truncated,
    };
  });
}
