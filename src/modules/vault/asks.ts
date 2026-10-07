import { record } from "@/audit/record";
import { resolveScope } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { hasAccess, moduleOpenForMember } from "@/entitlements/resolver";
import { dbErrorMapper } from "@/lib/db-error-map";
import { fail } from "@/lib/domain-error";
import { LOGIN_ASK_MAIL } from "@/notify/login-ask-mail-key";
import { portalPrincipalVerdict } from "@/portal";
import { readPreferences } from "@/preferences/service";

import { boundedVaultWrite, guarded, idOf, principalOf, type VaultCtx } from "./ctx";
import { enterVault } from "./door";
import { isCredentialType, NAME_MAX, trimmedOrNull, type CredentialType } from "./fields";
import { resolveNewAnchor } from "./items";
import { anchorInScope, anchorScopeWhere, assertAnchorInScope, type VaultAnchor } from "./scope";

/**
 * THE AGENCY ASKS A CLIENT FOR A NAMED LOGIN — THE TEAM'S SIDE (Phase 3V
 * slice 98; founder decision C66, C64 (a)'s later slice).
 *
 * A member who may add a login there (C66 (d): `credential:create` and the
 * vault's anchor reach — through `enterVault`, the door every vault verb
 * enters by) asks ONE contact of the client (C66 (a): a main contact or a
 * helper, anyone whose profile may hand a login over) for something they
 * need — a name ("Hosting control panel"), the kind they expect, an
 * optional note. WHAT THE MEMBER WRITES IS SHOWN TO THAT CONTACT; the form
 * says so. The contact gets one mail (C66 (b)) — at most one per
 * `ASK_MAIL_EVERY_HOURS`, so a dozen asks in a sitting are one — naming
 * nothing, and sees the ask under "Waiting on you" in their portal; they
 * send it or say they do not have it (`submission-portal-writes.ts`, the
 * portal's broker). A member
 * may cancel an open ask. The login, once sent, lands exactly where the
 * ask was placed — the anchor rule a member's own new login follows
 * (`resolveNewAnchor`), so nobody can ask for a login to land where they
 * could not put one themselves.
 *
 * WHERE AN ASK MAY BE PLACED is where a client can answer it: a client, or
 * one of its projects whose portal is on and which is not archived — the
 * slice-96 broker's own rule for where a contact may send (`projectOpen`).
 * Never the agency's own (C49): nobody at a client hands over our logins.
 * And only while the workspace takes logins from clients
 * (`vault.allowContactSubmission`) and the portal module is open — asking
 * a client who cannot answer is refused, and says why (`LOGIN_ASKS_OFF`).
 *
 * THE DATABASE HOLDS WHO WRITES WHAT for any writer (migration
 * 20261007180000, `credential_ask_guard`): a member asks and cancels as
 * themselves and must hold `credential:create`; the asked contact is an
 * active, invited contact of that client, held `FOR SHARE`; what was asked
 * never changes; it ends once. The services here add the door, the module
 * gates, the scope, the switch and the per-person bound.
 *
 * Every verb is `requireAccess` (inside `enterVault`) → scope → mutate →
 * `record()` in one transaction (AGENTS.md). Audit metadata never carries
 * what the member wrote: an audit row outlives the ask and is read by
 * operators.
 */

/** At most this many OPEN asks to one person… */
export const ASKS_OPEN_PER_CONTACT = 20;
/**
 * …and this many MADE to one person in a rolling day, cancelled ones
 * included: each ask is a mail in the agency's name, and the open bound
 * alone let ask → cancel → ask mail a client without end (the design
 * review's low).
 */
export const ASKS_PER_CONTACT_PER_DAY = 30;
/** At most one ask mail to one person in this many hours; later asks wait in their portal. */
export const ASK_MAIL_EVERY_HOURS = 12;
/** The team's note on an ask, shown to the contact. */
export const ASK_NOTE_MAX = 1000;
/** Answered and cancelled asks stay listed for this long. */
export const ASK_HISTORY_DAYS = 30;
/** How many ANSWERED or cancelled asks one list draws at most; open ones are never cut. */
export const ASK_LIST_LIMIT = 100;

/** What the team's list reads of an ask — shared by both of its reads. */
const ASK_SELECT = {
  id: true,
  clientId: true,
  projectId: true,
  contactId: true,
  type: true,
  name: true,
  note: true,
  requestedByMemberId: true,
  createdAt: true,
  sentAt: true,
  sentCredentialId: true,
  declinedAt: true,
  declineNote: true,
  cancelledAt: true,
  cancelledByMemberId: true,
  project: { select: { key: true, portalEnabled: true, archivedAt: true, status: true } },
  client: { select: { status: true } },
} as const;

const DAY_MS = 24 * 60 * 60_000;

/**
 * The guard's two refusals a lost race can meet, as typed refusals (the
 * design review's nit): the contact's access ended between the check above
 * and the insert, or the client answered between a cancel's read and its
 * write. Anything else the guard raises is a bug, and stays one.
 */
const { guarded: askGuarded } = dbErrorMapper([
  ["CREDENTIAL_ASK_CONTACT", "LOGIN_ASK_CONTACT"],
  ["CREDENTIAL_ASK_ENDED", "LOGIN_ASK_ENDED"],
]);

export type AskForLoginInput = {
  readonly clientId?: unknown;
  readonly projectId?: unknown;
  readonly contactId: unknown;
  readonly type: unknown;
  readonly name: unknown;
  readonly note?: unknown;
};

/** One person a member may ask — a contact of the client with portal access who may send a login. */
export type AskTarget = {
  readonly id: string;
  readonly name: string;
  /** Null for a member without `client:view`. */
  readonly email: string | null;
  /** A main contact (`CONTACT_PRIMARY`) — preselected first. */
  readonly primary: boolean;
};

/** Where an ask may be placed: the client itself (no project), or one of its projects. */
export type AskPlace = { readonly projectId: null } | { readonly projectId: string; readonly label: string };

export type AskTargets = {
  /** This member may ask here (`credential:create` on all four gates, a live client, somewhere to place it). */
  readonly canAsk: boolean;
  /** This member may cancel the asks listed here (`credential:create`) — even where nothing can be asked now. */
  readonly canCancel: boolean;
  /** Whether a client could answer an ask now: the switch on and the portal module open. */
  readonly open: boolean;
  readonly contacts: readonly AskTarget[];
  readonly places: readonly AskPlace[];
};

export type LoginAskState =
  | { readonly kind: "open" }
  /** `credentialId` while the login it became is live (listed on the page), else null. */
  | { readonly kind: "sent"; readonly at: Date; readonly credentialId: string | null }
  | { readonly kind: "declined"; readonly at: Date; readonly note: string | null }
  | { readonly kind: "cancelled"; readonly at: Date; readonly by: string | null };

export type LoginAskView = {
  readonly id: string;
  readonly clientId: string;
  readonly projectId: string | null;
  readonly projectKey: string | null;
  readonly type: CredentialType;
  readonly name: string;
  readonly note: string | null;
  /** The person asked. */
  readonly contact: { readonly name: string | null };
  /**
   * An OPEN ask the client cannot answer now — the person's portal access
   * has ended or paused, the workspace stopped taking logins, the portal
   * module is closed, the client is archived, or the project's portal is
   * off or the project archived — exactly when the contact's portal would
   * not show it (the design review's nit). False for an ended ask.
   */
  readonly stuck: boolean;
  readonly askedBy: string | null;
  readonly askedAt: Date;
  readonly state: LoginAskState;
};

/**
 * Can this contact receive an ask now? An ACTIVE, invited contact of THIS
 * client whose profile holds `portal.credential.submit` — the portal's own
 * rule (`portalPrincipalVerdict`), never a copy. Both profiles hold it
 * today (AUTHZ.md §8), so a helper may be asked as a main contact may.
 */
function contactCanAnswer(row: {
  clientId: string;
  portalProfile: string;
  portalStatus: string;
  invitedAt: Date | null;
}, clientId: string): boolean {
  if (row.clientId !== clientId) return false;
  return portalPrincipalVerdict({
    capability: "portal.credential.submit",
    profile: row.portalProfile,
    portalStatus: row.portalStatus,
    invitedAt: row.invitedAt,
  }).ok;
}

/** The workspace takes logins from clients, and the portal is open — so a client could answer. */
async function asksOpen(tx: TenantDb, tenantId: string): Promise<boolean> {
  const prefs = await readPreferences(tx, tenantId);
  if (!prefs.vault.allowContactSubmission) return false;
  return moduleOpenForMember(tx, tenantId, "portal");
}

/**
 * Where an ask may be placed: the member's own new-login anchor
 * (`resolveNewAnchor` — scope first, then archived), with a client, and a
 * project only while its portal is on (the client could not send for it
 * otherwise).
 */
async function askAnchor(tx: TenantDb, ctx: VaultCtx, input: AskForLoginInput) {
  const anchor = await resolveNewAnchor(tx, ctx, { clientId: input.clientId, projectId: input.projectId });
  if (anchor.clientId === null) fail("INVALID_INPUT", "an ask needs a client");
  // An archived CLIENT takes no ask, on a project of its either: archiving
  // a client leaves its projects live, and `resolveNewAnchor` reads only
  // the project's own status — the client could never answer, but the mail
  // would still go (the code review's low).
  const client = await tx.client.findFirst({
    where: { tenantId: ctx.tenantId, id: anchor.clientId as string },
    select: { status: true },
  });
  if (!client || client.status === "ARCHIVED") fail("ARCHIVED");
  if (anchor.projectId !== null) {
    const project = await tx.project.findFirst({
      where: { tenantId: ctx.tenantId, id: anchor.projectId },
      select: { portalEnabled: true, archivedAt: true },
    });
    if (!project?.portalEnabled || project.archivedAt !== null) fail("INVALID_INPUT", "the project's portal is off");
  }
  return { clientId: anchor.clientId as string, projectId: anchor.projectId };
}

/** The contact's language for the mail — theirs, else the workspace's. */
const localeOf = (raw: string | null | undefined, fallback: string): "en" | "sv" =>
  (raw ?? fallback) === "sv" ? "sv" : "en";

/**
 * ASK A CLIENT'S CONTACT FOR A LOGIN (C66). Resolves with the new ask's id.
 * Refuses NOT_FOUND (out of scope — before anything else is answered),
 * INVALID_INPUT (what was typed; an anchor with no client or a project
 * whose portal is off), `NAME_REQUIRED`, `CLIENT_MISMATCH`, `ARCHIVED` (the
 * client or the project), `LOGIN_ASKS_OFF`, `LOGIN_ASK_CONTACT`,
 * `LOGIN_ASK_LIMIT`, `MFA_REQUIRED` (the door), `VAULT_BUSY`. `mail` says
 * what the person was sent: the mail now, none because one went out in the
 * last `ASK_MAIL_EVERY_HOURS`, or none because their address takes no mail
 * from us — so the member is told the truth.
 */
export async function askForLogin(
  ctx: VaultCtx,
  input: AskForLoginInput,
): Promise<{ id: string; mail: "sent" | "recent" | "suppressed" }> {
  if (!isCredentialType(input.type)) fail("INVALID_INPUT", "type");
  const type = input.type as CredentialType;
  const name = trimmedOrNull(input.name, NAME_MAX, "name");
  if (name === null) fail("NAME_REQUIRED");
  const note = trimmedOrNull(input.note, ASK_NOTE_MAX, "note");
  const contactId = idOf(input.contactId, "contactId");

  return boundedVaultWrite((opts) =>
    askGuarded(() =>
    withTenant(
      ctx.tenantId,
      principalOf(ctx),
      async (tx) =>
        guarded(async () => {
          await enterVault(tx, ctx, "credential:create");
          const anchor = await askAnchor(tx, ctx, input);
          if (!(await asksOpen(tx, ctx.tenantId))) fail("LOGIN_ASKS_OFF");

          // ONE ASK AT A TIME PER PERSON, so the bound below is a bound:
          // two members asking the same contact at once are counted one
          // after the other. The key space every `hashtext` advisory lock
          // shares (`budget.ts`).
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`credential_ask:${ctx.tenantId}:${contactId}`}))`;
          const contact = await tx.contact.findFirst({
            where: { tenantId: ctx.tenantId, id: contactId },
            select: {
              clientId: true,
              portalProfile: true,
              portalStatus: true,
              invitedAt: true,
              email: true,
              locale: true,
            },
          });
          if (!contact || !contactCanAnswer(contact, anchor.clientId)) fail("LOGIN_ASK_CONTACT");
          const open = await tx.credentialAsk.count({
            where: { tenantId: ctx.tenantId, contactId, sentAt: null, declinedAt: null, cancelledAt: null },
          });
          if (open >= ASKS_OPEN_PER_CONTACT) fail("LOGIN_ASK_LIMIT");
          const lately = await tx.credentialAsk.count({
            where: { tenantId: ctx.tenantId, contactId, createdAt: { gte: new Date(Date.now() - DAY_MS) } },
          });
          if (lately >= ASKS_PER_CONTACT_PER_DAY) fail("LOGIN_ASK_LIMIT");

          const ask = await tx.credentialAsk.create({
            data: {
              tenantId: ctx.tenantId,
              clientId: anchor.clientId,
              projectId: anchor.projectId,
              contactId,
              type,
              name: name as string,
              note,
              requestedByMemberId: ctx.actor.memberId,
            },
            select: { id: true },
          });
          await record(tx, {
            action: "credential.asked",
            targetType: "CredentialAsk",
            targetId: ask.id,
            // Ids and the kind — never what the member wrote.
            metadata: { clientId: anchor.clientId, projectId: anchor.projectId, contactId, type },
          });

          // THE ONE MAIL (C66 (b)), into the outbox in this transaction, so
          // it exists exactly when the ask does. A suppressed address gets
          // none (the worker checks again at send); the ask still stands.
          // AT MOST ONE PER PERSON PER `ASK_MAIL_EVERY_HOURS` (the security
          // review's low): each ask is a mail in the agency's name from the
          // platform's domain, and a member asking a dozen things in a
          // sitting — or asking and cancelling — must not fill an inbox. The
          // mail names nothing; the portal lists every open ask. Counted
          // under the per-person lock above.
          const to = contact!.email.toLowerCase();
          const suppressed = await tx.emailSuppression.findFirst({ where: { email: to }, select: { email: true } });
          if (suppressed) return { id: ask.id, mail: "suppressed" as const };
          const recent = await tx.emailOutbox.findFirst({
            where: {
              tenantId: ctx.tenantId,
              receiverType: "CONTACT",
              receiverId: contactId,
              kind: LOGIN_ASK_MAIL,
              createdAt: { gte: new Date(Date.now() - ASK_MAIL_EVERY_HOURS * 60 * 60_000) },
              // A mail that is going or went — never one that died or was
              // suppressed, which reached nobody (the fix-pass review's nit).
              status: { in: ["QUEUED", "SENDING", "SENT", "FAILED"] },
            },
            select: { id: true },
          });
          if (recent) return { id: ask.id, mail: "recent" as const };
          const tenant = await tx.tenant.findFirst({ where: { id: ctx.tenantId }, select: { defaultLocale: true } });
          await tx.emailOutbox.createMany({
            data: [
              {
                tenantId: ctx.tenantId,
                idempotencyKey: `credential_ask:${ask.id}:CONTACT:${contactId}`,
                receiverType: "CONTACT",
                receiverId: contactId,
                toEmail: to,
                kind: LOGIN_ASK_MAIL,
                locale: localeOf(contact!.locale, tenant?.defaultLocale ?? "en"),
                // The ask's id only — the link's (ARC-09).
                params: { askId: ask.id },
                notificationIds: [],
              },
            ],
            skipDuplicates: true,
          });
          return { id: ask.id, mail: "sent" as const };
        }),
      opts,
    ),
    ),
  );
}

/**
 * CANCEL AN OPEN ASK — anyone who could have made it there (`credential:create`
 * and the anchor's reach), not only its asker: the team shares the work.
 * Refuses NOT_FOUND (no such ask, or out of scope) and `LOGIN_ASK_ENDED`
 * (already sent, declined or cancelled — said, so a member who raced the
 * client learns which way it went by reloading).
 */
export async function cancelLoginAsk(ctx: VaultCtx, askId: unknown): Promise<void> {
  const id = idOf(askId, "askId");
  await boundedVaultWrite((opts) =>
    askGuarded(() =>
    withTenant(
      ctx.tenantId,
      principalOf(ctx),
      async (tx) =>
        guarded(async () => {
          await enterVault(tx, ctx, "credential:create");
          const found = await tx.credentialAsk.findFirst({
            where: { tenantId: ctx.tenantId, id },
            select: { clientId: true, projectId: true },
          });
          if (!found) return deny("NOT_FOUND");
          const anchor: VaultAnchor = { clientId: found.clientId, projectId: found.projectId };
          await assertAnchorInScope(tx, ctx.actor, anchor);
          // The row's lock, then its state: a send or a decline committing
          // meanwhile is read, never overwritten.
          const locked = await tx.$queryRaw<{ open: boolean }[]>`
            SELECT (sent_at IS NULL AND declined_at IS NULL AND cancelled_at IS NULL) AS open
              FROM credential_ask
             WHERE tenant_id = ${ctx.tenantId} AND id = ${id}
               FOR UPDATE`;
          if (locked.length === 0) return deny("NOT_FOUND");
          if (!locked[0]!.open) fail("LOGIN_ASK_ENDED");
          await tx.credentialAsk.update({
            where: { id },
            data: { cancelledAt: new Date(), cancelledByMemberId: ctx.actor.memberId },
            select: { id: true },
          });
          await record(tx, {
            action: "credential.ask_cancelled",
            targetType: "CredentialAsk",
            targetId: id,
            metadata: { clientId: anchor.clientId, projectId: anchor.projectId },
          });
        }),
      opts,
    ),
    ),
  );
}

export type LoginAskFilter = { readonly clientId: string } | { readonly projectId: string };

/**
 * THE ASKS UNDER ONE ANCHOR, AS THE TEAM SEES THEM (credential:view, through
 * the door): every open ask first, then those answered or cancelled in the
 * last `ASK_HISTORY_DAYS`, newest first — each with the person asked
 * (and whether they can still answer), who asked, and how it ended: the
 * login it became, or the client's note. By the vault's anchor rule, as
 * the logins themselves are listed. A client's list includes its
 * projects' asks the member reaches.
 */
export async function listLoginAsks(ctx: VaultCtx, filter: LoginAskFilter): Promise<LoginAskView[]> {
  const anchorWhere =
    "projectId" in filter
      ? { projectId: idOf(filter.projectId, "projectId") }
      : { clientId: idOf(filter.clientId, "clientId") };
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await enterVault(tx, ctx, "credential:view");
    const scope = await scopeWhereOf(tx, ctx);
    const since = new Date(Date.now() - ASK_HISTORY_DAYS * DAY_MS);
    const mine = { tenantId: ctx.tenantId, ...anchorWhere };
    const orderBy = [{ createdAt: "desc" as const }, { id: "desc" as const }];
    // EVERY OPEN ASK, never cut (the code review's low: a cap over both
    // would drop an old open ask — and its only Cancel — with nothing to
    // say so); the per-person bound keeps this list finite. Then the
    // history, capped. Two reads, in sequence.
    const openRows = await tx.credentialAsk.findMany({
      where: { AND: [mine, scope, { sentAt: null, declinedAt: null, cancelledAt: null }] },
      select: ASK_SELECT,
      orderBy,
    });
    const pastRows = await tx.credentialAsk.findMany({
      where: {
        AND: [
          mine,
          scope,
          { OR: [{ sentAt: { gte: since } }, { declinedAt: { gte: since } }, { cancelledAt: { gte: since } }] },
        ],
      },
      select: ASK_SELECT,
      orderBy,
      take: ASK_LIST_LIMIT,
    });
    // An ask answered between the two reads is in both: listed once, as read first.
    const openIds = new Set(openRows.map((r) => r.id));
    const rows = [...openRows, ...pastRows.filter((r) => !openIds.has(r.id))];
    // Whether a client could answer at all — once, in sequence.
    const open = await asksOpen(tx, ctx.tenantId);
    // The logins asks became that are still live: "Show the login" leads
    // to a row only while it is listed (the code review's low).
    const sentIds = rows.flatMap((r) => (r.sentCredentialId ? [r.sentCredentialId] : []));
    const live = new Set(
      sentIds.length
        ? (
            await tx.credentialItem.findMany({
              where: { tenantId: ctx.tenantId, id: { in: sentIds }, deletedAt: null },
              select: { id: true },
            })
          ).map((c) => c.id)
        : [],
    );
    // Names, in SEQUENCE after the list (AGENTS.md's trap): the people
    // asked, then the members who asked or cancelled.
    const contactIds = [...new Set(rows.map((r) => r.contactId))];
    const contacts = contactIds.length
      ? await tx.contact.findMany({
          where: { tenantId: ctx.tenantId, id: { in: contactIds } },
          select: { id: true, name: true, clientId: true, portalProfile: true, portalStatus: true, invitedAt: true },
        })
      : [];
    const contactOf = new Map(contacts.map((c) => [c.id, c]));
    const memberIds = [
      ...new Set(rows.flatMap((r) => [r.requestedByMemberId, ...(r.cancelledByMemberId ? [r.cancelledByMemberId] : [])])),
    ];
    const members = memberIds.length
      ? await tx.member.findMany({
          where: { tenantId: ctx.tenantId, id: { in: memberIds } },
          select: { id: true, user: { select: { name: true } } },
        })
      : [];
    const memberName = new Map(members.map((m) => [m.id, m.user.name]));

    const views = rows.map((r): LoginAskView => {
      const c = contactOf.get(r.contactId);
      const state: LoginAskState =
        r.sentAt && r.sentCredentialId
          ? { kind: "sent", at: r.sentAt, credentialId: live.has(r.sentCredentialId) ? r.sentCredentialId : null }
          : r.declinedAt
            ? { kind: "declined", at: r.declinedAt, note: r.declineNote }
            : r.cancelledAt
              ? { kind: "cancelled", at: r.cancelledAt, by: memberName.get(r.cancelledByMemberId ?? "") ?? null }
              : { kind: "open" };
      const answerable =
        open &&
        r.client.status !== "ARCHIVED" &&
        (c ? contactCanAnswer(c, r.clientId) : false) &&
        (r.project === null || (r.project.portalEnabled && r.project.archivedAt === null && r.project.status !== "ARCHIVED"));
      return {
        id: r.id,
        clientId: r.clientId,
        projectId: r.projectId,
        projectKey: r.project?.key ?? null,
        type: r.type as CredentialType,
        name: r.name,
        note: r.note,
        contact: { name: c?.name ?? null },
        stuck: state.kind === "open" && !answerable,
        askedBy: memberName.get(r.requestedByMemberId) ?? null,
        askedAt: r.createdAt,
        state,
      };
    });
    // The open ones first (read first), each group newest first.
    return views;
  });
}

/** The member's reach as a `where` fragment (the vault's anchor rule). */
async function scopeWhereOf(tx: TenantDb, ctx: VaultCtx) {
  return anchorScopeWhere(await resolveScope(tx, ctx.actor));
}

/**
 * WHAT AN "ASK FOR A LOGIN…" FORM MAY OFFER ON THIS PAGE (credential:view,
 * through the door): whether this member may ask at all (`credential:create`
 * on all four gates — C66 (d)), whether a client could answer now (the
 * switch, the portal module), WHO may be asked (the client's contacts with
 * portal access who may send a login, main contacts first), and WHERE —
 * the client itself when the member reaches its client-level logins, and
 * each project of it in the member's reach whose portal is on and which
 * is live (`askAnchor`'s rule). On a project's page, `anchor` names the
 * project and only it is offered. Nothing when the client is archived.
 */
export async function loginAskTargets(ctx: VaultCtx, anchor: VaultAnchor): Promise<AskTargets> {
  const none: AskTargets = { canAsk: false, canCancel: false, open: false, contacts: [], places: [] };
  if (anchor.clientId === null) return none;
  const clientId = idOf(anchor.clientId, "clientId");
  const onlyProject = anchor.projectId === null ? null : idOf(anchor.projectId, "projectId");
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await enterVault(tx, ctx, "credential:view");
    // On a project's page the project must be in reach; on a client's page
    // nothing is asserted — a member who reaches the client only through a
    // project sees that tab too — and the places below are what they reach.
    const scope =
      onlyProject !== null
        ? await assertAnchorInScope(tx, ctx.actor, { clientId, projectId: onlyProject })
        : await resolveScope(tx, ctx.actor);
    if (!(await hasAccess(tx, ctx.tenantId, ctx.actor, "credential:create"))) return none;
    // CANCEL needs only this (`cancelLoginAsk`: the door, the code, the
    // ask's anchor in reach — every ask listed on the page is): an ask stuck
    // on an archived client or a project whose portal went off must still be
    // cancellable, or it holds the person's open bound for good (the code
    // review's medium). Asking needs the rest below.
    const cannotAsk: AskTargets = { ...none, canCancel: true };
    const client = await tx.client.findFirst({ where: { tenantId: ctx.tenantId, id: clientId }, select: { status: true } });
    if (!client || client.status === "ARCHIVED") return cannotAsk;
    const open = await asksOpen(tx, ctx.tenantId);

    const projects = await tx.project.findMany({
      where: {
        tenantId: ctx.tenantId,
        clientId,
        ...(onlyProject !== null ? { id: onlyProject } : {}),
        portalEnabled: true,
        archivedAt: null,
        status: { not: "ARCHIVED" },
      },
      select: { id: true, key: true, name: true },
      orderBy: [{ key: "asc" }],
    });
    const places: AskPlace[] = [
      ...(onlyProject === null && anchorInScope(scope, { clientId, projectId: null }) ? [{ projectId: null }] : []),
      ...projects
        .filter((p) => anchorInScope(scope, { clientId, projectId: p.id }))
        .map((p) => ({ projectId: p.id, label: `${p.key} · ${p.name}` })),
    ];
    // Nowhere this member could place an ask: nobody to name either.
    if (places.length === 0) return { ...cannotAsk, open };

    const rows = await tx.contact.findMany({
      where: { tenantId: ctx.tenantId, clientId, portalStatus: "ACTIVE", invitedAt: { not: null } },
      select: { id: true, name: true, email: true, clientId: true, portalProfile: true, portalStatus: true, invitedAt: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
    // Their ADDRESSES only to a member who may see the client's contacts
    // (`client:view`, as `getClient` shows them — the security review's
    // low): a custom role with the vault codes alone picks by name.
    const showEmail = await hasAccess(tx, ctx.tenantId, ctx.actor, "client:view");
    const contacts = rows
      .filter((r) => contactCanAnswer(r, clientId))
      .map((r) => ({
        id: r.id,
        name: r.name,
        email: showEmail ? r.email : null,
        primary: r.portalProfile === "CONTACT_PRIMARY",
      }));
    return {
      canAsk: true,
      canCancel: true,
      open,
      contacts: [...contacts.filter((c) => c.primary), ...contacts.filter((c) => !c.primary)],
      places,
    };
  });
}
