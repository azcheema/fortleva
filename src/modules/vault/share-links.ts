import { z } from "zod";

import { record } from "@/audit/record";
import { requireRecentMfa } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { absoluteUrl } from "@/config";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { DomainError, fail } from "@/lib/domain-error";
import { shareSwitchLockKey } from "@/preferences/config";
import { readPreferences } from "@/preferences/service";
import { allow } from "@/ratelimit";

import { lockRevealBudget, revealsInLastHour } from "./budget";
import { boundedVaultWrite, idOf, principalOf, type VaultCtx } from "./ctx";
import { enterVault } from "./door";
import { SECRET_FIELDS, isCredentialType } from "./fields";
import { assertAnchorInScope } from "./scope";
import { readSecretVersion } from "./secret-store";
import { mintShareToken, shareLinkPath, shareLinkStatus, type ShareLinkStatus } from "./share-token";

export type { ShareLinkStatus } from "./share-token";

/**
 * SHARE LINKS, THE MEMBER'S HALF (Phase 3V slice 90; DATA_MODEL.md §6.17;
 * AUTHZ.md §3.2's `credential:share` row; CP4: "share links on — an
 * emailed code, opened once, within 7 days").
 *
 * A member makes a link to ONE secret field of one login for somebody
 * outside the agency, copies it, and sends it however they like. The
 * person who opens it is mailed a six-digit code at the address the
 * member gave, and sees the value once (`share-open.ts`). The member can
 * list a login's links and revoke one that has not been opened.
 *
 * MAKING A LINK IS THE STRICTEST ACT IN THE VAULT, in this order:
 *   1. the vault's door (`enterVault`): impersonation never, then
 *      `credential:view` on all four gates, then the vault's window;
 *   2. `credential:share` ✦ AND `credential:reveal` ✦ — a link to oneself
 *      would otherwise be a reveal the reveal code never granted;
 *   3. a factor verified within `SHARE_STEP_UP_MINUTES` — AUTHZ.md §7.5:
 *      share "always" steps up, whatever the vault's window. The share
 *      form carries the member's authenticator code and its action
 *      verifies it immediately before calling here, so in practice every
 *      link costs one code; the minute is only the round trip's slack;
 *   4. the login is live and IN SCOPE (NOT_FOUND otherwise — the same
 *      answer as a login that does not exist);
 *   5. the workspace allows share links, the lifetime is within its cap,
 *      and the field is one the login actually has;
 *   6. THE REVEAL BUDGET (security review): a link to one's own address is
 *      a reveal by another door, so each `credential.shared` counts as one
 *      of the member's reveals for the hour (`budget.ts`) — a tenant that
 *      lowers `vault.revealBudgetPerHour` lowers links with it. Exceeding
 *      it is RECORDED (`vault.reveal_budget_exceeded`) and the refusal
 *      commits, `reveal.ts`'s rule.
 * Then the link row and `credential.shared`, in one transaction. The
 * token exists in this process only until it is returned: the database
 * keeps its hash, and nothing logs.
 */

/** "Always": a factor this recent, which the share action has just verified. */
export const SHARE_STEP_UP_MINUTES = 1;

/** How many of a login's CLOSED links its list shows, newest first. */
export const SHARE_LIST_LIMIT = 20;
/** How many of a login's open links its list shows — all of them, in any real workspace. */
export const SHARE_LIVE_LIMIT = 200;

const emailSchema = z.email().max(320);

/** The address a code will go to: trimmed, lowercased, a real address — or refused. */
function normalizeRecipient(raw: unknown): string {
  if (typeof raw !== "string") return fail("INVALID_INPUT", "recipient");
  const email = raw.trim().toLowerCase();
  if (!emailSchema.safeParse(email).success) fail("EMAIL_INVALID");
  return email;
}

export type CreateShareLinkInput = {
  readonly field: string;
  readonly recipientEmail: string;
  readonly expiresInHours: number;
  readonly includeUsername: boolean;
};

export type CreatedShareLink = {
  readonly id: string;
  /** The link to send — shown to the member ONCE; only its hash is kept. */
  readonly url: string;
  readonly expiresAt: Date;
};

/** The database's clock — the one `created_at` defaults to and the CHECKs compare against. */
async function dbNow(tx: TenantDb): Promise<Date> {
  const rows = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  const row = rows[0];
  if (!row) throw new Error("vault: the database returned no clock");
  return row.now;
}

/** A live credential's type, anchor and set fields — or NOT_FOUND. */
async function liveItem(tx: TenantDb, tenantId: string, id: string) {
  const item = await tx.credentialItem.findFirst({
    where: { tenantId, id, deletedAt: null },
    select: { id: true, type: true, clientId: true, projectId: true, secretFieldKeys: true },
  });
  if (!item) return deny("NOT_FOUND");
  return item;
}

/** credential:share ✦ (+ credential:reveal ✦, a factor this minute) — make a link. */
export async function createShareLink(
  ctx: VaultCtx,
  credentialId: string,
  input: CreateShareLinkInput,
): Promise<CreatedShareLink> {
  const id = idOf(credentialId, "credentialId");
  // Pure checks first: nothing is read for a request that cannot succeed.
  if (typeof input.field !== "string" || input.field.length === 0 || input.field.length > 64) {
    fail("INVALID_INPUT", "field");
  }
  const hours = input.expiresInHours;
  if (typeof hours !== "number" || !Number.isInteger(hours) || hours < 1 || hours > 168) {
    fail("INVALID_INPUT", "lifetime");
  }
  if (typeof input.includeUsername !== "boolean") fail("INVALID_INPUT", "includeUsername");
  const recipientEmail = normalizeRecipient(input.recipientEmail);

  // The reveal path's cheap filter in front of the authority below (a
  // no-op without Upstash); shared with reveals, as the budget is.
  if (!(await allow("vault.reveal", ctx.actor.memberId))) fail("REVEAL_BUDGET_EXCEEDED", "front filter");

  type Made = { readonly value: CreatedShareLink } | { readonly refused: Error };
  const made: Made = await boundedVaultWrite((opts) => withTenant(ctx.tenantId, principalOf(ctx), async (tx): Promise<Made> => {
    await enterVault(tx, ctx, "credential:view");
    await requireAccess(tx, ctx.tenantId, ctx.actor, "credential:share");
    await requireAccess(tx, ctx.tenantId, ctx.actor, "credential:reveal");
    await requireRecentMfa(ctx.actor, SHARE_STEP_UP_MINUTES);

    const item = await liveItem(tx, ctx.tenantId, id);
    await assertAnchorInScope(tx, ctx.actor, item);

    // The switch's lock, SHARED, before the switch is read: a link is made
    // wholly before a switch-off stamps (and is stopped by it) or after it
    // commits — and is then refused, either because links are off or, if
    // they were switched on again meanwhile, because this transaction began
    // before the stamp (checked below, on the database's clock).
    // `$executeRaw`: the lock returns `void`, which `$queryRaw` cannot read.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${shareSwitchLockKey(ctx.tenantId)}))`;
    const prefs = await readPreferences(tx, ctx.tenantId);
    if (!prefs.vault.allowExternalShareLinks) fail("SHARE_LINKS_OFF");
    if (hours > prefs.vault.shareLinkMaxTtlHours) fail("INVALID_INPUT", "lifetime over the workspace's cap");
    if (!isCredentialType(item.type) || !SECRET_FIELDS[item.type].includes(input.field)) {
      fail("INVALID_INPUT", "field");
    }
    // A field the type has but this login does not carry has nothing to share.
    if (!item.secretFieldKeys.includes(input.field)) fail("INVALID_INPUT", "field is not set");

    // The budget's lock and count, as a reveal takes them. Its clock is the
    // database's and serves the lifetime too — ONE clock for both ends,
    // since the CHECK holds `expires_at` to `created_at + 168 hours` and a
    // JS clock a few ms ahead of the database's would fail a seven-day link
    // on the boundary.
    const now = await lockRevealBudget(tx, ctx.tenantId, ctx.actor.memberId);
    // Begun before the last switch-off (an off-then-on while this waited for
    // the switch's lock): its `created_at` would be older than the stamp, a
    // link stopped at birth — refuse it instead (the narrow round).
    const stoppedAt = prefs.vault.shareLinksStoppedAt;
    if (stoppedAt !== null && now.getTime() <= stoppedAt.getTime()) fail("SHARE_LINKS_OFF");
    const used = await revealsInLastHour(tx, ctx.tenantId, ctx.actor.memberId, now);
    const budget = prefs.vault.revealBudgetPerHour;
    if (used >= budget) {
      await record(tx, {
        action: "vault.reveal_budget_exceeded",
        targetType: "CredentialItem",
        targetId: id,
        metadata: { used, budget, act: "share" },
      });
      return { refused: new DomainError("REVEAL_BUDGET_EXCEEDED") };
    }
    // The secret's version under a SHARE lock on the login, read after the
    // waits above: a secret being replaced (`replaceCredentialSecret` holds
    // the row FOR UPDATE) is waited out, so the link pins the version it
    // will actually show, never one already gone (the fix-pass review).
    const held = await tx.$queryRaw<{ deleted_at: Date | null; secret_field_keys: string[] }[]>`
      SELECT deleted_at, secret_field_keys FROM credential_item WHERE tenant_id = ${ctx.tenantId} AND id = ${id} FOR SHARE`;
    if (!held[0] || held[0].deleted_at !== null) return deny("NOT_FOUND");
    // ...and the field still set after those waits: a replacement that
    // removed it would leave a link to nothing (the narrow round).
    if (!held[0].secret_field_keys.includes(input.field)) fail("INVALID_INPUT", "field is not set");
    const secretVersion = await readSecretVersion(tx, ctx.tenantId, id);
    if (secretVersion === null) throw new Error("vault: a live credential has no secret row");
    const expiresAt = new Date(now.getTime() + hours * 3_600_000);
    const { token, tokenHash } = mintShareToken(ctx.tenantId);
    const link = await tx.credentialShareLink.create({
      data: {
        tenantId: ctx.tenantId,
        credentialId: id,
        tokenHash,
        field: input.field,
        includeUsername: input.includeUsername,
        recipientEmail,
        secretVersion,
        expiresAt,
        createdByMemberId: ctx.actor.memberId,
        createdAt: now,
      },
      select: { id: true },
    });
    await record(tx, {
      action: "credential.shared",
      targetType: "CredentialShareLink",
      targetId: link.id,
      // The credential and the field, never the address or the token.
      metadata: {
        credentialId: id,
        field: input.field,
        includeUsername: input.includeUsername,
        expiresInHours: hours,
      },
    });
    return { value: { id: link.id, url: absoluteUrl(shareLinkPath(token)), expiresAt } };
  }, opts));
  if ("refused" in made) throw made.refused;
  return made.value;
}

export type ShareLinkView = {
  readonly id: string;
  readonly recipientEmail: string;
  readonly field: string;
  readonly includeUsername: boolean;
  readonly status: ShareLinkStatus;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  /** When it was opened, or revoked — the moment its status names. */
  readonly closedAt: Date | null;
};

/**
 * credential:share ✦ — a login's links: every one not yet closed or
 * expired (up to `SHARE_LIVE_LIMIT`) first, then the newest of the rest (up
 * to `SHARE_LIST_LIMIT`). Open links come first because this list is the
 * only place one can be revoked — a cut by date alone would let twenty
 * newer links bury a live one (the security review). Inside the vault's
 * door like every vault read; the recipient's address is shown only to
 * members who may make links.
 */
export async function listShareLinks(ctx: VaultCtx, credentialId: string): Promise<readonly ShareLinkView[]> {
  const id = idOf(credentialId, "credentialId");
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await enterVault(tx, ctx, "credential:view");
    await requireAccess(tx, ctx.tenantId, ctx.actor, "credential:share");
    const item = await liveItem(tx, ctx.tenantId, id);
    await assertAnchorInScope(tx, ctx.actor, item);
    const now = await dbNow(tx);
    const select = {
      id: true,
      recipientEmail: true,
      field: true,
      includeUsername: true,
      secretVersion: true,
      expiresAt: true,
      codeAttempts: true,
      codesSent: true,
      codeExpiresAt: true,
      viewedAt: true,
      revokedAt: true,
      createdAt: true,
    } as const;
    // In SEQUENCE: one transaction's connection (AGENTS.md). The status
    // below still names an open link that is locked, stopped or changed.
    const open = await tx.credentialShareLink.findMany({
      where: { tenantId: ctx.tenantId, credentialId: id, viewedAt: null, revokedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: "desc" },
      take: SHARE_LIVE_LIMIT,
      select,
    });
    const closed = await tx.credentialShareLink.findMany({
      where: {
        tenantId: ctx.tenantId,
        credentialId: id,
        OR: [{ viewedAt: { not: null } }, { revokedAt: { not: null } }, { expiresAt: { lte: now } }],
      },
      orderBy: { createdAt: "desc" },
      take: SHARE_LIST_LIMIT,
      select,
    });
    const currentVersion = await readSecretVersion(tx, ctx.tenantId, id);
    const prefs = await readPreferences(tx, ctx.tenantId);
    // Two statements, two snapshots: a link opened or revoked between them
    // is in both. Listed once, as the first read saw it.
    const openIds = new Set(open.map((r) => r.id));
    return [...open, ...closed.filter((r) => !openIds.has(r.id))].map((r) => ({
      id: r.id,
      recipientEmail: r.recipientEmail,
      field: r.field,
      includeUsername: r.includeUsername,
      status: shareLinkStatus(r, currentVersion, now, prefs.vault.shareLinksStoppedAt),
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      closedAt: r.viewedAt ?? r.revokedAt,
    }));
  });
}

/**
 * credential:share ✦ — end a link nobody has opened. Asks the vault's
 * window, not a fresh code: revoking only takes access away. Two
 * concurrent revokes record ONE `credential.share_revoked` — the write is
 * conditional on the link still being open — and a link already opened or
 * revoked is `SHARE_LINK_CLOSED`. Its lock wait is bounded: the share page
 * holds the row for the moment it takes to open it.
 */
export async function revokeShareLink(ctx: VaultCtx, linkId: string): Promise<void> {
  const id = idOf(linkId, "linkId");
  await boundedVaultWrite((opts) =>
    withTenant(
      ctx.tenantId,
      principalOf(ctx),
      async (tx) => {
        await enterVault(tx, ctx, "credential:view");
        await requireAccess(tx, ctx.tenantId, ctx.actor, "credential:share");
        const link = await tx.credentialShareLink.findFirst({
          where: { tenantId: ctx.tenantId, id },
          select: { id: true, credentialId: true },
        });
        if (!link) return deny("NOT_FOUND");
        const item = await liveItem(tx, ctx.tenantId, link.credentialId);
        await assertAnchorInScope(tx, ctx.actor, item);
        const written = await tx.credentialShareLink.updateMany({
          where: { tenantId: ctx.tenantId, id, viewedAt: null, revokedAt: null },
          data: { revokedAt: await dbNow(tx), revokedByMemberId: ctx.actor.memberId },
        });
        if (written.count !== 1) fail("SHARE_LINK_CLOSED");
        await record(tx, {
          action: "credential.share_revoked",
          targetType: "CredentialShareLink",
          targetId: id,
          metadata: { credentialId: link.credentialId },
        });
      },
      opts,
    ),
  );
}
