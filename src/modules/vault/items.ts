import { randomUUID } from "node:crypto";

import { record } from "@/audit/record";
import { resolveScope } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { fail } from "@/lib/domain-error";

import { lockSecretWrite } from "./budget";
import { boundedVaultWrite, guarded, idOf, principalOf, type VaultCtx } from "./ctx";
import { enterVault } from "./door";
import {
  isCredentialType,
  normalizeExpiresAt,
  normalizeName,
  normalizeNotes,
  normalizeRotateEveryDays,
  normalizeSecretFields,
  normalizeSecretPatch,
  normalizeTags,
  normalizeUrl,
  normalizeUsername,
  SECRET_FIELDS,
  type CredentialType,
} from "./fields";
import { assertAnchorInScope, anchorScopeWhere, type VaultAnchor } from "./scope";
import { fieldsClearedSinceMarked, seedTakenByLeaver } from "./offboarding";
import { lockedState } from "./seal";
import { insertSecretRow, keepPreviousVersion, readSecret, readTotp, updateSecretRow } from "./secret-store";
import { parseTotpInput } from "./totp";

/**
 * Credential METADATA and the secret's lifecycle (DATA_MODEL.md §6.17;
 * AUTHZ.md §3.2's `credential:*` rows). Every verb is the house recipe:
 * `requireAccess` → scope → mutate → `record()` in the same transaction —
 * the access check through `enterVault` (`door.ts`), which also wants a
 * factor no older than `vault.stepUpMinutes` (C52: the whole vault is
 * locked, the list included).
 *
 * Nothing here ever RETURNS a secret. Creating and replacing one take a
 * value in and encrypt it; reading one is `reveal.ts`'s, behind
 * `credential:reveal` ✦, a fresh factor and the reveal budget. The view
 * a caller gets back carries the secret's field NAMES (`secretFieldKeys`)
 * and whether a TOTP seed exists — enough to draw a masked row — and the
 * audit metadata carries the same, never a value.
 */

export type CredentialView = {
  readonly id: string;
  readonly clientId: string | null;
  readonly projectId: string | null;
  readonly type: CredentialType;
  readonly name: string;
  readonly username: string | null;
  readonly url: string | null;
  readonly tags: readonly string[];
  readonly notes: string | null;
  readonly secretFieldKeys: readonly string[];
  readonly hasTotp: boolean;
  readonly expiresAt: Date | null;
  readonly rotateEveryDays: number | null;
  readonly lastRotatedAt: Date | null;
  readonly needsRotation: boolean;
  /** CLIENT_VISIBLE = shown to the client's main contacts (slice 91, C52 (d)). */
  readonly visibility: "INTERNAL" | "CLIENT_VISIBLE";
  /** When it was sealed for its client, or null (slice 92, C52 (e) — `seal.ts`). */
  readonly sealedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

const viewSelect = {
  id: true,
  clientId: true,
  projectId: true,
  type: true,
  name: true,
  username: true,
  url: true,
  tags: true,
  notes: true,
  secretFieldKeys: true,
  hasTotp: true,
  expiresAt: true,
  rotateEveryDays: true,
  lastRotatedAt: true,
  needsRotation: true,
  visibility: true,
  sealedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * A credential as a LIST draws it: the view, plus the client and project it
 * hangs on BY NAME — a row on the tenant's `/vault` says whose login it is,
 * and a row on a client's tab which project. Both names are the member's
 * to read: a credential in scope hangs on a project or client in scope
 * (`scope.ts`), whose name every page of that project or client shows.
 */
export type CredentialListing = CredentialView & {
  readonly client: { readonly id: string; readonly name: string } | null;
  readonly project: { readonly id: string; readonly key: string; readonly name: string } | null;
};

const listingSelect = {
  ...viewSelect,
  client: { select: { id: true, name: true } },
  project: { select: { id: true, key: true, name: true } },
} as const;

/**
 * How many rows the tenant-wide list (`listAllCredentials`) draws at most.
 * Every row is a set of live controls, so a workspace with more is told so
 * and narrows by client (`vaultIndex` has the true counts); a list under
 * ONE anchor is not capped.
 */
export const VAULT_LIST_LIMIT = 200;

/** A live (not deleted) credential's anchor, or NOT_FOUND. */
async function liveAnchor(tx: TenantDb, tenantId: string, id: string) {
  const row = await tx.credentialItem.findFirst({
    where: { tenantId, id, deletedAt: null },
    select: { id: true, type: true, clientId: true, projectId: true },
  });
  if (!row) return deny("NOT_FOUND");
  return row;
}

/**
 * Where a NEW credential hangs. A project wins and brings its own client
 * (a caller that also names a client must name the same one); a client
 * alone is a client-level login; neither is the agency's own (C49).
 * Archived clients and projects take no new credentials.
 *
 * SCOPE IS ASKED BEFORE ANYTHING ELSE IS ANSWERED: a client mismatch or
 * an archived status is a fact about the anchor, and telling it to a
 * member who cannot reach the anchor would be the existence oracle
 * NOT_FOUND exists to prevent.
 */
async function resolveNewAnchor(
  tx: TenantDb,
  ctx: VaultCtx,
  input: { clientId?: unknown; projectId?: unknown },
): Promise<VaultAnchor> {
  const tenantId = ctx.tenantId;
  const projectId = input.projectId === undefined || input.projectId === null ? null : idOf(input.projectId, "projectId");
  const clientId = input.clientId === undefined || input.clientId === null ? null : idOf(input.clientId, "clientId");
  if (projectId !== null) {
    const project = await tx.project.findFirst({
      where: { tenantId, id: projectId },
      select: { clientId: true, status: true },
    });
    if (!project) return deny("NOT_FOUND");
    const anchor = { clientId: project.clientId, projectId };
    await assertAnchorInScope(tx, ctx.actor, anchor);
    if (clientId !== null && clientId !== project.clientId) fail("CLIENT_MISMATCH");
    if (project.status === "ARCHIVED") fail("ARCHIVED");
    return anchor;
  }
  if (clientId !== null) {
    const client = await tx.client.findFirst({ where: { tenantId, id: clientId }, select: { status: true } });
    if (!client) return deny("NOT_FOUND");
    const anchor = { clientId, projectId: null };
    await assertAnchorInScope(tx, ctx.actor, anchor);
    if (client.status === "ARCHIVED") fail("ARCHIVED");
    return anchor;
  }
  const anchor = { clientId: null, projectId: null };
  await assertAnchorInScope(tx, ctx.actor, anchor);
  return anchor;
}

export type CreateCredentialInput = {
  readonly clientId?: string | null;
  readonly projectId?: string | null;
  readonly type: CredentialType;
  readonly name: string;
  readonly username?: string | null;
  readonly url?: string | null;
  readonly tags?: readonly string[];
  readonly notes?: string | null;
  /** The type's secret fields (`SECRET_FIELDS`); empty values are dropped. */
  readonly secret?: Readonly<Record<string, string>>;
  /** A base32 seed or an `otpauth://totp/…` URI. */
  readonly totp?: string | null;
  readonly expiresAt?: Date | null;
  readonly rotateEveryDays?: number | null;
};

/** credential:create — the metadata row, its encrypted secret, and `credential.created`. */
export async function createCredential(ctx: VaultCtx, input: CreateCredentialInput): Promise<CredentialView> {
  if (!isCredentialType(input.type)) fail("INVALID_INPUT", "type");
  const type = input.type;
  const name = normalizeName(input.name);
  const username = normalizeUsername(input.username);
  const url = normalizeUrl(input.url);
  const tags = normalizeTags(input.tags);
  const notes = normalizeNotes(input.notes);
  const fields = normalizeSecretFields(type, input.secret);
  const totp =
    input.totp === undefined || input.totp === null || (typeof input.totp === "string" && input.totp.trim() === "")
      ? null
      : parseTotpInput(input.totp);
  const expiresAt = normalizeExpiresAt(input.expiresAt);
  const rotateEveryDays = normalizeRotateEveryDays(input.rotateEveryDays);
  if (Object.keys(fields).length === 0 && totp === null) fail("INVALID_INPUT", "a credential needs a secret or a TOTP seed");

  return boundedVaultWrite((opts) => withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await enterVault(tx, ctx, "credential:create");
      const anchor = await resolveNewAnchor(tx, ctx, input);
      // The member types the secret: a removal racing this must see it or
      // refuse it (`lockSecretWrite`, slice 94's security review).
      await lockSecretWrite(tx, ctx.tenantId, ctx.actor.memberId);

      // The id is minted here because the AAD binds the ciphertext to it.
      const id = randomUUID();
      const secretFieldKeys = Object.keys(fields);
      const row = await tx.credentialItem.create({
        data: {
          id,
          tenantId: ctx.tenantId,
          clientId: anchor.clientId,
          projectId: anchor.projectId,
          type,
          name,
          username,
          url,
          tags,
          notes,
          secretFieldKeys,
          hasTotp: totp !== null,
          expiresAt,
          rotateEveryDays,
          lastRotatedAt: new Date(),
          createdByMemberId: ctx.actor.memberId,
          updatedByMemberId: ctx.actor.memberId,
        },
        select: viewSelect,
      });
      await insertSecretRow(tx, { tenantId: ctx.tenantId, credentialId: id, fields, totp, memberId: ctx.actor.memberId });
      await record(tx, {
        action: "credential.created",
        targetType: "CredentialItem",
        targetId: id,
        metadata: {
          clientId: anchor.clientId,
          projectId: anchor.projectId,
          type,
          fields: secretFieldKeys,
          hasTotp: totp !== null,
        },
      });
      return row;
    }),
  opts));
}

export type CredentialFilter =
  /** One client's credentials — client-level and on its projects, as far as scope reaches. */
  | { readonly clientId: string }
  /** One project's credentials. */
  | { readonly projectId: string }
  /** The agency's own (C49): tenant-wide scope only; anyone else gets an empty list. */
  | { readonly agencyOwn: true };

/** credential:view — live credentials under one anchor, metadata only, by name. */
export async function listCredentials(ctx: VaultCtx, filter: CredentialFilter): Promise<CredentialListing[]> {
  const anchorWhere =
    "agencyOwn" in filter
      ? { clientId: null }
      : "projectId" in filter
        ? { projectId: idOf(filter.projectId, "projectId") }
        : { clientId: idOf(filter.clientId, "clientId") };
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await enterVault(tx, ctx, "credential:view");
    const scope = await resolveScope(tx, ctx.actor);
    return tx.credentialItem.findMany({
      where: { AND: [{ tenantId: ctx.tenantId, deletedAt: null, ...anchorWhere }, anchorScopeWhere(scope)] },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: listingSelect,
    });
  });
}

/**
 * credential:view — EVERY live credential the member reaches, for the
 * tenant's `/vault`: the agency's own first (tenant-wide scope only, C49),
 * then client by client, by name. At most `VAULT_LIST_LIMIT` rows.
 *
 * `cut` says whether there were more, and WHERE the list was cut: the
 * anchor of the first row past the cap (`clientId`, null for our own). Rows
 * arrive contiguous per anchor, so the only card that can be short is the
 * one whose anchor that is — and only when it is also the last one drawn.
 * Answered by THIS read — one row past the cap is read and dropped — never
 * by a count taken in another transaction, which a concurrent add or delete
 * would put out of step (slice 86's reviews, twice).
 */
export async function listAllCredentials(
  ctx: VaultCtx,
  only: { readonly changeSoon?: boolean } = {},
): Promise<{
  readonly rows: CredentialListing[];
  readonly cut: { readonly clientId: string | null } | null;
}> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await enterVault(tx, ctx, "credential:view");
    const scope = await resolveScope(tx, ctx.actor);
    // `changeSoon` narrows to the logins marked for a change (slice 94's
    // offboarding flags) — the same order, cap and cut.
    const live = { tenantId: ctx.tenantId, deletedAt: null, ...(only.changeSoon ? { needsRotation: true } : {}) };
    const over = VAULT_LIST_LIMIT + 1;
    // TWO reads, in sequence, because the order wants the client-less rows
    // FIRST and Postgres sorts a missing client's NULL name last. The
    // agency's own are read only for a member whose scope reaches them,
    // and through the scope filter as well — C49 on two checks, as in
    // every other list (slice 86's security review).
    const own = scope.all
      ? await tx.credentialItem.findMany({
          where: { AND: [{ ...live, clientId: null }, anchorScopeWhere(scope)] },
          orderBy: [{ name: "asc" }, { id: "asc" }],
          take: over,
          select: listingSelect,
        })
      : [];
    const clients =
      own.length >= over
        ? []
        : await tx.credentialItem.findMany({
            where: { AND: [{ ...live, clientId: { not: null } }, anchorScopeWhere(scope)] },
            orderBy: [{ client: { name: "asc" } }, { clientId: "asc" }, { name: "asc" }, { id: "asc" }],
            take: over - own.length,
            select: listingSelect,
          });
    const rows = [...own, ...clients];
    const past = rows[VAULT_LIST_LIMIT];
    return {
      rows: rows.slice(0, VAULT_LIST_LIMIT),
      cut: past === undefined ? null : { clientId: past.clientId },
    };
  });
}

/** What the tenant's `/vault` filters by: whose logins the member can reach, and how many. */
export type VaultIndex = {
  /** The agency's own logins (C49) — `null` when the member's scope does not reach them. */
  readonly agency: number | null;
  /** Every client with at least one login the member can reach, by name. */
  readonly clients: readonly { readonly id: string; readonly name: string; readonly count: number }[];
  /** How many of those logins are marked for a change ("Change soon" — slice 94). */
  readonly changeSoon: number;
};

/**
 * credential:view — the vault's index: per client, how many live logins the
 * member can reach, and the agency's own count for a member whose scope is
 * the whole tenant. Behind the door like every other vault read: which
 * clients have logins, and how many, is part of the map.
 */
export async function vaultIndex(ctx: VaultCtx): Promise<VaultIndex> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await enterVault(tx, ctx, "credential:view");
    const scope = await resolveScope(tx, ctx.actor);
    const groups = await tx.credentialItem.groupBy({
      by: ["clientId"],
      where: { AND: [{ tenantId: ctx.tenantId, deletedAt: null }, anchorScopeWhere(scope)] },
      _count: { _all: true },
    });
    const count = new Map(groups.map((g) => [g.clientId, g._count._all]));
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
    const changeSoon = await tx.credentialItem.count({
      where: { AND: [{ tenantId: ctx.tenantId, deletedAt: null, needsRotation: true }, anchorScopeWhere(scope)] },
    });
    return {
      agency: scope.all ? (count.get(null) ?? 0) : null,
      clients: named.map((c) => ({ id: c.id, name: c.name, count: count.get(c.id) ?? 0 })),
      changeSoon,
    };
  });
}

/** credential:view — one live credential's metadata; out of scope is NOT_FOUND. */
export async function getCredential(ctx: VaultCtx, credentialId: string): Promise<CredentialView> {
  const id = idOf(credentialId, "credentialId");
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await enterVault(tx, ctx, "credential:view");
    const anchor = await liveAnchor(tx, ctx.tenantId, id);
    await assertAnchorInScope(tx, ctx.actor, anchor);
    return tx.credentialItem.findFirstOrThrow({ where: { tenantId: ctx.tenantId, id }, select: viewSelect });
  });
}

export type CredentialPatch = {
  readonly name?: string;
  readonly username?: string | null;
  readonly url?: string | null;
  readonly tags?: readonly string[];
  readonly notes?: string | null;
  readonly expiresAt?: Date | null;
  readonly rotateEveryDays?: number | null;
};

/**
 * credential:edit — the metadata only. A field absent from the patch is
 * left alone; `null` clears it. Audited with the NAMES of the fields whose
 * value actually changed; a patch that changes nothing writes nothing.
 * Moving a credential to another client or project is not a metadata
 * edit and is not offered.
 */
export async function updateCredential(
  ctx: VaultCtx,
  credentialId: string,
  patch: CredentialPatch,
): Promise<CredentialView> {
  const id = idOf(credentialId, "credentialId");
  const wanted: {
    name?: string;
    username?: string | null;
    url?: string | null;
    tags?: string[];
    notes?: string | null;
    expiresAt?: Date | null;
    rotateEveryDays?: number | null;
  } = {};
  if (patch.name !== undefined) wanted.name = normalizeName(patch.name);
  if (patch.username !== undefined) wanted.username = normalizeUsername(patch.username);
  if (patch.url !== undefined) wanted.url = normalizeUrl(patch.url);
  if (patch.tags !== undefined) wanted.tags = normalizeTags(patch.tags);
  if (patch.notes !== undefined) wanted.notes = normalizeNotes(patch.notes);
  if (patch.expiresAt !== undefined) wanted.expiresAt = normalizeExpiresAt(patch.expiresAt);
  if (patch.rotateEveryDays !== undefined) wanted.rotateEveryDays = normalizeRotateEveryDays(patch.rotateEveryDays);

  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await enterVault(tx, ctx, "credential:edit");
      const anchor = await liveAnchor(tx, ctx.tenantId, id);
      await assertAnchorInScope(tx, ctx.actor, anchor);
      const current = await tx.credentialItem.findFirstOrThrow({
        where: { tenantId: ctx.tenantId, id },
        select: viewSelect,
      });
      const same = (a: unknown, b: unknown) =>
        a instanceof Date || b instanceof Date
          ? (a as Date | null)?.getTime() === (b as Date | null)?.getTime()
          : JSON.stringify(a) === JSON.stringify(b);
      const changed = (Object.keys(wanted) as (keyof typeof wanted)[]).filter((k) => !same(wanted[k], current[k]));
      if (changed.length === 0) return current;
      const data = Object.fromEntries(changed.map((k) => [k, wanted[k]])) as typeof wanted;
      // `deletedAt: null` in the WRITE, not only in the read above: a delete
      // that committed in between must not be edited (and audited) after it.
      const written = await tx.credentialItem.updateMany({
        where: { id, tenantId: ctx.tenantId, deletedAt: null },
        data: { ...data, updatedByMemberId: ctx.actor.memberId },
      });
      if (written.count !== 1) return deny("NOT_FOUND");
      await record(tx, {
        action: "credential.updated",
        targetType: "CredentialItem",
        targetId: id,
        metadata: { changed },
      });
      return tx.credentialItem.findFirstOrThrow({ where: { tenantId: ctx.tenantId, id }, select: viewSelect });
    }),
  );
}

/**
 * credential:edit — change the secret (the rotate gesture), as a PATCH:
 * in `secret`, a value sets that field, `null` removes it, an empty string
 * or an absent key leaves it as it is — so rotating one field of an API
 * key keeps the other, and a form that posts its blank inputs wipes
 * nothing. `totp` replaces the seed when a non-empty string, removes it
 * when `null`, and leaves it alone when absent or empty. The secret being
 * changed is kept as a version, re-encrypted under the version row's own
 * AAD, and the newest ten are kept. Changing a secret is not revealing
 * one: nothing is returned, and the editor never sees the old value.
 * Only a REPLACED value is a rotation (it stamps `lastRotatedAt`) — a
 * field's or the seed's; an ADDED or REMOVED field or seed is not. It clears
 * `needsRotation` only when no old value survives (C62 (b), below); a patch
 * that changes nothing — the same values or seed, blanks, a `null` seed
 * where there is none — writes and records nothing.
 */
export async function replaceCredentialSecret(
  ctx: VaultCtx,
  credentialId: string,
  input: { readonly secret?: Readonly<Record<string, string | null>>; readonly totp?: string | null },
): Promise<CredentialView> {
  const id = idOf(credentialId, "credentialId");
  const seedText = typeof input.totp === "string" ? input.totp.trim() : "";
  const totpChanged = input.totp === null || seedText !== "";
  const totp = seedText !== "" ? parseTotpInput(seedText) : null;

  return boundedVaultWrite((opts) =>
    withTenant(
      ctx.tenantId,
      principalOf(ctx),
      async (tx) =>
        guarded(async () => {
          await enterVault(tx, ctx, "credential:edit");
          const anchor = await liveAnchor(tx, ctx.tenantId, id);
          await assertAnchorInScope(tx, ctx.actor, anchor);
          const patch = normalizeSecretPatch(anchor.type, input.secret);
          const currentView = () =>
            tx.credentialItem.findFirstOrThrow({ where: { tenantId: ctx.tenantId, id }, select: viewSelect });
          // A form that posted only blanks asked for nothing: answered with
          // the credential as it is, and nothing is locked or written.
          if (Object.keys(patch).length === 0 && !totpChanged) return currentView();
          // The member types the secret: a removal racing this must see it or
          // refuse it — and must not have its flag cleared by a change that
          // was queued behind it (slice 94's security review). The key comes
          // BEFORE the row lock, the one order every holder of it keeps.
          await lockSecretWrite(tx, ctx.tenantId, ctx.actor.memberId);
          // Lock the item row: two changes of one credential would
          // otherwise both read version N and both try to keep it.
          await tx.$queryRaw`SELECT id FROM credential_item WHERE tenant_id = ${ctx.tenantId} AND id = ${id} FOR UPDATE`;
          // Read AFTER the lock: a change that waited must see the other
          // one's result, and a delete that landed while it waited.
          const item = await tx.credentialItem.findFirstOrThrow({
            where: { tenantId: ctx.tenantId, id },
            select: { hasTotp: true, deletedAt: true, secretFieldKeys: true, needsRotation: true },
          });
          if (item.deletedAt !== null) deny("NOT_FOUND");
          // The SAME seed again is not a change; a DIFFERENT seed over an
          // existing one is a replaced value — a rotation (narrow review).
          let sameSeed = false;
          if (totp !== null && item.hasTotp) {
            const now = await readTotp(tx, ctx.tenantId, id);
            sameSeed =
              now !== null &&
              now.secret === totp.secret &&
              now.algorithm === totp.algorithm &&
              now.digits === totp.digits &&
              now.period === totp.period;
          }

          // The old secret is decrypted only when a field is being changed
          // — to merge the patch into it and to keep it as a version; a
          // seed-only change never touches it.
          let current: Awaited<ReturnType<typeof readSecret>> = null;
          let next: Record<string, string> | null = null;
          // The field NAMES whose value was set, replaced or removed — for
          // the trail; and whether an EXISTING value was replaced, which is
          // the only thing that counts as a rotation (adding a field that
          // was not there, or removing one, rotates nothing — fix-pass review).
          let changedFields: string[] = [];
          let rotated = false;
          // Whether a field value the login carried before survives into
          // the changed secret (C62 (b), below).
          let oldValueSurvives = false;
          if (Object.keys(patch).length > 0) {
            current = await readSecret(tx, ctx.tenantId, id);
            if (!current) throw new Error("vault: a live credential has no secret row");
            const before = current.payload.fields;
            const merged: Record<string, string> = { ...before };
            for (const [k, v] of Object.entries(patch)) {
              if (v === null) delete merged[k];
              else merged[k] = v;
            }
            changedFields = SECRET_FIELDS[anchor.type].filter((k) => before[k] !== merged[k]);
            rotated = changedFields.some((k) => k in before && k in merged);
            oldValueSurvives = Object.keys(before).some((k) => k in merged && merged[k] === before[k]);
            if (changedFields.length > 0) next = merged;
          }
          // A `null` seed on a credential that has none removes nothing.
          const seedChange = input.totp === null ? item.hasTotp : totpChanged && !sameSeed;
          const isRotation = rotated || (item.hasTotp && totp !== null && !sameSeed);
          const fieldKeys = next === null ? item.secretFieldKeys : SECRET_FIELDS[anchor.type].filter((k) => k in next!);
          const willHaveTotp = seedChange ? totp !== null : item.hasTotp;
          if (fieldKeys.length === 0 && !willHaveTotp) fail("INVALID_INPUT", "a credential needs a secret or a TOTP seed");
          // "Change soon" goes only when NO old secret value is left (founder
          // decision C62 (b), 2026-10-06): a field changed while another
          // keeps the value a departed member saw is still a rotation (the
          // schedule's), but the mark stays. The parts are the login's
          // FIELDS; the seed is not a part anyone sees — except on a login
          // that had no fields, where it is the only part, and must itself
          // be replaced or removed (slice 94b's review: adding a password to
          // a seed-only login left the old seed and cleared the mark).
          // AND (C63 (e), slice 95): a seed that a member who has since LEFT
          // exported is a part they still hold, so a login keeping that seed
          // keeps its mark until the seed is replaced (or removed) too. Asked
          // only of a marked login that would otherwise clear and keeps its seed
          // — and such a save says so (`heldBySeed`), so that a LATER change of
          // the seed alone finishes it (the fix-round review: the hint's two
          // saves, fields first, must clear; `fieldsClearedSinceMarked`).
          const hadFields = item.secretFieldKeys.length > 0;
          const fieldsClear = hadFields ? next !== null && !oldValueSurvives : seedChange;
          const keepsTakenSeed =
            fieldsClear && item.needsRotation && willHaveTotp && !seedChange
              ? await seedTakenByLeaver(tx, ctx.tenantId, id)
              : false;
          const finishesHeld =
            !fieldsClear && hadFields && item.needsRotation && seedChange
              ? await fieldsClearedSinceMarked(tx, ctx.tenantId, id)
              : false;
          const clearsMark = (fieldsClear && !keepsTakenSeed) || finishesHeld;
          // The same values again are not a change: nothing written, nothing recorded.
          if (next === null && !seedChange) return currentView();

          let newVersion: number | null = null;
          if (next !== null && current !== null) {
            await keepPreviousVersion(tx, {
              tenantId: ctx.tenantId,
              credentialId: id,
              previous: current.payload,
              previousVersion: current.version,
              changedByMemberId: ctx.actor.memberId,
            });
            newVersion = current.version + 1;
          }

          await updateSecretRow(tx, {
            tenantId: ctx.tenantId,
            credentialId: id,
            ...(next === null || newVersion === null ? {} : { replace: { fields: next, version: newVersion } }),
            ...(seedChange ? { totp } : {}),
            memberId: ctx.actor.memberId,
          });
          const row = await tx.credentialItem.update({
            where: { id, tenantId: ctx.tenantId },
            data: {
              secretFieldKeys: [...fieldKeys],
              hasTotp: willHaveTotp,
              // Only a REPLACED value is a rotation; a new seed, an added
              // field or a removed one is not. The mark is `clearsMark`'s.
              ...(isRotation ? { lastRotatedAt: new Date() } : {}),
              ...(clearsMark ? { needsRotation: false } : {}),
              updatedByMemberId: ctx.actor.memberId,
            },
            select: viewSelect,
          });
          await record(tx, {
            action: "credential.updated",
            targetType: "CredentialItem",
            targetId: id,
            metadata: {
              secretChanged: next !== null,
              changedFields,
              rotated: isRotation,
              totpChanged: seedChange,
              // Every field new, the mark kept for a seed a leaver took (C63 (e)).
              ...(keepsTakenSeed ? { heldBySeed: true } : {}),
              fields: [...fieldKeys],
              hasTotp: willHaveTotp,
              ...(newVersion === null ? {} : { version: newVersion }),
            },
          });
          return row;
        }),
      opts,
    ),
  );
}

/**
 * credential:delete — soft delete: the row leaves every list and every
 * reveal at once, and the secret with its versions is purged with it
 * after DATA_MODEL §6.17's thirty days (the purge job is a later slice).
 * Two concurrent deletes record ONE `credential.deleted` (below: the row
 * lock). A binned login is never shown to
 * a client (slice 91's security review): the delete puts it back to
 * INTERNAL, so a restore — none exists yet — could never bring one back
 * shown without a member deciding again, with their authenticator.
 *
 * A SEALED login (slice 92) is deleted by an owner only — founder decision
 * C60 (b): deleting it takes away the client's right to ask for it, as
 * unsealing does — so it also asks `credential:unseal`, and the write
 * clears the seal (the database's `credential_item_sealed_is_live`: the
 * bin holds no seal). The seal state is read with the row LOCKED
 * (`lockedState`), so the permission is checked against the state the
 * write changes — a seal or unseal waits for the delete, or the delete for
 * it, inside `boundedVaultWrite` (the reviews: the delete waits on a
 * seal's row, so its wait is bounded as the seal's, share's and show's
 * are; `updateCredential` is not wrapped — an edit waiting behind a seal
 * is bounded only by the seal's own lock waits; `createCredential` is since
 * slice 94, for the member's key it now takes).
 * Two concurrent deletes still record ONE `credential.deleted`: the second
 * finds the row binned under the lock and is NOT_FOUND.
 */
export async function deleteCredential(ctx: VaultCtx, credentialId: string): Promise<void> {
  const id = idOf(credentialId, "credentialId");
  await boundedVaultWrite((opts) => withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await enterVault(tx, ctx, "credential:delete");
    const anchor = await liveAnchor(tx, ctx.tenantId, id);
    await assertAnchorInScope(tx, ctx.actor, anchor);
    const { sealed } = await lockedState(tx, ctx.tenantId, id);
    if (sealed) await requireAccess(tx, ctx.tenantId, ctx.actor, "credential:unseal");
    await tx.credentialItem.update({
      where: { id, tenantId: ctx.tenantId },
      data: { deletedAt: new Date(), visibility: "INTERNAL", sealedAt: null, updatedByMemberId: ctx.actor.memberId },
      select: { id: true },
    });
    await record(tx, {
      action: "credential.deleted",
      targetType: "CredentialItem",
      targetId: id,
      metadata: { clientId: anchor.clientId, projectId: anchor.projectId, ...(sealed ? { sealed: true } : {}) },
    });
  }, opts));
}
