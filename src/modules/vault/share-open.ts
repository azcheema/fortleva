import { record } from "@/audit/record";
import { secretsEqual } from "@/crypto/field-encryption";
import { withTenant, type TenantDb } from "@/db";
import { moduleOpenUnderSystem } from "@/entitlements/resolver";
import { DomainError } from "@/lib/domain-error";
import { send } from "@/mailer";
import { readPreferences } from "@/preferences/service";
import { allowStrict } from "@/ratelimit";

import { boundedVaultWrite } from "./ctx";
import { readSecret, readSecretVersion } from "./secret-store";
import {
  hashShareCode,
  newShareCode,
  normalizeShareCode,
  parseShareToken,
  SHARE_CODE_SPACING_MS,
  SHARE_CODE_TTL_MS,
  SHARE_MAX_CODE_ATTEMPTS,
  SHARE_MAX_CODES,
  shareLinkStatus,
} from "./share-token";

/**
 * SHARE LINKS, THE VISITOR'S HALF (Phase 3V slice 90; DATA_MODEL.md
 * §6.17; SECURITY.md's "Credential share links" row) — the three things
 * `/portal/share/[token]` asks, for somebody with NO session: what is this
 * link (the agency's name, or nothing), mail me a code, and here is the
 * code — show me the secret.
 *
 * THE TOKEN IS THE CREDENTIAL, so every export here takes one and nothing
 * else that names a tenant: the tenant comes out of the token
 * (`parseShareToken`) and is opened with `withTenant(tenantId,
 * {type:'system'})` — RLS live, the tenant's rows only — and NEVER
 * `withPlatform` (SECURITY.md; `src/db/import-boundary.test.ts` and this
 * slice's graph walk from the share route pin it). A token whose tenant
 * half was edited hashes to nothing in the tenant it names.
 *
 * EVERY DEAD LINK IS THE SAME ANSWER, `dead`: never existed, another
 * tenant's, expired, opened, revoked, out of code checks or codes, the
 * secret changed since, the login deleted or the field emptied, the vault
 * switched off by plan or tenant, share links switched off. Nobody
 * learns which, or whether a link was ever real (the founder's rule for
 * every bad token, 2026-09-23). A LIVE link may say more — "that code is
 * not right", "ask for a new code" — because whoever holds it already
 * knows it is live: the page offered them a code.
 *
 * THE AUTHORITY IS THE LINK'S OWN ROW, not a rate limiter: every check of
 * a code counts on `code_attempts` whatever its outcome, five end the
 * link, and the database refuses a sixth (CHECK) or a counter going back
 * (trigger). The per-address buckets in front (`vault.share_*`, spent by
 * the page) only stop a loop before it reaches here. Fails CLOSED.
 *
 * VIEW-ONCE IS THE ROW LOCK. Opening takes the link's row `FOR UPDATE`
 * before it reads anything, so two opens with the right code queue: the
 * first marks it viewed and commits, and the second — reading again once
 * it holds the lock — finds it viewed and is `dead`. The conditional
 * UPDATE (`viewed_at IS NULL`, the same code hash) is the belt.
 *
 * A REFUSAL THAT SPENT A CHECK COMMITS: a wrong code is returned out of
 * the transaction, not thrown inside it, so its count and its audit row
 * land (`reveal.ts`'s rule). Nothing here logs, and no answer carries a
 * value except the one view.
 */

const SYSTEM = { type: "system" } as const;

/** What the page may say before anything is verified: whose link it is. */
export type SharePreview = { readonly tenantName: string };

/** One view — everything the page shows once. */
export type SharedSecret = {
  readonly tenantName: string;
  /** The login's name, as the agency called it. */
  readonly name: string;
  readonly url: string | null;
  /** Only when the link was made with the username included. */
  readonly username: string | null;
  /** Which secret field this is (a `SECRET_FIELDS` key), for its label. */
  readonly field: string;
  readonly value: string;
};

export type ShareCodeOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /**
       * dead: see the header. wait: a code went out under half a minute
       * ago. no_codes: five mailed already. address_busy: this ADDRESS has
       * been sent many codes lately, across links. mail_failed: the mailer
       * threw. busy: the row's lock waits were spent.
       */
      readonly reason: "dead" | "wait" | "no_codes" | "address_busy" | "mail_failed" | "busy";
    };

export type ShareOpenOutcome =
  | { readonly ok: true; readonly secret: SharedSecret }
  | {
      readonly ok: false;
      /** malformed: not six digits (counts nothing). no_code: none sent, or it expired (counts nothing). wrong_code: counted. */
      readonly reason: "dead" | "malformed" | "no_code" | "wrong_code" | "busy";
      /** On `wrong_code`: how many checks this link has left. */
      readonly attemptsLeft?: number;
    };

/** The words of the code's mail, in the visitor's language — the page composes them. */
export type ShareCodeMail = (args: {
  readonly code: string;
  readonly tenantName: string;
  readonly minutes: number;
}) => { readonly subject: string; readonly text: string };

/** The database's clock: the one every CHECK and `now()` in the WHERE clauses use. */
async function dbNow(tx: TenantDb): Promise<Date> {
  const rows = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  const row = rows[0];
  if (!row) throw new Error("vault: the database returned no clock");
  return row.now;
}

const linkSelect = {
  id: true,
  credentialId: true,
  field: true,
  includeUsername: true,
  recipientEmail: true,
  secretVersion: true,
  expiresAt: true,
  codeHash: true,
  codeExpiresAt: true,
  codeSentAt: true,
  codesSent: true,
  codeAttempts: true,
  viewedAt: true,
  revokedAt: true,
  createdAt: true,
} as const;

/**
 * The link by its token hash — taking its row lock first when `lock` —
 * and whether it can still be opened: its own status (`shareLinkStatus`),
 * the login live with the field still set, the vault open for the tenant,
 * share links allowed — and made AFTER they were last switched off (a
 * switch-off stops a link for good; `shareLinksStoppedAt`). Anything else
 * is `null`, one answer for all.
 */
async function liveLink(tx: TenantDb, tenantId: string, tokenHash: string, lock: boolean) {
  if (lock) {
    // Waits here are bounded by the caller (`boundedVaultWrite`): an open
    // holds this row only for the moment it takes to decrypt one field.
    await tx.$queryRaw`SELECT id FROM credential_share_link WHERE tenant_id = ${tenantId} AND token_hash = ${tokenHash} FOR UPDATE`;
  }
  // Read AFTER the lock: a second open that waited must see the first's result.
  const link = await tx.credentialShareLink.findFirst({ where: { tenantId, tokenHash }, select: linkSelect });
  if (!link) return null;
  const now = await dbNow(tx);
  const prefs = await readPreferences(tx, tenantId);
  if (!prefs.vault.allowExternalShareLinks) return null;
  const version = await readSecretVersion(tx, tenantId, link.credentialId);
  if (shareLinkStatus(link, version, now, prefs.vault.shareLinksStoppedAt) !== "waiting") return null;
  // A sealed login's link opens nothing (slice 92, C60 (a)) — a belt:
  // sealing revoked every open link in its own transaction.
  const item = await tx.credentialItem.findFirst({
    where: { tenantId, id: link.credentialId, deletedAt: null, sealedAt: null },
    select: { name: true, url: true, username: true, secretFieldKeys: true },
  });
  if (!item || !item.secretFieldKeys.includes(link.field)) return null;
  if (!(await moduleOpenUnderSystem(tx, tenantId, "vault"))) return null;
  const tenant = await tx.tenant.findFirst({ where: { id: tenantId }, select: { name: true } });
  if (!tenant) return null;
  return { link, item, now, tenantName: tenant.name };
}

/**
 * What the page shows before anything is verified: the agency's name — the
 * one thing that makes "type the code we mailed you" reasonable — or null
 * for every dead link alike. Reads only; spends nothing.
 */
export async function previewShareLink(token: string): Promise<SharePreview | null> {
  const parsed = parseShareToken(token);
  if (!parsed) return null;
  return withTenant(parsed.tenantId, SYSTEM, async (tx) => {
    const live = await liveLink(tx, parsed.tenantId, parsed.tokenHash, false);
    return live ? { tenantName: live.tenantName } : null;
  });
}

/**
 * Mail a fresh code to the address the link was made for — never one the
 * visitor names; the page never shows or asks for it. The previous code
 * dies with the new one. At most `SHARE_MAX_CODES` per link, half a minute
 * apart, each audited (`credential.share_code_sent`). The code leaves the
 * transaction only to be mailed, after it commits.
 */
export async function sendShareCode(token: string, compose: ShareCodeMail): Promise<ShareCodeOutcome> {
  const parsed = parseShareToken(token);
  if (!parsed) return { ok: false, reason: "dead" };
  type Sent = { readonly ok: true; readonly to: string; readonly code: string; readonly tenantName: string };
  let sent: Sent | Exclude<ShareCodeOutcome, { ok: true }>;
  try {
    sent = await boundedVaultWrite((opts) =>
      withTenant(
        parsed.tenantId,
        SYSTEM,
        async (tx): Promise<Sent | Exclude<ShareCodeOutcome, { ok: true }>> => {
          const live = await liveLink(tx, parsed.tenantId, parsed.tokenHash, true);
          if (!live) return { ok: false, reason: "dead" };
          const { link, now } = live;
          if (link.codesSent >= SHARE_MAX_CODES) return { ok: false, reason: "no_codes" };
          if (link.codeSentAt !== null && now.getTime() - link.codeSentAt.getTime() < SHARE_CODE_SPACING_MS) {
            return { ok: false, reason: "wait" };
          }
          // ONE ADDRESS, MANY LINKS (the security review): five codes per
          // link would otherwise let a member's ten links send fifty mails
          // to one person from the agency's name. Spent last, once the link
          // will send: a refusal above costs this address nothing.
          if (!(await allowStrict("vault.share_code_to", link.recipientEmail))) {
            return { ok: false, reason: "address_busy" };
          }
          const code = newShareCode();
          await tx.credentialShareLink.update({
            where: { id: link.id, tenantId: parsed.tenantId },
            data: {
              codeHash: hashShareCode(link.id, code),
              codeExpiresAt: new Date(now.getTime() + SHARE_CODE_TTL_MS),
              codeSentAt: now,
              codesSent: { increment: 1 },
            },
            select: { id: true },
          });
          await record(tx, {
            action: "credential.share_code_sent",
            targetType: "CredentialShareLink",
            targetId: link.id,
            metadata: { credentialId: link.credentialId, sent: link.codesSent + 1 },
          });
          return { ok: true, to: link.recipientEmail, code, tenantName: live.tenantName };
        },
        opts,
      ),
    );
  } catch (e) {
    if (e instanceof DomainError && e.code === "VAULT_BUSY") return { ok: false, reason: "busy" };
    throw e;
  }
  if (!sent.ok) return sent;
  // AFTER the commit, so a code is never mailed for a row that rolled
  // back. A failed send leaves the code stored and one send spent — the
  // visitor is told to try again; the mailer's error is not theirs.
  const words = compose({ code: sent.code, tenantName: sent.tenantName, minutes: SHARE_CODE_TTL_MS / 60_000 });
  try {
    // NO `Reply-To`, deliberately (founder decision C68 (j)): this mail carries a
    // live code that opens a shared login, and a reply quoting it would put it in the agency's mailbox
    // (`MAIL_WITHOUT_REPLY_TO`'s note, src/notify/reply-address-resolve.ts).
    await send({ to: sent.to, subject: words.subject, text: words.text });
  } catch {
    return { ok: false, reason: "mail_failed" };
  }
  return { ok: true };
}

/**
 * Check a code and, if it is right, show the secret — once. Every check of
 * a live code counts; the fifth wrong one ends the link. The right one
 * marks the link viewed, decrypts its ONE field and records
 * `credential.share_viewed`, all in one transaction.
 */
export async function openShareLink(token: string, rawCode: unknown): Promise<ShareOpenOutcome> {
  const parsed = parseShareToken(token);
  if (!parsed) return { ok: false, reason: "dead" };
  // FREE, so it may be specific: a typo spends nothing.
  const code = normalizeShareCode(rawCode);
  if (code === null) return { ok: false, reason: "malformed" };

  try {
    return await boundedVaultWrite((opts) =>
      withTenant(
        parsed.tenantId,
        SYSTEM,
        async (tx): Promise<ShareOpenOutcome> => {
          const live = await liveLink(tx, parsed.tenantId, parsed.tokenHash, true);
          if (!live) return { ok: false, reason: "dead" };
          const { link, item, now } = live;
          if (link.codeHash === null || link.codeExpiresAt === null || link.codeExpiresAt.getTime() <= now.getTime()) {
            return { ok: false, reason: "no_code" };
          }
          const attempt = link.codeAttempts + 1;
          if (!secretsEqual(hashShareCode(link.id, code), link.codeHash)) {
            await tx.credentialShareLink.update({
              where: { id: link.id, tenantId: parsed.tenantId },
              data: { codeAttempts: attempt },
              select: { id: true },
            });
            await record(tx, {
              action: "credential.share_code_refused",
              targetType: "CredentialShareLink",
              targetId: link.id,
              metadata: { credentialId: link.credentialId, attempt },
            });
            const attemptsLeft = SHARE_MAX_CODE_ATTEMPTS - attempt;
            return attemptsLeft > 0 ? { ok: false, reason: "wrong_code", attemptsLeft } : { ok: false, reason: "dead" };
          }

          // The secret FIRST, before anything is marked: a secret replaced
          // since `liveLink` read its version (READ COMMITTED reads anew per
          // statement) is a dead link, and saying so writes nothing — the
          // code review's low: thrown, it was the error page.
          const secret = await readSecret(tx, parsed.tenantId, link.credentialId);
          const value = secret?.payload.fields[link.field];
          if (!secret || secret.version !== link.secretVersion || typeof value !== "string") {
            return { ok: false, reason: "dead" };
          }
          const opened = await tx.credentialShareLink.updateMany({
            where: {
              id: link.id,
              tenantId: parsed.tenantId,
              viewedAt: null,
              revokedAt: null,
              codeHash: link.codeHash,
            },
            data: { codeAttempts: attempt, viewedAt: now, codeHash: null, codeExpiresAt: null },
          });
          if (opened.count !== 1) return { ok: false, reason: "dead" };
          await record(tx, {
            action: "credential.share_viewed",
            targetType: "CredentialShareLink",
            targetId: link.id,
            metadata: { credentialId: link.credentialId, field: link.field },
          });
          return {
            ok: true,
            secret: {
              tenantName: live.tenantName,
              name: item.name,
              url: item.url,
              username: link.includeUsername ? item.username : null,
              field: link.field,
              value,
            },
          };
        },
        opts,
      ),
    );
  } catch (e) {
    if (e instanceof DomainError && e.code === "VAULT_BUSY") return { ok: false, reason: "busy" };
    throw e;
  }
}
