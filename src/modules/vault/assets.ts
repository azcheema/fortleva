import { record } from "@/audit/record";
import { resolveScope } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { dbErrorMapper } from "@/lib/db-error-map";
import { fail } from "@/lib/domain-error";
import { readPreferences } from "@/preferences/service";

import {
  applyAssetFieldsPatch,
  isAssetStatus,
  isAssetType,
  normalizeAssetFields,
  normalizeAssetFieldsPatch,
  normalizeAutoRenew,
  normalizeCurrency,
  normalizeExpiryDay,
  normalizeIdentifier,
  normalizeProvider,
  normalizeRenewalCost,
  readAssetFields,
  type AssetFieldValue,
  type AssetFieldValues,
  type AssetStatus,
  type AssetType,
} from "./asset-fields";
import { idOf, principalOf, type VaultCtx } from "./ctx";
import { normalizeName, normalizeNotes, normalizeTags, normalizeUrl } from "./fields";
import { anchorScopeWhere, assertAnchorInScope, type VaultAnchor } from "./scope";

/**
 * THE ASSET REGISTRY (Phase 3V slice 87; DATA_MODEL.md §6.17 `ClientAsset`;
 * AUTHZ.md §3.2's `asset:*` rows). What the agency looks after for a client
 * — domains, hosting, certificates, licences — with renewal dates and
 * costs. Every verb is the house recipe: `requireAccess` (all four gates;
 * the module is `vault`, so switching the vault off closes the registry
 * too) → scope → mutate → `record()` in the same transaction.
 *
 * NOT BEHIND THE VAULT'S DOOR. The door (`door.ts`, C52 (a)) guards logins;
 * an asset is a non-secret record — a domain name and its registrar are
 * public — so no step-up is asked, and none of the codes is ✦. What keeps
 * a secret out of here is the shape: no field is a place for one, and the
 * Assets tab says a login belongs in the Vault.
 *
 * SCOPE is the vault's anchor rule (`scope.ts`): a project's asset on the
 * project axis, a client-level one for DIRECT client assignment only — so
 * a member reached through one project sees that project's assets, never
 * the client's whole registry. An asset always has a client (there is no
 * "agency's own" asset), and out of scope is NOT_FOUND, never FORBIDDEN.
 *
 * Delete is a HARD delete (retention R2: an asset is a live record of the
 * tenancy, with no secret to purge); "no longer in use" is `RETIRED`,
 * which keeps the record and takes it off the expirations feed.
 */

/** Database-raised invariants → DomainError (migration 20261003120000). */
const { guarded } = dbErrorMapper([["ASSET_CLIENT_MISMATCH", "CLIENT_MISMATCH"]]);

export type AssetView = {
  readonly id: string;
  readonly clientId: string;
  readonly projectId: string | null;
  readonly type: AssetType;
  readonly name: string;
  readonly provider: string | null;
  readonly url: string | null;
  readonly identifier: string | null;
  readonly status: AssetStatus;
  /** A renewal DATE, stored as UTC midnight (`normalizeExpiryDay`; the tab's actions parse it with `dayOf`). */
  readonly expiresAt: Date | null;
  /** Renews by itself: yes, no, or not known. */
  readonly autoRenew: boolean | null;
  /** Decimal(12,2) as a string — never a float. Set together with `currency`. */
  readonly renewalCost: string | null;
  readonly currency: string | null;
  readonly fields: AssetFieldValues;
  readonly notes: string | null;
  readonly tags: readonly string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** The project it hangs on, by name — or null for a client-level asset. */
  readonly project: { readonly id: string; readonly key: string; readonly name: string } | null;
};

const viewSelect = {
  id: true,
  clientId: true,
  projectId: true,
  type: true,
  name: true,
  provider: true,
  url: true,
  identifier: true,
  status: true,
  expiresAt: true,
  autoRenew: true,
  renewalCost: true,
  currency: true,
  fields: true,
  notes: true,
  tags: true,
  createdAt: true,
  updatedAt: true,
  project: { select: { id: true, key: true, name: true } },
} as const;

type AssetRow = {
  id: string;
  clientId: string;
  projectId: string | null;
  type: AssetType;
  name: string;
  provider: string | null;
  url: string | null;
  identifier: string | null;
  status: AssetStatus;
  expiresAt: Date | null;
  autoRenew: boolean | null;
  renewalCost: { toFixed(dp: number): string } | null;
  currency: string | null;
  fields: unknown;
  notes: string | null;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
  project: { id: string; key: string; name: string } | null;
};

const toView = (r: AssetRow): AssetView => ({
  ...r,
  // Two decimals always, so the edit box shows "1200.50" — and a cost
  // compares equal to the same cost posted back.
  renewalCost: r.renewalCost === null ? null : r.renewalCost.toFixed(2),
  fields: readAssetFields(r.type, r.fields),
});

/** An asset's anchor (and type, for the trail), or NOT_FOUND. */
async function anchorOf(tx: TenantDb, tenantId: string, id: string) {
  const row = await tx.clientAsset.findFirst({
    where: { tenantId, id },
    select: { id: true, clientId: true, projectId: true, type: true },
  });
  if (!row) return deny("NOT_FOUND");
  return row;
}

/**
 * Where a NEW asset hangs: a project (which must be one of the named
 * client's) or the client as a whole. Archived clients and projects take
 * none. SCOPE IS ASKED BEFORE ANYTHING ELSE IS ANSWERED — a mismatch or an
 * archived status is a fact about the anchor, and telling it to a member
 * who cannot reach the anchor would be the oracle NOT_FOUND prevents.
 */
async function resolveNewAnchor(
  tx: TenantDb,
  ctx: VaultCtx,
  clientId: string,
  projectId: string | null,
): Promise<VaultAnchor & { clientId: string }> {
  const tenantId = ctx.tenantId;
  if (projectId !== null) {
    const project = await tx.project.findFirst({
      where: { tenantId, id: projectId },
      select: { clientId: true, status: true },
    });
    if (!project) return deny("NOT_FOUND");
    await assertAnchorInScope(tx, ctx.actor, { clientId: project.clientId, projectId });
    if (project.clientId !== clientId) return fail("CLIENT_MISMATCH");
    if (project.status === "ARCHIVED") return fail("ARCHIVED");
    return { clientId, projectId };
  }
  const client = await tx.client.findFirst({ where: { tenantId, id: clientId }, select: { status: true } });
  if (!client) return deny("NOT_FOUND");
  await assertAnchorInScope(tx, ctx.actor, { clientId, projectId: null });
  if (client.status === "ARCHIVED") return fail("ARCHIVED");
  return { clientId, projectId: null };
}

/**
 * A cost and its currency travel together (`client_asset_cost_currency`):
 * no cost, no currency; a cost without one takes the tenant's default.
 */
async function pairCost(
  tx: TenantDb,
  tenantId: string,
  cost: string | null,
  currency: string | null,
): Promise<{ renewalCost: string | null; currency: string | null }> {
  if (cost === null) return { renewalCost: null, currency: null };
  if (currency !== null) return { renewalCost: cost, currency };
  const prefs = await readPreferences(tx, tenantId);
  return { renewalCost: cost, currency: prefs.currencyDefault };
}

export type CreateAssetInput = {
  readonly clientId: string;
  /** A project of that client; absent or null = the client as a whole. */
  readonly projectId?: string | null;
  readonly type: AssetType;
  readonly name: string;
  readonly provider?: string | null;
  readonly url?: string | null;
  readonly identifier?: string | null;
  readonly expiresAt?: Date | null;
  readonly autoRenew?: boolean | null;
  readonly renewalCost?: string | number | null;
  readonly currency?: string | null;
  /** The type's extra facts (`ASSET_FIELDS`); blanks are left out. */
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly notes?: string | null;
  readonly tags?: readonly string[];
};

/** asset:manage — a new asset and `asset.created`. */
export async function createAsset(ctx: VaultCtx, input: CreateAssetInput): Promise<AssetView> {
  if (!isAssetType(input.type)) return fail("INVALID_INPUT", "type");
  const type = input.type;
  const clientId = idOf(input.clientId, "clientId");
  const projectId = input.projectId === undefined || input.projectId === null ? null : idOf(input.projectId, "projectId");
  const name = normalizeName(input.name);
  const provider = normalizeProvider(input.provider);
  const url = normalizeUrl(input.url);
  const identifier = normalizeIdentifier(input.identifier);
  const expiresAt = normalizeExpiryDay(input.expiresAt);
  const autoRenew = normalizeAutoRenew(input.autoRenew);
  const cost = normalizeRenewalCost(input.renewalCost);
  const currency = normalizeCurrency(input.currency);
  const fields = normalizeAssetFields(type, input.fields);
  const notes = normalizeNotes(input.notes);
  const tags = normalizeTags(input.tags);

  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "asset:manage");
      const anchor = await resolveNewAnchor(tx, ctx, clientId, projectId);
      const money = await pairCost(tx, ctx.tenantId, cost, currency);
      const row = await tx.clientAsset.create({
        data: {
          tenantId: ctx.tenantId,
          clientId: anchor.clientId,
          projectId: anchor.projectId,
          type,
          name,
          provider,
          url,
          identifier,
          expiresAt,
          autoRenew,
          ...money,
          fields,
          notes,
          tags,
          createdByMemberId: ctx.actor.memberId,
          updatedByMemberId: ctx.actor.memberId,
        },
        select: viewSelect,
      });
      await record(tx, {
        action: "asset.created",
        targetType: "ClientAsset",
        targetId: row.id,
        metadata: { clientId: anchor.clientId, projectId: anchor.projectId, type },
      });
      return toView(row);
    }),
  );
}

/**
 * asset:view — one client's assets as far as the member's scope reaches:
 * its client-level ones for a member assigned to it directly, and each
 * reachable project's. In use first, then by type, then by name.
 */
export async function listAssets(ctx: VaultCtx, filter: { readonly clientId: string }): Promise<AssetView[]> {
  const clientId = idOf(filter.clientId, "clientId");
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "asset:view");
    const scope = await resolveScope(tx, ctx.actor);
    const rows = await tx.clientAsset.findMany({
      where: { AND: [{ tenantId: ctx.tenantId, clientId }, anchorScopeWhere(scope)] },
      orderBy: [{ status: "asc" }, { type: "asc" }, { name: "asc" }, { id: "asc" }],
      select: viewSelect,
    });
    return rows.map(toView);
  });
}

/** The columns an edit may write, as the service hands them to Prisma. */
type Writable = {
  name?: string;
  provider?: string | null;
  url?: string | null;
  identifier?: string | null;
  status?: AssetStatus;
  expiresAt?: Date | null;
  autoRenew?: boolean | null;
  notes?: string | null;
  tags?: string[];
  type: AssetType;
  fields: Record<string, AssetFieldValue>;
  renewalCost: string | null;
  currency: string | null;
};

export type AssetPatch = {
  readonly type?: AssetType;
  readonly name?: string;
  readonly provider?: string | null;
  readonly url?: string | null;
  readonly identifier?: string | null;
  readonly status?: AssetStatus;
  readonly expiresAt?: Date | null;
  readonly autoRenew?: boolean | null;
  readonly renewalCost?: string | number | null;
  readonly currency?: string | null;
  /** Per key: a value sets it, a blank or `null` removes it, an absent key leaves it. */
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly notes?: string | null;
  readonly tags?: readonly string[];
};

/**
 * asset:manage — edit an asset, retire it, or bring it back. A field absent
 * from the patch is left alone; `null` clears it. Audited with the NAMES of
 * the fields whose value actually changed; a patch that changes nothing
 * writes nothing. A TYPE change keeps only the fields the new type has.
 * Moving an asset to another client or project is not an edit and is not
 * offered.
 */
export async function updateAsset(ctx: VaultCtx, assetId: string, patch: AssetPatch): Promise<AssetView> {
  const id = idOf(assetId, "assetId");
  if (patch.type !== undefined && !isAssetType(patch.type)) return fail("INVALID_INPUT", "type");
  if (patch.status !== undefined && !isAssetStatus(patch.status)) return fail("INVALID_INPUT", "status");
  const scalar: Omit<Writable, "type" | "fields" | "renewalCost" | "currency"> = {};
  if (patch.name !== undefined) scalar.name = normalizeName(patch.name);
  if (patch.provider !== undefined) scalar.provider = normalizeProvider(patch.provider);
  if (patch.url !== undefined) scalar.url = normalizeUrl(patch.url);
  if (patch.identifier !== undefined) scalar.identifier = normalizeIdentifier(patch.identifier);
  if (patch.status !== undefined) scalar.status = patch.status;
  if (patch.expiresAt !== undefined) scalar.expiresAt = normalizeExpiryDay(patch.expiresAt);
  if (patch.autoRenew !== undefined) scalar.autoRenew = normalizeAutoRenew(patch.autoRenew);
  if (patch.notes !== undefined) scalar.notes = normalizeNotes(patch.notes);
  if (patch.tags !== undefined) scalar.tags = normalizeTags(patch.tags);
  const cost = patch.renewalCost === undefined ? undefined : normalizeRenewalCost(patch.renewalCost);
  const currency = patch.currency === undefined ? undefined : normalizeCurrency(patch.currency);

  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "asset:manage");
      // ONE read for the anchor and the values: two would let a delete
      // commit between them and throw an unmapped P2025 out of the second
      // (the code review) — a missing row is NOT_FOUND, here as everywhere.
      const row = await tx.clientAsset.findFirst({ where: { tenantId: ctx.tenantId, id }, select: viewSelect });
      if (!row) return deny("NOT_FOUND");
      const anchor = { clientId: row.clientId, projectId: row.projectId };
      await assertAnchorInScope(tx, ctx.actor, anchor);
      const current = toView(row);

      const type = patch.type ?? current.type;
      // The fields patch is held to the type the asset will HAVE.
      const fieldsPatch = normalizeAssetFieldsPatch(type, patch.fields);
      const fields = applyAssetFieldsPatch(type, current.fields, fieldsPatch);
      const money = await pairCost(
        tx,
        ctx.tenantId,
        cost === undefined ? current.renewalCost : cost,
        currency === undefined ? current.currency : currency,
      );
      const wanted: Writable = { ...scalar, type, fields, ...money };
      const same = (a: unknown, b: unknown) =>
        a instanceof Date || b instanceof Date
          ? (a as Date | null)?.getTime() === (b as Date | null)?.getTime()
          : JSON.stringify(a) === JSON.stringify(b);
      const changed = (Object.keys(wanted) as (keyof Writable)[]).filter((k) => !same(wanted[k], current[k]));
      if (changed.length === 0) return current;
      const data = Object.fromEntries(changed.map((k) => [k, wanted[k]])) as Partial<Writable>;
      const written = await tx.clientAsset.updateMany({
        where: { id, tenantId: ctx.tenantId },
        data: { ...data, updatedByMemberId: ctx.actor.memberId },
      });
      // A delete that committed in between: nothing is edited, nothing recorded.
      if (written.count !== 1) return deny("NOT_FOUND");
      await record(tx, {
        action: "asset.updated",
        targetType: "ClientAsset",
        targetId: id,
        metadata: { clientId: anchor.clientId, projectId: anchor.projectId, type, changed },
      });
      return toView(await tx.clientAsset.findFirstOrThrow({ where: { tenantId: ctx.tenantId, id }, select: viewSelect }));
    }),
  );
}

/**
 * asset:delete — a HARD delete (an asset has no secret to purge and no
 * window to wait out). Two concurrent deletes record ONE `asset.deleted`:
 * the second finds nothing to delete and is NOT_FOUND.
 */
export async function deleteAsset(ctx: VaultCtx, assetId: string): Promise<void> {
  const id = idOf(assetId, "assetId");
  await withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "asset:delete");
    const anchor = await anchorOf(tx, ctx.tenantId, id);
    await assertAnchorInScope(tx, ctx.actor, anchor);
    const gone = await tx.clientAsset.deleteMany({ where: { id, tenantId: ctx.tenantId } });
    if (gone.count !== 1) deny("NOT_FOUND");
    await record(tx, {
      action: "asset.deleted",
      targetType: "ClientAsset",
      targetId: id,
      metadata: { clientId: anchor.clientId, projectId: anchor.projectId, type: anchor.type },
    });
  });
}

export type { AssetFieldValue, AssetFieldValues };
