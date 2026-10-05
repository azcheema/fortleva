import { record } from "@/audit/record";
import { deny } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { fail } from "@/lib/domain-error";

import { boundedVaultWrite, idOf, principalOf, type VaultCtx } from "./ctx";
import { enterVault } from "./door";
import { assertAnchorInScope } from "./scope";

/**
 * SEALING A LOGIN, AND UNSEALING IT (Phase 3V slice 92 — founder decisions
 * C52 (e), C60; AUTHZ.md §3.2's `credential:unseal`). A sealed login is one
 * the agency keeps FOR its client and does not want opened without real
 * need: staff use it exactly as before (C52 (e): "staff never ask"), and
 * the client is kept out — no "client can see" (slice 91), no share link
 * (C60 (a)). Slice 93 lets the client ASK to open their sealed logins —
 * everyone who holds `credential:unseal` told — and wait
 * (`sealed-requests.ts`, `sealed-portal-writes.ts`); nothing here knows
 * about that: an open ask shows the client the logins that were sealed when
 * it was DECIDED (approved, or confirmed after the wait) — a login sealed
 * here while it is open stays shut, as sealing promises (both slice-93
 * reviews' medium) — and unsealing or deleting one takes it out.
 *
 * SEALING (`credential:edit` — "anyone who can edit a login can seal it"):
 *   1. the vault's door for `credential:edit` (no impersonation, the code
 *      on all four gates, the vault's window);
 *   2. the login, live and in the member's scope (NOT_FOUND otherwise);
 *   3. a client to keep it for — the agency's own logins (C49) have
 *      nobody who could ever ask (`LOGIN_HAS_NO_CLIENT`; the database's
 *      `credential_item_sealed_needs_client` besides);
 *   4. a login SHOWN to the client is hidden by the seal, in the same
 *      write — which is hiding it, so the member must also hold
 *      `credential:change_visibility` (`hideLoginFromClient`'s rule: who
 *      decides what a client sees is its own question — founder decision C60
 *      (c), 2026-10-05), and the change is
 *      recorded as a `credential.visibility_changed` with `cause: "sealed"`;
 *   5. every OPEN share link of the login is revoked, in the same
 *      transaction, as the sealer (C60 (a): "sealing ends its open links")
 *      — one `credential.share_revoked` each, `cause: "sealed"`. Sealing
 *      does not need `credential:share`: ending the links is part of what
 *      a seal is. A link being MADE right now holds the login `FOR SHARE`
 *      (`createShareLink`), which this transaction's `FOR UPDATE` of the
 *      row waits out — so the link exists by the time the revoke below runs
 *      (READ COMMITTED takes a fresh snapshot per statement) — and one made after the seal
 *      commits is refused by `createShareLink`, and by the database
 *      (`credential_share_link_not_sealed`). A link being OPENED right now
 *      holds its own row, which the revoke waits out: it was opened before
 *      the seal, and stays opened.
 *
 * UNSEALING (`credential:unseal` ✦ — owners only, C52 (e)) asks the vault's
 * window only, no fresh authenticator code: like hiding a login or revoking
 * a link it takes access AWAY — here the client's right to ask.
 *
 * DELETING a sealed login is `deleteCredential`'s, which asks
 * `credential:unseal` too (C60 (b)) and clears the seal in its write.
 *
 * Both verbs are idempotent — a login already in the asked state writes and
 * records nothing — and both run inside `boundedVaultWrite`: they wait on
 * the login's row (and sealing on its links'), so a bounded wait, a few
 * tries, then VAULT_BUSY.
 */

/** The database's clock NOW — not the transaction's start, which `now()` is. */
async function wallClock(tx: TenantDb): Promise<Date> {
  const rows = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  const row = rows[0];
  if (!row) throw new Error("vault: the database returned no clock");
  return row.now;
}

/**
 * The login's row LOCKED for the rest of the transaction, and what a seal
 * or a delete decides on: nothing can bin, seal, unseal, show or hide it
 * between this read and the write that follows (the reviews: a conditional
 * write on an unlocked read left a "changed in between" branch). Waits are
 * bounded by the caller (`boundedVaultWrite`). Exported for `items.ts`'s
 * delete only.
 */
export async function lockedState(tx: TenantDb, tenantId: string, id: string) {
  const rows = await tx.$queryRaw<{ sealed_at: Date | null; visibility: string; deleted_at: Date | null }[]>`
    SELECT sealed_at, visibility::text AS visibility, deleted_at
      FROM credential_item WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
  const row = rows[0];
  if (!row || row.deleted_at !== null) return deny("NOT_FOUND");
  return { sealed: row.sealed_at !== null, shown: row.visibility === "CLIENT_VISIBLE" };
}

async function liveLogin(tx: TenantDb, tenantId: string, id: string) {
  const item = await tx.credentialItem.findFirst({
    where: { tenantId, id, deletedAt: null },
    select: { id: true, clientId: true, projectId: true, visibility: true, sealedAt: true },
  });
  if (!item) return deny("NOT_FOUND");
  return item;
}

/** credential:edit — seal a login for its client; hides it if shown (+ change_visibility) and ends its open links. */
export async function sealLogin(ctx: VaultCtx, credentialId: string): Promise<void> {
  const id = idOf(credentialId, "credentialId");
  await boundedVaultWrite((opts) => withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await enterVault(tx, ctx, "credential:edit");
    // Scope and anchor from a plain read (a login never moves between
    // clients or projects), so nothing is locked for a member out of scope.
    const item = await liveLogin(tx, ctx.tenantId, id);
    await assertAnchorInScope(tx, ctx.actor, item);
    if (item.clientId === null) fail("LOGIN_HAS_NO_CLIENT");
    // Then the row, LOCKED: the state the permission is checked against is
    // the state the write changes. A link being made holds the row FOR
    // SHARE, which this waits out (the header).
    const state = await lockedState(tx, ctx.tenantId, id);
    if (state.sealed) return;
    const wasShown = state.shown;
    if (wasShown) await requireAccess(tx, ctx.tenantId, ctx.actor, "credential:change_visibility");

    // The database's clock NOW, after the lock — `now()` is this
    // transaction's start, and neither the seal nor a revoke below may
    // predate a link this waited for (the reviews' lows).
    const sealedAt = await wallClock(tx);
    await tx.credentialItem.update({
      where: { id, tenantId: ctx.tenantId },
      data: { sealedAt, visibility: "INTERNAL", updatedByMemberId: ctx.actor.memberId },
      select: { id: true },
    });
    await record(tx, {
      action: "credential.sealed",
      targetType: "CredentialItem",
      targetId: id,
      metadata: { clientId: item.clientId, wasShown },
    });
    if (wasShown) {
      await record(tx, {
        action: "credential.visibility_changed",
        targetType: "CredentialItem",
        targetId: id,
        metadata: { visibility: "INTERNAL", clientId: item.clientId, cause: "sealed" },
      });
    }

    // Every link not opened, not revoked and still in date — one already
    // locked, stopped or changed included: each is dead and none could
    // revive, but revoking it costs nothing and leaves no question; an
    // expired one is left as it ended. ONE statement that changes and
    // names the rows it changed, so a link revoked or opened by someone
    // else in between is not recorded as this seal's. Stamped by the clock
    // read after the lock, which waited out any link being made.
    const revoked = await tx.credentialShareLink.updateManyAndReturn({
      where: { tenantId: ctx.tenantId, credentialId: id, viewedAt: null, revokedAt: null, expiresAt: { gt: sealedAt } },
      data: { revokedAt: sealedAt, revokedByMemberId: ctx.actor.memberId },
      select: { id: true },
    });
    // In turn, never a `Promise.all` on one interactive transaction (AGENTS.md).
    for (const link of revoked) {
      await record(tx, {
        action: "credential.share_revoked",
        targetType: "CredentialShareLink",
        targetId: link.id,
        metadata: { credentialId: id, cause: "sealed" },
      });
    }
  }, opts));
}

/** credential:unseal ✦ (owners; the vault's window) — unseal a login: the client can no longer ask for it. */
export async function unsealLogin(ctx: VaultCtx, credentialId: string): Promise<void> {
  const id = idOf(credentialId, "credentialId");
  await boundedVaultWrite((opts) => withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await enterVault(tx, ctx, "credential:view");
    await requireAccess(tx, ctx.tenantId, ctx.actor, "credential:unseal");
    const item = await liveLogin(tx, ctx.tenantId, id);
    await assertAnchorInScope(tx, ctx.actor, item);
    const written = await tx.credentialItem.updateMany({
      where: { id, tenantId: ctx.tenantId, deletedAt: null, sealedAt: { not: null } },
      data: { sealedAt: null, updatedByMemberId: ctx.actor.memberId },
    });
    // Not sealed (never, or unsealed by another owner): nothing to do, nothing to record.
    if (written.count !== 1) return;
    await record(tx, {
      action: "credential.unsealed",
      targetType: "CredentialItem",
      targetId: id,
      metadata: { clientId: item.clientId },
    });
  }, opts));
}
