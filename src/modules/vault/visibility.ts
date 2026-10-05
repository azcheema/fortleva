import { record } from "@/audit/record";
import { requireRecentMfa } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { fail } from "@/lib/domain-error";
import { portalCredentialsSwitchLockKey } from "@/preferences/config";
import { readPreferences } from "@/preferences/service";

import { boundedVaultWrite, idOf, principalOf, type VaultCtx } from "./ctx";
import { enterVault } from "./door";
import { assertAnchorInScope } from "./scope";

/**
 * SHOWING A LOGIN TO THE CLIENT, AND HIDING IT AGAIN (Phase 3V slice 91;
 * founder decisions C52 (d), C59; AUTHZ.md §3.2's
 * `credential:change_visibility`). A shown login is one the client's MAIN
 * contacts can open in their portal — with their password and a mailed
 * code each time (`portal-writes.ts`) — while the workspace has client
 * logins switched on.
 *
 * SHOWING asks, in this order:
 *   1. the vault's door (`enterVault`: no impersonation, `credential:view`
 *      on all four gates, the vault's window);
 *   2. `credential:change_visibility` ✦ and a factor no older than
 *      `SHOW_STEP_UP_MINUTES` — ALWAYS a fresh factor (AUTHZ.md §7.5, CP4:
 *      "always step-up for … visibility"), so the dialog carries the
 *      member's authenticator code, verified by the action just before;
 *   3. the login, live and in the member's scope (NOT_FOUND otherwise, so
 *      nothing after this can tell an out-of-scope id from a missing one);
 *   4. a client to show it to — the agency's own logins (C49) have none,
 *      and the database refuses one shown without a client anyway
 *      (`credential_item_client_visible_needs_client`) — and a login that
 *      is not SEALED (slice 92, C60 (a): a sealed login reaches the client
 *      only by their asking; `LOGIN_SEALED`, and the database's
 *      `credential_item_sealed_is_internal`);
 *   5. the switch's lock SHARED, then the switch itself
 *      (`portalCredentialsSwitchLockKey`): a login is shown wholly before a
 *      switch-off begins — and is hidden by it — or after it commits, and
 *      is then refused (C59 (b): a switch-off is for good).
 *
 * HIDING asks the door and the permission only, within the vault's window
 * — no fresh authenticator code: it takes access away, as revoking a share
 * link does, and must stay easy in an incident.
 *
 * BOTH WAIT ON LOCKS — showing on the switch's lock (behind a switch-off
 * that is un-marking every login) and on the login's row, hiding on the
 * row — so both run inside `boundedVaultWrite`: a bounded wait, a few
 * tries, then VAULT_BUSY, never a pooled connection parked behind a lock
 * (the trap `with-tenant.ts` measured; the code review's low). Neither asks `credential:edit`: who may decide what a client
 * sees is its own question.
 *
 * Both are idempotent — a login already in the asked state writes nothing
 * and records nothing — and each change is one `credential.visibility_
 * changed` row naming the new visibility.
 */

/** Showing a login asks a factor this recent (minutes) — the share form's rule. */
export const SHOW_STEP_UP_MINUTES = 1;

async function liveLogin(tx: TenantDb, tenantId: string, id: string) {
  const item = await tx.credentialItem.findFirst({
    where: { tenantId, id, deletedAt: null },
    select: { id: true, clientId: true, projectId: true, visibility: true, sealedAt: true },
  });
  if (!item) return deny("NOT_FOUND");
  return item;
}

/** credential:change_visibility ✦ (a factor this minute) — show a login to the client's main contacts. */
export async function showLoginToClient(ctx: VaultCtx, credentialId: string): Promise<void> {
  const id = idOf(credentialId, "credentialId");
  await boundedVaultWrite((opts) => withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await enterVault(tx, ctx, "credential:view");
    await requireAccess(tx, ctx.tenantId, ctx.actor, "credential:change_visibility");
    await requireRecentMfa(ctx.actor, SHOW_STEP_UP_MINUTES);
    const item = await liveLogin(tx, ctx.tenantId, id);
    await assertAnchorInScope(tx, ctx.actor, item);
    if (item.clientId === null) fail("LOGIN_HAS_NO_CLIENT");
    // Sealed (slice 92, C60 (a)): the client gets it only by asking.
    if (item.sealedAt !== null) fail("LOGIN_SEALED");

    // `$executeRaw`: the lock returns `void`, which `$queryRaw` cannot read.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${portalCredentialsSwitchLockKey(ctx.tenantId)}))`;
    const prefs = await readPreferences(tx, ctx.tenantId);
    if (!prefs.vault.allowPortalCredentials) fail("CLIENT_LOGINS_OFF");

    // The state in the WRITE, not only in the read above: a delete or a
    // concurrent show that committed in between must not be shown (or
    // recorded) twice.
    const written = await tx.credentialItem.updateMany({
      where: { id, tenantId: ctx.tenantId, deletedAt: null, visibility: "INTERNAL", sealedAt: null },
      data: { visibility: "CLIENT_VISIBLE", updatedByMemberId: ctx.actor.memberId },
    });
    if (written.count !== 1) {
      const now = await liveLogin(tx, ctx.tenantId, id);
      if (now.visibility === "CLIENT_VISIBLE") return;
      // Sealed in between (the database's `credential_item_sealed_is_internal` besides).
      if (now.sealedAt !== null) fail("LOGIN_SEALED");
      return deny("NOT_FOUND");
    }
    await record(tx, {
      action: "credential.visibility_changed",
      targetType: "CredentialItem",
      targetId: id,
      metadata: { visibility: "CLIENT_VISIBLE", clientId: item.clientId },
    });
  }, opts));
}

/** credential:change_visibility ✦ (the vault's window) — hide a shown login from the client again. */
export async function hideLoginFromClient(ctx: VaultCtx, credentialId: string): Promise<void> {
  const id = idOf(credentialId, "credentialId");
  await boundedVaultWrite((opts) => withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await enterVault(tx, ctx, "credential:view");
    await requireAccess(tx, ctx.tenantId, ctx.actor, "credential:change_visibility");
    const item = await liveLogin(tx, ctx.tenantId, id);
    await assertAnchorInScope(tx, ctx.actor, item);
    const written = await tx.credentialItem.updateMany({
      where: { id, tenantId: ctx.tenantId, deletedAt: null, visibility: "CLIENT_VISIBLE" },
      data: { visibility: "INTERNAL", updatedByMemberId: ctx.actor.memberId },
    });
    // Already hidden (by another member, or by switching client logins
    // off): nothing to do, nothing to record.
    if (written.count !== 1) return;
    await record(tx, {
      action: "credential.visibility_changed",
      targetType: "CredentialItem",
      targetId: id,
      metadata: { visibility: "INTERNAL", clientId: item.clientId },
    });
  }, opts));
}
