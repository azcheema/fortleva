import { requireRecentMfa } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { heldAndAccessibleCodes, requireAccess } from "@/entitlements/resolver";
import { readPreferences } from "@/preferences/service";

import { principalOf, type VaultCtx } from "./ctx";

/**
 * THE VAULT DOOR (founder decision C52 (a), 2026-10-02): the whole vault
 * is locked, the list included. Every metadata service in `items.ts` —
 * the list, one login, adding, editing, changing a secret, deleting —
 * enters through `enterVault`, which wants a second factor no older than
 * `vault.stepUpMinutes`: the window the reveal path has always required
 * (`reveal.ts`, which keeps its own, stricter order because it RECORDS its
 * refusal against the credential it was asked for; the door records
 * nothing, because opening a tab is not touching a secret). Names,
 * usernames and web addresses are a map of what to attack, which is why
 * they sit behind the door too.
 *
 * ONE CALL PER SERVICE, so a verb cannot keep the permission check and
 * forget the window: the three checks travel together.
 *   1. Impersonation never enters (AUTHZ.md §7.5 and §9 — the reveal
 *      path's rule, now the whole vault's), refused before anything is
 *      read.
 *   2. The permission, on all four gates.
 *   3. The window — AFTER the permission, as `authorize()` checks a ✦
 *      code, so MFA_REQUIRED never tells a member who holds no
 *      `credential:*` code that they would otherwise be let in. A missing
 *      factor answers `enrol`, a stale one `step_up`; the page turns
 *      either into the door.
 */

export type VaultCode =
  | "credential:view"
  | "credential:create"
  | "credential:edit"
  | "credential:delete";

/** Enter the vault for one verb; answers the window it was entered under. */
export async function enterVault(tx: TenantDb, ctx: VaultCtx, code: VaultCode): Promise<{ stepUpMinutes: number }> {
  if (ctx.actor.impersonated) deny("FORBIDDEN", "impersonation never opens the vault");
  await requireAccess(tx, ctx.tenantId, ctx.actor, code);
  const prefs = await readPreferences(tx, ctx.tenantId);
  await requireRecentMfa(ctx.actor, prefs.vault.stepUpMinutes);
  return { stepUpMinutes: prefs.vault.stepUpMinutes };
}

/** What a member may do inside the open vault — the controls a page draws. */
export type VaultAbilities = {
  readonly create: boolean;
  readonly edit: boolean;
  readonly delete: boolean;
  /** `credential:reveal` ✦ — the eye, the copy and the TOTP code. */
  readonly reveal: boolean;
  /**
   * Share links (slice 90): `credential:share` ✦ AND `credential:reveal` ✦
   * (`share-links.ts` asks both), with share links on for the workspace.
   */
  readonly share: boolean;
  /**
   * Logins shown to clients (slice 91): `credential:change_visibility` ✦.
   * `show` also needs the workspace's switch on; `hide` never does — a
   * login left shown must always be hideable.
   */
  readonly showToClient: boolean;
  readonly hideFromClient: boolean;
  /**
   * The sealed layer (slice 92, C52 (e)): anyone who may EDIT a login seals
   * it (`credential:edit` — `edit` above); `credential:unseal` ✦ (owners)
   * unseals one and deletes a sealed one (C60 (b)).
   */
  readonly unseal: boolean;
  /**
   * The export (slice 95, C63): `credential:export` ✦ AND
   * `credential:reveal` ✦ (`export.ts` asks both).
   */
  readonly export: boolean;
};

export type OpenVault = {
  /** When the window this member entered under closes — the page locks itself then. */
  readonly locksAt: Date;
  readonly can: VaultAbilities;
  /** The longest a share link may live here (`vault.shareLinkMaxTtlHours`), for the share form's choices. */
  readonly shareMaxHours: number;
};

const ABILITY_CODES = [
  "credential:create",
  "credential:edit",
  "credential:delete",
  "credential:reveal",
  "credential:share",
  "credential:change_visibility",
  "credential:unseal",
  "credential:export",
] as const;

/**
 * The door itself, for a page: enter with `credential:view` (refused
 * exactly as every other vault service refuses), then answer when the
 * vault locks again and which controls to draw. A control is drawn only
 * where its service would accept the member — §3.1's "hidden, never
 * disabled".
 *
 * `credential:reveal` (and `credential:share`, `credential:change_visibility`, `credential:unseal`, `credential:export`) ARE ✦ CODES, which `heldAndAccessibleCodes` normally
 * cannot answer (a stale factor reads as "not held"). Here it can: the door
 * has just proved a factor no older than `vault.stepUpMinutes`, which the
 * preference schema caps at 15 — the ✦ window `authorize()` applies — so
 * the answer is the one the reveal path's own `requireAccess` will give.
 */
export async function openVault(ctx: VaultCtx): Promise<OpenVault> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    const { stepUpMinutes } = await enterVault(tx, ctx, "credential:view");
    const verifiedAt = ctx.actor.mfa?.verifiedAt;
    // Unreachable after the door, which refuses a missing stamp — but a
    // lock time must never be computed from nothing.
    if (!verifiedAt) return deny("MFA_REQUIRED", "step_up");
    const { accessible } = await heldAndAccessibleCodes(tx, ctx.tenantId, ctx.actor, ABILITY_CODES);
    const prefs = await readPreferences(tx, ctx.tenantId);
    return {
      locksAt: new Date(verifiedAt.getTime() + stepUpMinutes * 60_000),
      can: {
        create: accessible.has("credential:create"),
        edit: accessible.has("credential:edit"),
        delete: accessible.has("credential:delete"),
        reveal: accessible.has("credential:reveal"),
        share:
          accessible.has("credential:share") &&
          accessible.has("credential:reveal") &&
          prefs.vault.allowExternalShareLinks,
        showToClient: accessible.has("credential:change_visibility") && prefs.vault.allowPortalCredentials,
        hideFromClient: accessible.has("credential:change_visibility"),
        unseal: accessible.has("credential:unseal"),
        export: accessible.has("credential:export") && accessible.has("credential:reveal"),
      },
      shareMaxHours: prefs.vault.shareLinkMaxTtlHours,
    };
  });
}
