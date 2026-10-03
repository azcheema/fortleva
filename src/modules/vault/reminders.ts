import { record } from "@/audit/record";
import { resolveScope, type MemberActor, type ScopeResolution } from "@/authz/authorize";
import { withTenant, type TenantDb } from "@/db";
import { accessibleCodes } from "@/entitlements/resolver";
import { dateColumn, isoDateOf, localDateString } from "@/lib/duration";
import { emit } from "@/notify/emit";
import { readPreferences } from "@/preferences/service";

import { REMINDER_HORIZON_DAYS, addDays, bandFor, dayStart, daysUntil, utcDayOf, type ReminderBand } from "./reminder-bands";
import { anchorInScope, type VaultAnchor } from "./scope";

/**
 * THE RENEWAL REMINDERS (Phase 3V slice 89; DATA_MODEL.md §6.17; PLAN
 * Phase 3V "reminders at 60/30/14/7/1 days, deduplicated by
 * ExpirationReminderSent"). Run once a day per tenant by
 * `src/jobs/expiration-reminders.ts`, which found the tenant under the
 * audited platform seam; everything here runs under THIS tenant's SYSTEM
 * principal, RLS live.
 *
 * WHAT IS SENT, one band at a time (`reminder-bands.ts`):
 *   - an ASSET in use with a renewal date — `expiration.asset_due`;
 *   - an AGREEMENT not ended with an END date — `expiration.agreement_ending`.
 *     Founder decision C55: only when one ends; a regular renewal sends
 *     nothing (it would be noise every month);
 *   - LOGINS with an expiry date — `expiration.logins_expiring`, as a COUNT
 *     per client (C56): never naming a login, because which ones stays
 *     behind the vault's door (C54, C52 (a)). Deduplicated per LOGIN, so a
 *     login that enters a band a day after its neighbours is still told.
 *
 * WHO HEARS — and this is the part that must not leak:
 *   - an asset or an agreement: the client's people (C53) — that PROJECT's
 *     people (its assignees and its lead) for a project's row, the
 *     client's directly assigned members for a client-level one — AND the
 *     workspace's owners, always (founder decision C57, 2026-10-03, which
 *     amended C53's "owners only when nobody is assigned"); each
 *     kept only if, checked as THEMSELVES, they hold the row's code on all
 *     four gates (`asset:view`; for an agreement `service:view`, which is
 *     core — an agreement's end is reminded whether or not the vault module
 *     is on, the code review's medium) AND their scope reaches the row by
 *     the vault's anchor rule (`anchorInScope`, the rule `/expirations`
 *     lists by) — the owners too: the owner role itself is read-only
 *     and holds every code, but a module switched off, the plan, the
 *     kill-switch or a template not yet seeded still closes a code to them
 *     (the C57 review). EACH RECEIVER'S MAIL LINKS TO A PAGE THEY CAN OPEN (`linkFor`):
 *     the asset's line needs `client:view`, an agreement's tab needs direct
 *     assignment too, Renewals needs `asset:view` — so receivers are told in
 *     one fan-out per link, the link a closed token in `params`;
 *   - logins: every active member who holds `credential:view` on all four
 *     gates, each told the number of THIS group's logins their scope
 *     reaches — the agency's own (no client) only to tenant-wide scope,
 *     on two checks as everywhere else (C49).
 *   No receiver ⇒ nothing is sent AND nothing is recorded, so the reminder
 *   still goes out once somebody can hear it (a member assigned, the
 *   module switched back on) inside the same band.
 *
 * ONE TRANSACTION PER REMINDER: its dedupe row (ON CONFLICT DO NOTHING —
 * a conflict is "already sent", which also settles two runs racing), the
 * notification and its mail (`notify.emit`), and `expiration.reminder_sent`
 * commit together or not at all. The row is re-read inside it, so a
 * reminder is only ever about a row as it stands when it is sent — an
 * asset retired or re-dated since the plan sends nothing until the next
 * run plans it again. Who may hear is decided just before, in short reads
 * of their own (each member's codes and scope once per run); a member
 * whose access changes in those seconds still reads the inbox row under
 * their OWN principal, which names nothing they can no longer see
 * (`reminderSubjects`).
 *
 * Reads in SEQUENCE on each transaction (AGENTS.md's `Promise.all` trap),
 * and nothing here logs (`vault-boundary.test.ts`).
 */

const SYSTEM = { type: "system" } as const;

/** The codes a receiver can need — one permission resolution per member per run. */
const RECEIVER_CODES = ["asset:view", "service:view", "credential:view", "client:view"] as const;

/**
 * Where a receiver's mail sends them — a closed token in `params`, turned
 * into a path by `src/notify/templates.ts`: the asset's own line on the
 * client's Assets tab, the client's Agreements tab, Renewals, or the inbox.
 */
export type ReminderLink = "asset" | "agreements" | "renewals" | "inbox";

type SubjectType = "ClientAsset" | "Service";

type DueSubject = VaultAnchor & {
  readonly type: SubjectType;
  readonly id: string;
  readonly clientId: string;
  /** The UTC day reminded about, `YYYY-MM-DD`. */
  readonly dueOn: string;
  readonly band: ReminderBand;
};

type DueLogin = VaultAnchor & {
  readonly id: string;
  readonly dueOn: string;
  readonly band: ReminderBand;
};

type People = {
  /** Every ACTIVE member of the tenant. */
  readonly active: ReadonlySet<string>;
  readonly byClient: ReadonlyMap<string, readonly string[]>;
  readonly byProject: ReadonlyMap<string, readonly string[]>;
  readonly leadOf: ReadonlyMap<string, string | null>;
  /** ACTIVE holders of the owner system role. */
  readonly owners: readonly string[];
};

type Plan = {
  readonly today: string;
  readonly subjects: readonly DueSubject[];
  readonly logins: readonly DueLogin[];
  readonly people: People | null;
};

export type ReminderRun = {
  /** Asset reminders sent. */
  readonly assets: number;
  /** Agreement-ending reminders sent. */
  readonly agreements: number;
  /** Login reminders sent — one per client and band, however many logins. */
  readonly logins: number;
};

const keyOf = (type: string, id: string, dueOn: string, band: number) => `${type}|${id}|${dueOn}|${band}`;

/** The day a stored date is reminded about, and its band today — or null when none is due. */
function due(today: string, at: Date | null): { dueOn: string; band: ReminderBand } | null {
  if (!at) return null;
  const dueOn = utcDayOf(at);
  const band = bandFor(daysUntil(today, dueOn));
  return band === null ? null : { dueOn, band };
}

/**
 * The tenant's day, everything due today that has not been sent, and — only
 * when something is — the people who could hear about it. Also sweeps the
 * dedupe rows whose day has passed: they can no longer matter, because a
 * passed date sends nothing.
 */
async function plan(tx: TenantDb, tenantId: string, now: Date): Promise<Plan> {
  const prefs = await readPreferences(tx, tenantId);
  const today = localDateString(now, prefs.timezone);
  // A day either side of the tenant's own, so a zone change between runs
  // never sweeps a row that can still decide a send.
  await tx.expirationReminderSent.deleteMany({ where: { tenantId, dueOn: { lt: dateColumn(addDays(today, -1)) } } });

  // [today 00:00Z, today+61 00:00Z) holds exactly the dates whose UTC day is
  // 0..60 days ahead — the feed's day rule (`expirations.ts`).
  const window = { gte: new Date(dayStart(today)), lt: new Date(dayStart(addDays(today, REMINDER_HORIZON_DAYS + 1))) };
  const assets = await tx.clientAsset.findMany({
    where: { tenantId, status: "ACTIVE", expiresAt: window },
    select: { id: true, clientId: true, projectId: true, expiresAt: true },
  });
  // C55: an END only. Not ENDED: an agreement already ended has nothing to decide.
  const agreements = await tx.service.findMany({
    where: { tenantId, status: { not: "ENDED" }, endsAt: window },
    select: { id: true, clientId: true, projectId: true, endsAt: true },
  });
  // Metadata only — never the secret's table (the vault's boundary).
  const logins = await tx.credentialItem.findMany({
    where: { tenantId, deletedAt: null, expiresAt: window },
    orderBy: { id: "asc" }, // one insert order for every run: no deadlock between two
    select: { id: true, clientId: true, projectId: true, expiresAt: true },
  });
  const sent = new Set(
    (
      await tx.expirationReminderSent.findMany({
        where: { tenantId, dueOn: { gte: dateColumn(today) } },
        select: { subjectType: true, subjectId: true, dueOn: true, offsetDays: true },
      })
    ).map((r) => keyOf(r.subjectType, r.subjectId, isoDateOf(r.dueOn), r.offsetDays)),
  );
  const unsent = (type: string, id: string, d: { dueOn: string; band: ReminderBand } | null) =>
    d !== null && !sent.has(keyOf(type, id, d.dueOn, d.band));

  const subjects: DueSubject[] = [];
  for (const a of assets) {
    const d = due(today, a.expiresAt);
    if (unsent("ClientAsset", a.id, d)) subjects.push({ type: "ClientAsset", id: a.id, clientId: a.clientId, projectId: a.projectId, ...d! });
  }
  for (const s of agreements) {
    const d = due(today, s.endsAt);
    if (unsent("Service", s.id, d)) subjects.push({ type: "Service", id: s.id, clientId: s.clientId, projectId: s.projectId, ...d! });
  }
  const dueLogins: DueLogin[] = [];
  for (const l of logins) {
    const d = due(today, l.expiresAt);
    if (unsent("CredentialItem", l.id, d)) dueLogins.push({ id: l.id, clientId: l.clientId, projectId: l.projectId, ...d! });
  }
  if (subjects.length === 0 && dueLogins.length === 0) return { today, subjects, logins: dueLogins, people: null };

  const clientIds = [...new Set(subjects.filter((s) => s.projectId === null).map((s) => s.clientId))];
  const projectIds = [...new Set(subjects.flatMap((s) => (s.projectId === null ? [] : [s.projectId])))];
  const active = await tx.member.findMany({ where: { tenantId, status: "ACTIVE" }, select: { id: true } });
  const clientRows = clientIds.length
    ? await tx.memberClient.findMany({ where: { tenantId, clientId: { in: clientIds } }, select: { memberId: true, clientId: true } })
    : [];
  const projectRows = projectIds.length
    ? await tx.memberProject.findMany({ where: { tenantId, projectId: { in: projectIds } }, select: { memberId: true, projectId: true } })
    : [];
  const leads = projectIds.length
    ? await tx.project.findMany({ where: { tenantId, id: { in: projectIds } }, select: { id: true, leadMemberId: true } })
    : [];
  const owners = await tx.memberRole.findMany({
    where: { tenantId, role: { isSystem: true, templateKey: "owner" }, member: { status: "ACTIVE" } },
    select: { memberId: true },
  });
  const group = <T>(rows: readonly T[], key: (r: T) => string, value: (r: T) => string) => {
    const out = new Map<string, string[]>();
    for (const r of rows) out.set(key(r), [...(out.get(key(r)) ?? []), value(r)]);
    return out;
  };
  return {
    today,
    subjects,
    logins: dueLogins,
    people: {
      active: new Set(active.map((m) => m.id)),
      byClient: group(clientRows, (r) => r.clientId, (r) => r.memberId),
      byProject: group(projectRows, (r) => r.projectId, (r) => r.memberId),
      leadOf: new Map(leads.map((p) => [p.id, p.leadMemberId])),
      owners: [...new Set(owners.map((o) => o.memberId))],
    },
  };
}

type Who = { readonly codes: ReadonlySet<string>; readonly scope: ScopeResolution };

/**
 * A member's codes (all four gates) and scope, resolved AS THAT MEMBER —
 * not as the system — in a short read of its own, once per run. The actor
 * carries no factor and no impersonation: none of `RECEIVER_CODES` is a ✦
 * code, and a receiver is a person, never a platform admin.
 */
function whoResolver(tenantId: string): (memberId: string) => Promise<Who> {
  const memo = new Map<string, Who>();
  return async (memberId) => {
    const known = memo.get(memberId);
    if (known) return known;
    const actor: MemberActor = { memberId };
    const who = await withTenant(tenantId, SYSTEM, async (tx) => {
      const codes = await accessibleCodes(tx, tenantId, actor, RECEIVER_CODES);
      const scope = await resolveScope(tx, actor);
      return { codes, scope };
    });
    memo.set(memberId, who);
    return who;
  };
}

type Receiver = { readonly memberId: string; readonly link: ReminderLink };

/**
 * Where this receiver's mail may send them — never a page that would refuse
 * them (C34's rule; both reviews): every `/clients/[id]/…` page wants
 * `client:view`, the Agreements tab DIRECT assignment as well, Renewals
 * `asset:view`. An asset receiver holds `asset:view`, so Renewals is always
 * open to them; an agreement receiver may hold neither, and gets the inbox.
 */
function linkOf(s: DueSubject, w: Who): ReminderLink {
  const clientPages = w.codes.has("client:view");
  if (s.type === "ClientAsset") return clientPages ? "asset" : "renewals";
  const direct = w.scope.all || w.scope.directClientIds.includes(s.clientId);
  if (direct && clientPages) return "agreements";
  return w.codes.has("asset:view") ? "renewals" : "inbox";
}

/** C53's receivers and, by C57, the owners — see the file's comment. One row each, however many ways they qualify. */
async function subjectReceivers(s: DueSubject, people: People, who: (id: string) => Promise<Who>): Promise<Receiver[]> {
  const required = s.type === "ClientAsset" ? "asset:view" : "service:view";
  const keep = async (ids: Iterable<string>) => {
    const out: Receiver[] = [];
    // In turn: each `who` may open a transaction of its own.
    for (const memberId of new Set(ids)) {
      if (!people.active.has(memberId)) continue;
      const w = await who(memberId);
      if (w.codes.has(required) && anchorInScope(w.scope, s)) out.push({ memberId, link: linkOf(s, w) });
    }
    return out;
  };
  const lead = s.projectId === null ? null : (people.leadOf.get(s.projectId) ?? null);
  const assigned =
    s.projectId === null
      ? (people.byClient.get(s.clientId) ?? [])
      : [...(people.byProject.get(s.projectId) ?? []), ...(lead ? [lead] : [])];
  return keep([...assigned, ...people.owners]);
}

/** Send one asset or agreement reminder; true when it went out. */
async function sendSubject(tenantId: string, s: DueSubject, receivers: readonly Receiver[]): Promise<boolean> {
  return withTenant(tenantId, SYSTEM, async (tx) => {
    // The row as it stands NOW: still in use (or running), still due that
    // day, still on the same anchor the receivers were chosen for.
    const row =
      s.type === "ClientAsset"
        ? await tx.clientAsset.findFirst({
            where: { tenantId, id: s.id, status: "ACTIVE" },
            select: { clientId: true, projectId: true, expiresAt: true },
          })
        : await tx.service.findFirst({
            where: { tenantId, id: s.id, status: { not: "ENDED" } },
            select: { clientId: true, projectId: true, endsAt: true },
          });
    const at = row ? ("expiresAt" in row ? row.expiresAt : row.endsAt) : null;
    if (!row || !at || utcDayOf(at) !== s.dueOn || row.clientId !== s.clientId || row.projectId !== s.projectId) return false;

    const { count } = await tx.expirationReminderSent.createMany({
      data: [{ tenantId, subjectType: s.type, subjectId: s.id, dueOn: dateColumn(s.dueOn), offsetDays: s.band }],
      skipDuplicates: true,
    });
    if (count === 0) return false; // already sent — a concurrent run got there first
    const asset = s.type === "ClientAsset";
    // One fan-out per link, so each mail opens a page its reader may open.
    const byLink = new Map<ReminderLink, string[]>();
    for (const r of receivers) byLink.set(r.link, [...(byLink.get(r.link) ?? []), r.memberId]);
    for (const [link, memberIds] of byLink) {
      await emit(tx, tenantId, {
        kind: asset ? "expiration.asset_due" : "expiration.agreement_ending",
        entity: { type: s.type, id: s.id },
        clientId: s.clientId,
        ...(s.projectId === null ? {} : { projectId: s.projectId }),
        memberIds,
        // IDS ONLY, the band and the link's closed token: emit's rule.
        params: { clientId: s.clientId, [asset ? "assetId" : "serviceId"]: s.id, days: String(s.band), link },
        dedupeKey: `expiration:${s.type}:${s.id}:${s.dueOn}:${s.band}`,
      });
    }
    await record(tx, {
      action: "expiration.reminder_sent",
      targetType: s.type,
      targetId: s.id,
      metadata: { offsetDays: s.band, dueOn: s.dueOn, receivers: receivers.length },
    });
    return true;
  });
}

type LoginGroup = { readonly clientId: string | null; readonly band: ReminderBand; readonly logins: readonly DueLogin[] };

/** Who hears about a group of logins, and which of the group each one reaches. */
async function loginReceivers(
  g: LoginGroup,
  people: People,
  who: (id: string) => Promise<Who>,
): Promise<{ memberId: string; reached: readonly string[] }[]> {
  const out: { memberId: string; reached: string[] }[] = [];
  for (const memberId of people.active) {
    const w = await who(memberId);
    if (!w.codes.has("credential:view")) continue;
    // C49 on two checks: the anchor rule, and tenant-wide scope itself.
    const reached = g.logins.filter((l) => anchorInScope(w.scope, l) && (l.clientId !== null || w.scope.all)).map((l) => l.id);
    if (reached.length > 0) out.push({ memberId, reached });
  }
  return out;
}

/** Send one client's (or our own) login reminder for one band; true when it went out. */
async function sendLogins(
  tenantId: string,
  today: string,
  g: LoginGroup,
  receivers: readonly { memberId: string; reached: readonly string[] }[],
): Promise<boolean> {
  return withTenant(tenantId, SYSTEM, async (tx) => {
    // Only logins somebody here reaches are recorded: a login nobody can be
    // told about stays unsent, as a subject with no receiver does (the code
    // review's low).
    const heard = new Set(receivers.flatMap((r) => r.reached));
    const ids = g.logins.filter((l) => heard.has(l.id)).map((l) => l.id);
    if (ids.length === 0) return false;
    const live = await tx.credentialItem.findMany({
      where: { tenantId, id: { in: ids }, deletedAt: null },
      select: { id: true, clientId: true, projectId: true, expiresAt: true },
    });
    const told = new Set<string>();
    for (const l of g.logins) {
      if (!heard.has(l.id)) continue;
      const row = live.find((r) => r.id === l.id);
      // Still live, still due that day, still where it was planned.
      if (!row?.expiresAt || utcDayOf(row.expiresAt) !== l.dueOn || row.clientId !== l.clientId || row.projectId !== l.projectId) continue;
      const { count } = await tx.expirationReminderSent.createMany({
        data: [{ tenantId, subjectType: "CredentialItem", subjectId: l.id, dueOn: dateColumn(l.dueOn), offsetDays: l.band }],
        skipDuplicates: true,
      });
      if (count === 1) told.add(l.id);
    }
    if (told.size === 0) return false;
    // Each receiver is told how many of THESE logins they can open — the
    // count differs between a manager and a member of one project.
    const byCount = new Map<number, string[]>();
    for (const r of receivers) {
      const n = r.reached.filter((id) => told.has(id)).length;
      if (n > 0) byCount.set(n, [...(byCount.get(n) ?? []), r.memberId]);
    }
    for (const [n, memberIds] of byCount) {
      await emit(tx, tenantId, {
        kind: "expiration.logins_expiring",
        entity: g.clientId === null ? { type: "Tenant", id: tenantId } : { type: "Client", id: g.clientId },
        ...(g.clientId === null ? {} : { clientId: g.clientId }),
        memberIds,
        // A count, the band and the tenant's day it was decided on — never a
        // login's id or name (C54, C56). `from` bounds which logins the inbox
        // may later count for this row (`reminderSubjects`' window).
        params: { ...(g.clientId === null ? {} : { clientId: g.clientId }), count: String(n), days: String(g.band), from: today },
      });
    }
    await record(tx, {
      action: "expiration.reminder_sent",
      targetType: g.clientId === null ? "Tenant" : "Client",
      targetId: g.clientId ?? tenantId,
      metadata: {
        subject: "CredentialItem",
        offsetDays: g.band,
        logins: told.size,
        receivers: [...byCount.values()].reduce((sum, ids) => sum + ids.length, 0),
      },
    });
    return true;
  });
}

/**
 * Today's renewal reminders for one tenant (the daily job's per-tenant
 * body). Idempotent: run it twice, or twice at once, and each reminder
 * goes out once.
 */
export async function sendExpirationReminders(tenantId: string, now: Date = new Date()): Promise<ReminderRun> {
  if (typeof tenantId !== "string" || tenantId.length === 0) throw new TypeError("vault: tenantId must be a non-empty string");
  const p = await withTenant(tenantId, SYSTEM, (tx) => plan(tx, tenantId, now));
  const out = { assets: 0, agreements: 0, logins: 0 };
  if (p.people === null) return out;
  const people = p.people;
  const who = whoResolver(tenantId);

  for (const s of p.subjects) {
    const receivers = await subjectReceivers(s, people, who);
    if (receivers.length === 0) continue; // nobody can hear it yet — nothing recorded
    if (await sendSubject(tenantId, s, receivers)) out[s.type === "ClientAsset" ? "assets" : "agreements"] += 1;
  }

  const groups = new Map<string, LoginGroup>();
  for (const l of p.logins) {
    const key = `${l.clientId ?? ""}|${l.band}`;
    const g = groups.get(key);
    groups.set(key, { clientId: l.clientId, band: l.band, logins: [...(g?.logins ?? []), l] });
  }
  for (const g of groups.values()) {
    const receivers = await loginReceivers(g, people, who);
    if (receivers.length === 0) continue;
    if (await sendLogins(tenantId, p.today, g, receivers)) out.logins += 1;
  }
  return out;
}
