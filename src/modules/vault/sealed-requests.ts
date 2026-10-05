import { record } from "@/audit/record";
import { requireRecentMfa, resolvePermissions, resolveScope, type ScopeResolution } from "@/authz/authorize";
import { AuthzError, deny } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { moduleOpenForMember, requireAccess } from "@/entitlements/resolver";
import { askWaitState, isAnswerable, isLive, scheduledByApproval, type AskWaitState } from "@/lib/ask-and-wait";
import { fail } from "@/lib/domain-error";
import { SEALED_MEMBER_MAIL } from "@/notify/sealed-mail-keys";

import { boundedVaultWrite, idOf, principalOf, type VaultCtx } from "./ctx";
import { lockAsk, lockClientAsks, sealedClock, sealedGuarded } from "./sealed-door";
import { answerersOf, clientPeopleOf, enqueueSealedMail } from "./sealed-mail";
import { SEALED_APPROVE_STEP_UP_MINUTES, SEALED_REASON_MAX, SEALED_RULES, SEALED_UNSCHEDULED_HORIZON_DAYS } from "./sealed-rules";
import { anchorInScope } from "./scope";

/**
 * A CLIENT'S ASK TO OPEN THEIR SEALED LOGINS — THE AGENCY'S SIDE (Phase 3V
 * slice 93; founder decisions C52 (f)–(h), C61). The client asks through
 * the portal (`sealed-portal-writes.ts`); everyone who may answer is mailed
 * (`sealed-mail.ts`, `sealed-reminders.ts`) a link to `/vault/requests/<id>`,
 * which reads the ask here and answers it here.
 *
 * WHO MAY READ AND ANSWER (C61 (f): it follows the roles): a member who
 * holds `credential:unseal` — owners by default — with the vault module
 * open and the client in their scope; never under impersonation. NOT
 * behind the vault's door: the page names no login (C54's rule — names stay
 * behind the door) and holds no secret, only who asked, why, and how many
 * logins are sealed for that client.
 *
 * APPROVING opens the client's sealed logins AT ONCE, for 7 days — it hands
 * secrets to the client, so it is `requireAccess(credential:unseal)` (all
 * four gates, the ✦ window) AND a factor no older than a minute: the
 * authenticator code typed into the dialog (CP4's "always step up",
 * C61 (b)).
 *
 * DENYING asks NO code (C61 (b), the founder's word): `credential:unseal`
 * read at gate 4 with the second factor SET ASIDE, the vault module open
 * (`moduleOpenForMember`), the scope — never `requireAccess`, whose ✦
 * window would send a member arriving from the mail to the step-up page
 * first. A denial only keeps the logins shut (the safe direction, as
 * hiding a login or revoking a link is), and the database still holds the
 * answerer to an active holder of the code, as themselves (the guard). It
 * may carry a reason the client is shown; the client may ask again after
 * 30 days (C52 (f)).
 *
 * Either answer is possible until the moment it opens (C61 (c)): through
 * the wait, after it while the client could confirm, and in the 48 hours
 * after a confirmation. Both are idempotent (the answer already given
 * writes nothing) and refuse anything settled otherwise
 * (`SEALED_REQUEST_SETTLED`). Both lock the ask's row first, inside
 * `boundedVaultWrite`, and decide on the database's clock — the clock the
 * guard trigger judges them by.
 *
 * Reads in SEQUENCE on each transaction (AGENTS.md's `Promise.all` trap);
 * nothing here logs.
 */

const UNSEAL = "credential:unseal";

/** Where an ask stands for the agency: everything the request page draws. */
export type SealedAskView = {
  readonly id: string;
  readonly client: { readonly id: string; readonly name: string };
  /** Null when the contact who asked has since been deleted. */
  readonly askedBy: { readonly name: string; readonly email: string } | null;
  readonly reason: string;
  readonly askedAt: Date;
  readonly waitDays: number;
  readonly state: AskWaitState;
  /** How many live logins are sealed for the client — a count, never which (C52 (a), C54). */
  readonly sealedCount: number;
  readonly confirmedBy: string | null;
  readonly answer:
    | null
    | {
        readonly kind: "approved" | "denied";
        /** The answerer's name; null when they have since left. */
        readonly by: string | null;
        readonly at: Date;
        /** A denial's reason as the client is shown it. */
        readonly reason: string | null;
      };
  readonly withdrawnBy: string | null;
  readonly can: { readonly approve: boolean; readonly deny: boolean };
};

/** One live ask, for the vault's banner. */
export type SealedAskSummary = {
  readonly id: string;
  readonly client: { readonly id: string; readonly name: string };
  readonly state: AskWaitState;
};

/**
 * The read-and-deny gate (the file's comment): no impersonation;
 * `credential:unseal` held, the factor set aside; the vault module open.
 * Answers the member's scope for the caller to hold the client to.
 */
async function answererGate(tx: TenantDb, ctx: VaultCtx): Promise<ScopeResolution> {
  if (ctx.actor.impersonated) deny("FORBIDDEN", "impersonation never answers a sealed ask");
  const answer = await resolvePermissions(tx, ctx.actor, [UNSEAL]);
  if (!answer.allowed.has(UNSEAL) && !answer.afterStepUp.has(UNSEAL)) deny("FORBIDDEN");
  if (!(await moduleOpenForMember(tx, ctx.tenantId, "vault"))) deny("FORBIDDEN", "the vault is closed");
  return resolveScope(tx, ctx.actor);
}

const STAMPS = {
  id: true,
  clientId: true,
  askedByContactId: true,
  reason: true,
  waitDays: true,
  askedAt: true,
  confirmedAt: true,
  confirmedByContactId: true,
  approvedAt: true,
  approvedByMemberId: true,
  deniedAt: true,
  deniedByMemberId: true,
  denyReason: true,
  withdrawnAt: true,
  withdrawnByContactId: true,
  opensAt: true,
  openUntil: true,
} as const;

async function readAsk(tx: TenantDb, tenantId: string, id: string) {
  return tx.sealedOpenRequest.findFirst({ where: { tenantId, id }, select: STAMPS });
}

const memberName = async (tx: TenantDb, tenantId: string, id: string | null): Promise<string | null> => {
  if (id === null) return null;
  const m = await tx.member.findFirst({ where: { tenantId, id }, select: { user: { select: { name: true } } } });
  return m?.user.name ?? null;
};

const contactOf = async (tx: TenantDb, tenantId: string, id: string | null) => {
  if (id === null) return null;
  return tx.contact.findFirst({ where: { tenantId, id }, select: { name: true, email: true } });
};

/** One ask, as the request page draws it — NOT_FOUND for anyone who may not answer it. */
export async function getSealedAsk(ctx: VaultCtx, requestId: string): Promise<SealedAskView> {
  const id = idOf(requestId, "requestId");
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    const scope = await answererGate(tx, ctx);
    const row = await readAsk(tx, ctx.tenantId, id);
    if (!row || !anchorInScope(scope, { clientId: row.clientId, projectId: null })) return deny("NOT_FOUND");
    const client = await tx.client.findFirst({ where: { tenantId: ctx.tenantId, id: row.clientId }, select: { id: true, name: true } });
    if (!client) return deny("NOT_FOUND");
    const now = await sealedClock(tx);
    const state = askWaitState(row, SEALED_RULES, now);
    const asker = await contactOf(tx, ctx.tenantId, row.askedByContactId);
    const confirmer = await contactOf(tx, ctx.tenantId, row.confirmedByContactId);
    const withdrawer = await contactOf(tx, ctx.tenantId, row.withdrawnByContactId);
    const sealedCount = await tx.credentialItem.count({
      where: { tenantId: ctx.tenantId, clientId: row.clientId, sealedAt: { not: null }, deletedAt: null, archivedAt: null },
    });
    const answer = row.approvedAt
      ? { kind: "approved" as const, by: await memberName(tx, ctx.tenantId, row.approvedByMemberId), at: row.approvedAt, reason: null }
      : row.deniedAt
        ? { kind: "denied" as const, by: await memberName(tx, ctx.tenantId, row.deniedByMemberId), at: row.deniedAt, reason: row.denyReason }
        : null;
    const open = isAnswerable(state.kind);
    return {
      id: row.id,
      client,
      askedBy: asker ? { name: asker.name, email: asker.email } : null,
      reason: row.reason,
      askedAt: row.askedAt,
      waitDays: row.waitDays,
      state,
      sealedCount,
      confirmedBy: confirmer?.name ?? null,
      answer,
      withdrawnBy: withdrawer?.name ?? null,
      can: { approve: open, deny: open },
    };
  });
}

/**
 * The asks still in play for the clients this member may answer for —
 * newest first — for the banner over `/vault`. Quiet: a member who may not
 * answer (or is impersonated, or the vault is closed) gets an empty list,
 * never an error.
 */
export async function listLiveSealedAsks(ctx: VaultCtx): Promise<readonly SealedAskSummary[]> {
  try {
    return await withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
      const scope = await answererGate(tx, ctx);
      const now = await sealedClock(tx);
      // LIVE in the query, not after it (both reviews' low): open or still to
      // open, or unscheduled and not LONG lapsed (the horizon) — so closed and
      // long-lapsed asks never push a live one out of the page; one lapsed
      // within the horizon still counts toward the page, and the machine
      // decides exactly below.
      const rows = await tx.sealedOpenRequest.findMany({
        where: {
          tenantId: ctx.tenantId,
          deniedAt: null,
          withdrawnAt: null,
          OR: [
            { openUntil: { gt: now } },
            { opensAt: null, askedAt: { gt: new Date(now.getTime() - SEALED_UNSCHEDULED_HORIZON_DAYS * 86_400_000) } },
          ],
          ...(scope.all ? {} : { clientId: { in: [...scope.directClientIds] } }),
        },
        orderBy: [{ askedAt: "desc" }, { id: "desc" }],
        take: 50,
        select: { ...STAMPS, client: { select: { id: true, name: true } } },
      });
      return rows
        .map((r) => ({ id: r.id, client: r.client, state: askWaitState(r, SEALED_RULES, now) }))
        .filter((r) => isLive(r.state.kind));
    });
  } catch (e) {
    if (e instanceof AuthzError) return [];
    throw e;
  }
}

/**
 * credential:unseal ✦ + a factor this minute — APPROVE: the client's sealed
 * logins open at once, for 7 days. The client's main contacts are told,
 * and every answerer is told it opened and reminded to change those
 * passwords once it has locked again (C52 (h)).
 */
export async function approveSealedAsk(ctx: VaultCtx, requestId: string): Promise<void> {
  const id = idOf(requestId, "requestId");
  await boundedVaultWrite((opts) =>
    sealedGuarded(() =>
    withTenant(
      ctx.tenantId,
      principalOf(ctx),
      async (tx) => {
        if (ctx.actor.impersonated) deny("FORBIDDEN", "impersonation never answers a sealed ask");
        await requireAccess(tx, ctx.tenantId, ctx.actor, UNSEAL);
        await requireRecentMfa(ctx.actor, SEALED_APPROVE_STEP_UP_MINUTES);
        const head = await tx.sealedOpenRequest.findFirst({ where: { tenantId: ctx.tenantId, id }, select: { clientId: true } });
        if (!head) return deny("NOT_FOUND");
        const scope = await resolveScope(tx, ctx.actor);
        if (!anchorInScope(scope, { clientId: head.clientId, projectId: null })) return deny("NOT_FOUND");
        // The client's ask lock, then the row LOCKED, then read: the state
        // decided on is the state written over, and no ask of the same client
        // is being made meanwhile (the guard's lock order).
        await lockClientAsks(tx, ctx.tenantId, head.clientId);
        if (!(await lockAsk(tx, ctx.tenantId, id))) return deny("NOT_FOUND");
        const row = await readAsk(tx, ctx.tenantId, id);
        if (!row) return deny("NOT_FOUND");
        if (row.approvedAt !== null) return; // already approved — nothing to do, nothing to record
        const now = await sealedClock(tx);
        if (!isAnswerable(askWaitState(row, SEALED_RULES, now).kind)) fail("SEALED_REQUEST_SETTLED");
        const { opensAt, openUntil } = scheduledByApproval(now, SEALED_RULES);
        await tx.sealedOpenRequest.update({
          where: { id, tenantId: ctx.tenantId },
          // The agency is told it opened by this approval itself (the guard holds the two stamps equal).
          data: { approvedAt: now, approvedByMemberId: ctx.actor.memberId, opensAt, openUntil, openedNoticeAt: now },
          select: { id: true },
        });
        await record(tx, {
          action: "credential.open_request_approved",
          targetType: "SealedOpenRequest",
          targetId: id,
          metadata: { clientId: row.clientId, afterConfirmation: row.confirmedAt !== null },
        });
        await enqueueSealedMail(tx, ctx.tenantId, id, "opened", await answerersOf(tx, ctx.tenantId, row.clientId), SEALED_MEMBER_MAIL.opened);
        await enqueueSealedMail(tx, ctx.tenantId, id, "approved", await clientPeopleOf(tx, ctx.tenantId, row.clientId));
      },
      opts,
    )),
  );
}

/**
 * credential:unseal, the factor set aside (C61 (b)) — DENY, with a reason
 * the client is shown, or none. The client's main contacts are told; they
 * may ask again after 30 days.
 */
export async function denySealedAsk(ctx: VaultCtx, requestId: string, reason: unknown): Promise<void> {
  const id = idOf(requestId, "requestId");
  const text = typeof reason === "string" ? reason.trim() : "";
  if (text.length > SEALED_REASON_MAX) fail("INVALID_INPUT");
  const denyReason = text.length === 0 ? null : text;
  await boundedVaultWrite((opts) =>
    sealedGuarded(() =>
    withTenant(
      ctx.tenantId,
      principalOf(ctx),
      async (tx) => {
        const scope = await answererGate(tx, ctx);
        const head = await tx.sealedOpenRequest.findFirst({ where: { tenantId: ctx.tenantId, id }, select: { clientId: true } });
        if (!head || !anchorInScope(scope, { clientId: head.clientId, projectId: null })) return deny("NOT_FOUND");
        await lockClientAsks(tx, ctx.tenantId, head.clientId);
        if (!(await lockAsk(tx, ctx.tenantId, id))) return deny("NOT_FOUND");
        const row = await readAsk(tx, ctx.tenantId, id);
        if (!row) return deny("NOT_FOUND");
        if (row.deniedAt !== null) return; // already denied — nothing to do, nothing to record
        const now = await sealedClock(tx);
        if (!isAnswerable(askWaitState(row, SEALED_RULES, now).kind)) fail("SEALED_REQUEST_SETTLED");
        await tx.sealedOpenRequest.update({
          where: { id, tenantId: ctx.tenantId },
          // A denial clears the scheduled opening (the CHECK `sealed_open_request_scheduled_iff`).
          data: { deniedAt: now, deniedByMemberId: ctx.actor.memberId, denyReason, opensAt: null, openUntil: null },
          select: { id: true },
        });
        await record(tx, {
          action: "credential.open_request_denied",
          targetType: "SealedOpenRequest",
          targetId: id,
          // Whether a reason was given — never its words, which the row keeps.
          metadata: { clientId: row.clientId, afterConfirmation: row.confirmedAt !== null, withReason: denyReason !== null },
        });
        await enqueueSealedMail(tx, ctx.tenantId, id, "denied", await clientPeopleOf(tx, ctx.tenantId, row.clientId));
      },
      opts,
    )),
  );
}
