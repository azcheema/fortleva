import { z } from "zod";

import { record } from "@/audit/record";
import {
  effectivePermissions,
  requireRecentMfa,
  STEP_UP_WINDOW_MINUTES,
  type MemberActor,
} from "@/authz/authorize";
import { absoluteUrl, mailFrom } from "@/config";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { fail } from "@/lib/domain-error";
import { send, type SendOutcome } from "@/mailer";
import { allowStrict } from "@/ratelimit";

import { REPLY_ADDRESS_CHANGED_MAIL } from "./reply-address-mail-key";
import {
  REPLY_TO_KEY,
  REPLY_TO_PENDING_KEY,
  ownerReplyAddress,
  parseConfirmedReplyAddress as parseConfirmed,
} from "./reply-address-resolve";
import { mintReplyAddressToken, parseReplyAddressToken, sameTokenHash } from "./reply-address-token";

export { MAIL_WITHOUT_REPLY_TO, REPLY_TO_KEY, REPLY_TO_PENDING_KEY, resolveReplyAddress } from "./reply-address-resolve";

/**
 * WHERE A REPLY GOES (Phase 5 slice 100; founder decision C68 (c), (f), (i)–(k)).
 *
 * Every mail a workspace sends — to its members and to its clients' people —
 * carries a `Reply-To` of THAT agency's own address: never a shared Fortleva
 * inbox (a client of another agency must never reach the platform instead of
 * their agency), never the sending domain, which receives nothing. Until the
 * workspace sets one, replies go to its owner (the earliest-made active one).
 * EXCEPT mail that carries a client's live link or code (C68 (j)) and the
 * security notices to a workspace's own members — `reply-address-resolve.ts`
 * says which and why.
 *
 * A NEW ADDRESS IS CONFIRMED BY EMAIL BEFORE IT IS USED (C68 (f)): whoever may
 * change the workspace's settings types it — with a fresh second factor
 * (C68 (k)) — Fortleva mails a link to it, and
 * replies go there only once someone holding that mailbox opens the link and
 * presses Confirm. Until then they keep going where they went — so a typo
 * never sends a client's reply to a stranger unnoticed.
 *
 * WHERE A MAIL'S `Reply-To` COMES FROM is the lean read half,
 * `reply-address-resolve.ts` — the senders import that one.
 *
 * STORAGE is two `TenantPreference` rows (class A — no migration, no new
 * table): `mail.replyTo`, the confirmed address, and `mail.replyToPending`,
 * the one waiting, with the SHA-256 of its link's secret — never the secret,
 * which exists only in the mail (so it never goes through the outbox, whose
 * `params` are kept for 90 days). A new request replaces a waiting one, and
 * the old link dies with it.
 *
 * THE LINK IS THE ASKER'S, NOT ONLY THE MAILBOX'S: it confirms only while the
 * member who asked is still ACTIVE and still holds `settings:edit` — a member
 * suspended or stripped of the right after asking cannot finish the change.
 * And when an address IS confirmed, every OWNER is mailed (C68 (i)), a
 * security notice whatever their level: owners and admins may set it, and an
 * admin must not quietly redirect the clients' replies, which can carry
 * passwords.
 *
 * AUDIT: `reply_address.requested`, `.request_cancelled`, `.confirmed`
 * (a system row — whoever confirmed holds a mailbox, not a seat; the member
 * who asked is in its metadata) and `.removed`, each WITH the address: it is
 * the workspace's own setting, and an owner asking later where clients'
 * replies went in March needs the trail to say.
 */

/** How long a confirmation link works. */
export const REPLY_ADDRESS_LINK_DAYS = 7;

/** The confirmation's row lock waits at most this long for a concurrent request. */
const CONFIRM_LOCK_TIMEOUT_MS = 3_000;

export type ReplyAddressCtx = { readonly tenantId: string; readonly actor: MemberActor };

const pendingShape = z.object({
  email: z.string(),
  tokenHash: z.string(),
  requestedAt: z.string(),
  expiresAt: z.string(),
  requestedByMemberId: z.string(),
});
type Pending = z.infer<typeof pendingShape>;

const parsePending = (raw: unknown): Pending | null => {
  const parsed = pendingShape.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

async function readRow(tx: TenantDb, tenantId: string, key: string) {
  return tx.tenantPreference.findFirst({ where: { tenantId, key }, select: { id: true, value: true } });
}

export type ReplyAddressSettings = {
  /** The confirmed address, or null while replies go to the owner. */
  readonly confirmed: { readonly email: string; readonly confirmedAt: Date } | null;
  /** An address waiting for its link to be opened, never the hash. */
  readonly pending: { readonly email: string; readonly requestedAt: Date; readonly expiresAt: Date } | null;
  /** Where replies go while nothing is confirmed. */
  readonly ownerEmail: string | null;
};

/** `settings:view` — the settings card's read. */
export async function readReplyAddressSettings(ctx: ReplyAddressCtx): Promise<ReplyAddressSettings> {
  return withTenant(ctx.tenantId, { type: "member", id: ctx.actor.memberId }, async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "settings:view");
    const confirmed = parseConfirmed((await readRow(tx, ctx.tenantId, REPLY_TO_KEY))?.value);
    const pending = parsePending((await readRow(tx, ctx.tenantId, REPLY_TO_PENDING_KEY))?.value);
    const ownerEmail = await ownerReplyAddress(tx, ctx.tenantId);
    return {
      confirmed: confirmed ? { email: confirmed.email, confirmedAt: new Date(confirmed.confirmedAt) } : null,
      // An expired request is shown as nothing waiting: its link opens nothing.
      pending:
        pending && Date.parse(pending.expiresAt) > Date.now()
          ? { email: pending.email, requestedAt: new Date(pending.requestedAt), expiresAt: new Date(pending.expiresAt) }
          : null,
      ownerEmail,
    };
  });
}

/** The domain mail is sent FROM receives nothing, so it is never a reply address. */
const sendingDomain = (): string => mailFrom.address.slice(mailFrom.address.lastIndexOf("@") + 1).toLowerCase();

const addressSchema = z.email().max(254);

/** A normalised address, or null for anything that cannot be one. */
export function normaliseReplyAddress(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (!addressSchema.safeParse(email).success) return null;
  const domain = email.slice(email.lastIndexOf("@") + 1);
  const sending = sendingDomain();
  if (domain === sending || domain.endsWith(`.${sending}`)) return null;
  return email;
}

/**
 * `settings:edit` — ask for a new reply address. Returns the link to mail
 * (the caller sends it AFTER this commits — `requestReplyAddressAndMail`).
 */
async function requestReplyAddress(
  ctx: ReplyAddressCtx,
  rawEmail: unknown,
  now: Date,
): Promise<{ email: string; token: string; tokenHash: string; locale: string }> {
  return withTenant(ctx.tenantId, { type: "member", id: ctx.actor.memberId }, async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "settings:edit");
    // C68 (k): a FRESH second factor, the ✦ window — someone holding an
    // admin's open session must not quietly redirect the clients' replies,
    // which can carry passwords (the vault's settings' rule). A stale factor
    // is the step-up page, a missing one the enrolment notice (`runForm`).
    await requireRecentMfa(ctx.actor, STEP_UP_WINDOW_MINUTES);
    const email = normaliseReplyAddress(rawEmail);
    if (!email) return fail("REPLY_ADDRESS_INVALID", "not an address that can receive replies");
    const confirmed = parseConfirmed((await readRow(tx, ctx.tenantId, REPLY_TO_KEY))?.value);
    if (confirmed?.email === email) return fail("REPLY_ADDRESS_UNCHANGED", "already the confirmed address");
    // A member must not turn the product into a mailer at addresses of their
    // choosing: five confirmation mails a day per workspace, and three a day
    // to any one address from all workspaces together (the share code's
    // per-recipient bucket, `vault.share_code_to`) — through the limiter whose
    // in-process floor holds without Upstash. THE WORKSPACE'S FIRST: the
    // other order let one workspace, its own five spent, go on spending the
    // shared per-address budget of any address it liked, and so stop another
    // agency confirming its own (the fix-pass review). The cost of this
    // order — a refusal by the address's budget spends one of the
    // workspace's five — is the code review's low, accepted. BOTH BEFORE the
    // suppression list: that list is platform-wide, and an answer that
    // differs for a suppressed address must cost a request, or it is a free
    // probe of whether any address bounced or complained (the security
    // review's low). *Superseded in part by slice 103 (founder decision
    // C71 (d)): the "Emails to this address aren't being delivered" note on a
    // client's Contacts tab now answers the same bit for any address a member
    // records as a contact, unlimited — accepted and recorded in SECURITY.md
    // §9.2's Amazon SES row (one bit, the same for a bounce and a complaint).
    // The order here still keeps THIS door from being the cheaper one.*
    if (!(await allowStrict("mail.reply_address_request", ctx.tenantId))) {
      return fail("REPLY_ADDRESS_LIMIT", "too many confirmation mails today");
    }
    if (!(await allowStrict("mail.reply_address_to", email))) {
      return fail("REPLY_ADDRESS_LIMIT", "too many confirmation mails to this address today");
    }
    const suppressed = await tx.emailSuppression.findUnique({ where: { email }, select: { email: true } });
    if (suppressed) return fail("REPLY_ADDRESS_UNDELIVERABLE", "the address is on the suppression list");

    const { token, tokenHash } = mintReplyAddressToken(ctx.tenantId);
    const value: Pending = {
      email,
      tokenHash,
      requestedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + REPLY_ADDRESS_LINK_DAYS * 86_400_000).toISOString(),
      requestedByMemberId: ctx.actor.memberId,
    };
    const existing = await readRow(tx, ctx.tenantId, REPLY_TO_PENDING_KEY);
    // An upsert, so two first requests at once cannot both INSERT and turn the
    // unique (tenant, key) into an error page; the later one replaces the
    // earlier, whose link then opens nothing.
    await tx.tenantPreference.upsert({
      where: { tenantId_key: { tenantId: ctx.tenantId, key: REPLY_TO_PENDING_KEY } },
      create: { tenantId: ctx.tenantId, key: REPLY_TO_PENDING_KEY, value, updatedByMemberId: ctx.actor.memberId },
      update: { value, updatedByMemberId: ctx.actor.memberId },
    });
    await record(tx, {
      action: "reply_address.requested",
      targetType: "Tenant",
      targetId: ctx.tenantId,
      metadata: { email, replacedPending: existing !== null },
    });
    const tenant = await tx.tenant.findFirst({ where: { id: ctx.tenantId }, select: { defaultLocale: true } });
    return { email, token, tokenHash, locale: tenant?.defaultLocale ?? "sv" };
  });
}

/**
 * `settings:edit` — ask for a new reply address and mail its link. The mail
 * goes AFTER the request commits and straight to the transport, never the
 * outbox: the link's secret must exist nowhere but the mail. If it cannot be
 * sent, the waiting row is removed again (nobody could open a link nobody
 * got) and the member is told; they can simply ask again.
 */
export async function requestReplyAddressAndMail(
  ctx: ReplyAddressCtx,
  rawEmail: unknown,
): Promise<{ readonly email: string; readonly expiresAt: Date }> {
  const now = new Date();
  const made = await requestReplyAddress(ctx, rawEmail, now);
  const link = absoluteUrl(`/reply-address/${made.token}`);
  // A send that throws, AND one `send()` answers "suppressed" (slice 103 — the
  // address was blocked between the check above and now; the design review's
  // low): either way nothing went, so the request is cancelled as unmailed.
  let outcome: SendOutcome | "failed";
  try {
    outcome = await send({ to: made.email, ...replyAddressMail(made.locale, link) });
  } catch {
    outcome = "failed";
  }
  if (outcome !== "sent") {
    await withTenant(ctx.tenantId, { type: "member", id: ctx.actor.memberId }, async (tx) => {
      // Only the row THIS request wrote: a colleague's newer one stays. And
      // the trail says so, or it would show a request that never existed
      // waiting forever (both reviews' low).
      const row = await readRow(tx, ctx.tenantId, REPLY_TO_PENDING_KEY);
      const pending = parsePending(row?.value);
      if (row && pending && sameTokenHash(pending.tokenHash, made.tokenHash)) {
        await tx.tenantPreference.delete({ where: { id: row.id } });
        await record(tx, {
          action: "reply_address.request_cancelled",
          targetType: "Tenant",
          targetId: ctx.tenantId,
          metadata: { email: made.email, reason: outcome === "suppressed" ? "mail_suppressed" : "mail_failed" },
        });
      }
    }).catch(() => undefined);
    return outcome === "suppressed"
      ? fail("REPLY_ADDRESS_UNDELIVERABLE", "the address is on the suppression list")
      : fail("REPLY_ADDRESS_MAIL_FAILED", "the confirmation mail could not be sent");
  }
  return { email: made.email, expiresAt: new Date(now.getTime() + REPLY_ADDRESS_LINK_DAYS * 86_400_000) };
}

/**
 * The confirmation mail, in the workspace's language. It names NOTHING a
 * member typed — not the workspace, not the person — for `account-security.ts`'s
 * reason: a mail from our domain must not carry a sentence of a tenant's
 * choosing to an address the tenant chose. The page the link opens names the
 * workspace, once the link has proved the reader holds this mailbox.
 */
export function replyAddressMail(locale: string, link: string): { subject: string; text: string } {
  if (locale === "sv") {
    return {
      subject: "Bekräfta adressen för svar på e-post från Fortleva",
      text:
        `Hej,\n\n` +
        `Någon i en arbetsyta i Fortleva har bett att svar på arbetsytans e-post ska komma till den här adressen.\n\n` +
        `Öppna länken för att se vilken arbetsyta det gäller och bekräfta: ${link}\n\n` +
        `Länken fungerar i ${REPLY_ADDRESS_LINK_DAYS} dagar. Om du inte känner igen det här kan du strunta i det här mejlet – ingenting ändras.`,
    };
  }
  return {
    subject: "Confirm the address for replies to Fortleva emails",
    text:
      `Hello,\n\n` +
      `Someone in a Fortleva workspace asked for replies to that workspace's emails to come to this address.\n\n` +
      `Open this link to see which workspace and to confirm: ${link}\n\n` +
      `The link works for ${REPLY_ADDRESS_LINK_DAYS} days. If you don't recognise this, ignore this email — nothing changes.`,
  };
}

/** `settings:edit` — forget the address waiting for confirmation (its link dies). */
export async function cancelReplyAddressRequest(ctx: ReplyAddressCtx): Promise<void> {
  await withTenant(ctx.tenantId, { type: "member", id: ctx.actor.memberId }, async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "settings:edit");
    const row = await readRow(tx, ctx.tenantId, REPLY_TO_PENDING_KEY);
    if (!row) return;
    await tx.tenantPreference.delete({ where: { id: row.id } });
    await record(tx, {
      action: "reply_address.request_cancelled",
      targetType: "Tenant",
      targetId: ctx.tenantId,
      metadata: { email: parsePending(row.value)?.email ?? null },
    });
  });
}

/** `settings:edit` — stop using the confirmed address; replies go to the owner again. */
export async function removeReplyAddress(ctx: ReplyAddressCtx): Promise<void> {
  await withTenant(ctx.tenantId, { type: "member", id: ctx.actor.memberId }, async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "settings:edit");
    const row = await readRow(tx, ctx.tenantId, REPLY_TO_KEY);
    if (!row) return;
    await tx.tenantPreference.delete({ where: { id: row.id } });
    await record(tx, {
      action: "reply_address.removed",
      targetType: "Tenant",
      targetId: ctx.tenantId,
      metadata: { email: parseConfirmed(row.value)?.email ?? null },
    });
  });
}

/**
 * THE PUBLIC PAGE'S READ — `/reply-address/<token>`. Changes NOTHING: a
 * business inbox's scanner opens every link it is sent, so the page only
 * shows what pressing Confirm would do. Null for anything that cannot be
 * confirmed — malformed, unknown, replaced, expired — all one answer.
 */
export async function readReplyAddressLink(
  token: unknown,
  now: Date = new Date(),
): Promise<{ readonly email: string; readonly workspaceName: string } | null> {
  const parsed = parseReplyAddressToken(token);
  if (!parsed) return null;
  return withTenant(parsed.tenantId, { type: "system" }, async (tx) => {
    const pending = parsePending((await readRow(tx, parsed.tenantId, REPLY_TO_PENDING_KEY))?.value);
    if (!pending || !sameTokenHash(pending.tokenHash, parsed.tokenHash)) return null;
    if (Date.parse(pending.expiresAt) <= now.getTime()) return null;
    if (!(await askerMayStillChange(tx, pending.requestedByMemberId))) return null;
    const tenant = await tx.tenant.findFirst({ where: { id: parsed.tenantId }, select: { name: true } });
    return tenant ? { email: pending.email, workspaceName: tenant.name } : null;
  });
}

/**
 * THE PUBLIC PAGE'S ACTION — Confirm. The caller has already spent the
 * per-network budget. Under the tenant's SYSTEM principal (whoever presses
 * it holds a mailbox, not a seat): the waiting row locked, the link checked
 * again, the address made the confirmed one, the waiting row gone — one
 * transaction, so a second press finds nothing to confirm.
 */
export async function confirmReplyAddress(
  token: unknown,
  now: Date = new Date(),
): Promise<"confirmed" | "dead"> {
  const parsed = parseReplyAddressToken(token);
  if (!parsed) return "dead";
  return withTenant(
    parsed.tenantId,
    { type: "system" },
    async (tx) => {
      // Lock the waiting row against a concurrent new request or a second
      // press — BOUNDED: a lock wait ignores the transaction's budget, and
      // only `lockTimeoutMs` ends it.
      await tx.$queryRaw`SELECT id FROM tenant_preference WHERE tenant_id = ${parsed.tenantId} AND key = ${REPLY_TO_PENDING_KEY} FOR UPDATE`;
      const row = await readRow(tx, parsed.tenantId, REPLY_TO_PENDING_KEY);
      const pending = parsePending(row?.value);
      if (!row || !pending || !sameTokenHash(pending.tokenHash, parsed.tokenHash)) return "dead";
      if (Date.parse(pending.expiresAt) <= now.getTime()) return "dead";
      if (!(await askerMayStillChange(tx, pending.requestedByMemberId))) return "dead";

      const value = {
        email: pending.email,
        confirmedAt: now.toISOString(),
        requestedByMemberId: pending.requestedByMemberId,
      };
      await tx.tenantPreference.upsert({
        where: { tenantId_key: { tenantId: parsed.tenantId, key: REPLY_TO_KEY } },
        create: { tenantId: parsed.tenantId, key: REPLY_TO_KEY, value, updatedByMemberId: pending.requestedByMemberId },
        update: { value, updatedByMemberId: pending.requestedByMemberId },
      });
      await tx.tenantPreference.delete({ where: { id: row.id } });
      await record(tx, {
        action: "reply_address.confirmed",
        targetType: "Tenant",
        targetId: parsed.tenantId,
        metadata: { email: pending.email, requestedByMemberId: pending.requestedByMemberId },
      });
      await noticeToOwners(tx, parsed.tenantId, now);
      return "confirmed";
    },
    { lockTimeoutMs: CONFIRM_LOCK_TIMEOUT_MS },
  );
}

/**
 * The member who asked may still make this change: ACTIVE, and still holding
 * `settings:edit` through a role (`effectivePermissions` reads ACTIVE members
 * only; the code is core, so no module or flag gates it).
 */
async function askerMayStillChange(tx: TenantDb, memberId: string): Promise<boolean> {
  return (await effectivePermissions(tx, memberId)).has("settings:edit");
}

/**
 * C68 (i): every ACTIVE owner is mailed that the reply address changed — a
 * security notice, whatever their email level (the export notice's rule), in
 * the same transaction as the change. The mail names nothing; it carries no
 * `Reply-To` (`MAIL_WITHOUT_REPLY_TO`).
 */
async function noticeToOwners(tx: TenantDb, tenantId: string, now: Date): Promise<void> {
  const owners = await tx.member.findMany({
    where: {
      tenantId,
      status: "ACTIVE",
      memberRoles: { some: { role: { isSystem: true, templateKey: "owner" } } },
    },
    select: { id: true, user: { select: { email: true, locale: true } } },
    orderBy: { id: "asc" },
  });
  const receivers = owners.flatMap((o) =>
    o.user.email ? [{ id: o.id, email: o.user.email.toLowerCase(), locale: o.user.locale === "sv" ? "sv" : "en" }] : [],
  );
  if (receivers.length === 0) return;
  const suppressed = new Set(
    (
      await tx.emailSuppression.findMany({
        where: { email: { in: receivers.map((r) => r.email) } },
        select: { email: true },
      })
    ).map((s) => s.email),
  );
  const data = receivers
    .filter((r) => !suppressed.has(r.email))
    .map((r) => ({
      tenantId,
      idempotencyKey: `reply_address_changed:${now.toISOString()}:MEMBER:${r.id}`,
      receiverType: "MEMBER" as const,
      receiverId: r.id,
      toEmail: r.email,
      kind: REPLY_ADDRESS_CHANGED_MAIL,
      locale: r.locale,
      notificationIds: [],
    }));
  if (data.length > 0) await tx.emailOutbox.createMany({ data, skipDuplicates: true });
}
