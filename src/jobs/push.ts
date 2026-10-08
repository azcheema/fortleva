import { decryptFieldV2 } from "@/crypto/field-encryption";
import { withTenant } from "@/db";
import { isEmailLevel, type NotificationKind } from "@/notify/catalog";
import { quietHoursOf } from "@/notify/quiet-hours";
import { usableZone } from "@/notify/zone";
import { readPreferences } from "@/preferences/service";
import { serverVapid } from "@/push/keys";
import { PUSH_KINDS, encodePushPayload, isPushKind, pushPayload } from "@/push/payload";
import { configuredPushTransport, type PushOutcome, type PushTransport } from "@/push/send";
import { pushTtlSeconds, pushVerdict, type PushReceiver } from "@/push/verdict";
import { buildPushRequest, receiverKeysOf, type ReceiverKeys } from "@/push/web-push";
import { pushEndpointUrl } from "@/config";

/**
 * THE PUSH DRAIN (Phase 5 slice 106; founder decision C74; ARC-25 Stage B).
 *
 * WHAT IT READS: the notifications themselves. A notification that may push
 * (`PUSH_KINDS`: every kind that may email, and the owners' alarm — C74 (i))
 * and has not been dealt with (`notification.pushed_at IS NULL`) is due the
 * moment it exists — a task handed over buzzes AT ONCE (C74 (h)) — for
 * `PUSH_WINDOW_MINUTES`, and never after: a buzz about something a quarter of
 * an hour old is noise, and the email and the inbox carry it (C74 (e)).
 *
 * AT MOST ONCE. The claim IS the stamp (`UPDATE … SET pushed_at`, `FOR UPDATE
 * SKIP LOCKED`), whatever the verdict, so two drains never send one
 * notification twice and a crash loses a buzz rather than repeating one. What a
 * pass claimed and then never got to — the budget ran out before any of its
 * sends STARTED — is handed back (`pushed_at` cleared where it is still this
 * claim's own stamp: the outbox's `releaseUnattempted`, the design review's
 * M2); one that was attempted is done, delivered or not.
 *
 * WHO GETS IT: the receiver's devices whose sign-in is ALIVE (C74 (d)) — the
 * row's session exists, is unexpired, is the member's own user's on the member
 * plane and is not impersonated — and that were made under THIS server's key
 * (`vapid_key`; the design review's M3: another environment's devices are
 * invisible to the claim and never counted against — only the housekeeping's
 * member and session rules, the same in every environment, reach them). One browser holding
 * live rows for two members of this workspace (a shared computer whose old
 * session row outlived its cookie) gets only the most recently linked one's
 * (the design review's L2). Whether the receiver wants it at all is
 * `pushVerdict` (their phone level, quiet hours when it happened and now, not
 * already seen); how long the push service may hold it is `pushTtlSeconds`.
 *
 * WHAT THE ANSWER DOES (`src/push/send.ts`): delivered → the device's refusal
 * count resets; gone (404/410) → the row is deleted; refused (other 4xx) → the
 * count rises, three in a row and the row is deleted (SECURITY §10); the push
 * service's own trouble (401/403/406/429/5xx, timeouts) counts for nothing. No
 * audit row for any of it — the inbox housekeeping's precedent (C74 (k)).
 *
 * RUNS AS THE TENANT'S OWN SYSTEM PRINCIPAL under RLS (`withTenant(t,
 * {type:"system"})`, TENANCY §12): `own_device` and the `pushed_at` guard let
 * the SYSTEM principal, and only it, do what this does. A device's keys are
 * decrypted one at a time; one that will not decrypt is skipped and logged by
 * id (the design review's M4) — it never blocks the claim.
 *
 * Callers: `kickPushes` (right after the request that made the notification —
 * `src/push/kick.ts`) and `runPushes` (`./push-sweep.ts`, the jobs route — the
 * backstop for a kick that was lost, and the housekeeping). A dbtest calls
 * `deliverPushes(<its own tenant>, {transport})`, never the route.
 *
 * NO PLATFORM DOOR IN THIS MODULE: `notify.emit` reaches it through the kick,
 * and the portal's routes reach `emit` (their announcers) — which must never
 * reach `withPlatform` (`src/portal/share-route-boundary.test.ts`). The one
 * cross-tenant read, the sweep's discovery, lives in `./push-sweep.ts`.
 */

export const PUSH_WINDOW_MINUTES = 15;
/** Notifications claimed per pass — small, so a slow push service strands few (M2). */
const CLAIM_BATCH = 20;
/** Refusals in a row that make a device forgotten (SECURITY §10). */
const REFUSALS_TO_FORGET = 3;
/** A device whose sign-in ended this long ago and was never re-linked is forgotten. */
export const DORMANT_DAYS = 90;
/** No pass starts with less than this left of the budget. */
export const CLAIM_MARGIN_MS = 5_000;

const SYSTEM = { type: "system" } as const;

export type PushRunResult = { sent: number; dropped: number; failed: number; released: number; forgotten: number };

type ClaimedRow = {
  id: string;
  receiver_id: string;
  kind: string;
  created_at: Date;
  read_at: Date | null;
  archived_at: Date | null;
  snoozed_till: Date | null;
};

type PlannedSend = {
  readonly notificationId: string;
  readonly deviceId: string;
  readonly endpoint: URL;
  readonly keys: ReceiverKeys;
  readonly payload: Buffer;
  readonly ttlSeconds: number;
  /** When the TTL was worked out (epoch ms): a send that waits in its queue spends it. */
  readonly plannedAt: number;
};

type Plan = {
  readonly sends: readonly PlannedSend[];
  readonly claimed: number;
  readonly dropped: number;
};

/** The error's NAME and code only — a Prisma message prints its arguments, and an endpoint is a device's address. */
const what = (e: unknown): string => {
  const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
  return `${e instanceof Error ? e.name : typeof e}${code}`;
};

export async function deliverPushes(
  tenantId: string,
  opts: {
    /** Only these notifications (a kick: the ids its request made). */
    readonly ids?: readonly string[];
    /** The transport; the configured one when omitted, nothing at all when push is not set up. */
    readonly transport?: PushTransport | null;
    /** How long this call may go on starting sends. */
    readonly budgetMs?: number;
  } = {},
): Promise<PushRunResult> {
  const out: PushRunResult = { sent: 0, dropped: 0, failed: 0, released: 0, forgotten: 0 };
  const transport = opts.transport === undefined ? configuredPushTransport() : opts.transport;
  const server = serverVapid();
  if (transport === null || server === null) return out;
  if (opts.ids !== undefined && opts.ids.length === 0) return out;
  const deadline = Date.now() + (opts.budgetMs ?? 20_000);

  for (;;) {
    if (deadline - Date.now() < CLAIM_MARGIN_MS) break;
    // A stamp of whole milliseconds, chosen here: it is also this claim's
    // lease, compared exactly when unattempted rows are handed back.
    const stamp = new Date();
    const plan = await claimAndPlan(tenantId, stamp, server, opts.ids);
    out.dropped += plan.dropped;
    if (plan.claimed === 0) break;

    const attempted = new Set<string>();
    const outcomes = await sendAll(plan.sends, transport, deadline, attempted);
    const planned = new Set(plan.sends.map((s) => s.notificationId));
    const unattempted = [...planned].filter((id) => !attempted.has(id));
    for (const [, results] of outcomes) {
      for (const r of results) {
        if (r.kind === "delivered") out.sent += 1;
        else out.failed += 1;
      }
    }
    const finalised = await finalise(tenantId, stamp, outcomes, unattempted);
    out.released += finalised.released;
    out.forgotten += finalised.forgotten;
    // A pass that could not finish its sends ends the call; one that claimed
    // a whole batch goes round again for more.
    if (unattempted.length > 0 || plan.claimed < CLAIM_BATCH) break;
  }
  return out;
}

/**
 * The claim and everything the sends need, in ONE short transaction — reads in
 * sequence (one connection, AGENTS.md's trap). Decryption happens here, a
 * device at a time; encryption of each push happens after, outside it.
 */
async function claimAndPlan(
  tenantId: string,
  stamp: Date,
  server: NonNullable<ReturnType<typeof serverVapid>>,
  ids: readonly string[] | undefined,
): Promise<Plan> {
  return withTenant(tenantId, SYSTEM, async (tx) => {
    const now = new Date();
    const windowStart = new Date(now.getTime() - PUSH_WINDOW_MINUTES * 60_000);
    const only = ids ?? [];
    const claimed = await tx.$queryRaw<ClaimedRow[]>`
      WITH claimed AS (
        UPDATE notification SET pushed_at = ${stamp}
         WHERE tenant_id = ${tenantId}
           AND pushed_at IS NULL
           AND id IN (
             SELECT n.id FROM notification n
              WHERE n.tenant_id = ${tenantId}
                AND n.receiver_type = 'MEMBER'
                AND n.class = 'INSTANT'
                AND n.pushed_at IS NULL
                AND n.kind = ANY(${PUSH_KINDS as string[]}::text[])
                AND n.created_at > ${windowStart}
                AND (cardinality(${only as string[]}::text[]) = 0 OR n.id = ANY(${only as string[]}::text[]))
                AND EXISTS (
                  SELECT 1 FROM push_subscription ps
                   WHERE ps.tenant_id = n.tenant_id
                     AND ps.member_id = n.receiver_id
                     AND ps.vapid_key = ${server.fingerprint})
              ORDER BY n.created_at, n.id
              LIMIT ${CLAIM_BATCH}
              FOR UPDATE SKIP LOCKED)
        RETURNING id, receiver_id, kind, created_at, read_at, archived_at, snoozed_till
      )
      SELECT * FROM claimed ORDER BY created_at, id`;
    if (claimed.length === 0) return { sends: [], claimed: 0, dropped: 0 };

    const memberIds = [...new Set(claimed.map((c) => c.receiver_id))];
    const members = await tx.member.findMany({
      where: { tenantId, id: { in: memberIds } },
      select: { id: true, userId: true, status: true, timezone: true, user: { select: { locale: true } }, tenant: { select: { status: true } } },
    });
    const prefs = await tx.notificationPreference.findMany({
      where: { tenantId, receiverType: "MEMBER", receiverId: { in: memberIds } },
      select: { receiverId: true, pushLevel: true, quietHoursFrom: true, quietHoursTo: true, quietWeekends: true, timezone: true },
    });
    const workspaceZone = (await readPreferences(tx, tenantId)).timezone;
    const prefOf = new Map(prefs.map((p) => [p.receiverId, p]));
    const receivers = new Map<string, PushReceiver & { userId: string; locale: string }>();
    for (const m of members) {
      const pref = prefOf.get(m.id);
      receivers.set(m.id, {
        memberStatus: m.status,
        tenantStatus: m.tenant.status,
        // No row is the schema default (emit's reading of the email level).
        pushLevel: isEmailLevel(pref?.pushLevel) ? pref.pushLevel : "PARTICIPATING",
        quiet: quietHoursOf(pref),
        zone: usableZone(pref?.timezone, m.timezone, workspaceZone),
        userId: m.userId,
        locale: m.user.locale === "sv" ? "sv" : "en",
      });
    }

    // The devices: this server's key, a live sign-in of the member's own user.
    // Read with every OTHER member's row on the same endpoints (in this
    // workspace): one browser profile holds one sign-in, so where two
    // members' rows on one browser both look live (an old session row that
    // outlived its cookie), only the most recently linked is — the design
    // review's L2. A receiver whose row lost that contest gets nothing there.
    const rows = await tx.pushSubscription.findMany({
      where: { tenantId, memberId: { in: memberIds }, vapidKey: server.fingerprint },
      select: { id: true, memberId: true, endpoint: true, keysCiphertext: true, sessionId: true, boundAt: true },
    });
    const rivals = await tx.pushSubscription.findMany({
      where: { tenantId, endpoint: { in: [...new Set(rows.map((r) => r.endpoint))] }, memberId: { notIn: memberIds } },
      select: { id: true, memberId: true, endpoint: true, sessionId: true, boundAt: true },
    });
    const rivalUsers = new Map(
      (
        await tx.member.findMany({
          where: { tenantId, id: { in: [...new Set(rivals.map((r) => r.memberId))] } },
          select: { id: true, userId: true },
        })
      ).map((m) => [m.id, m.userId]),
    );
    const userOf = (memberId: string): string | undefined => receivers.get(memberId)?.userId ?? rivalUsers.get(memberId);
    const sessions = new Map(
      (
        await tx.session.findMany({
          where: {
            id: { in: [...rows, ...rivals].map((r) => r.sessionId) },
            plane: "MEMBER",
            impersonatedBy: null,
            expiresAt: { gt: now },
          },
          select: { id: true, userId: true },
        })
      ).map((s) => [s.id, s.userId]),
    );
    const isLive = (r: { memberId: string; sessionId: string }): boolean => {
      const owner = userOf(r.memberId);
      return owner !== undefined && sessions.get(r.sessionId) === owner;
    };
    const newestOnEndpoint = new Map<string, string>(); // endpoint → the winning row's id
    const newestAt = new Map<string, number>();
    for (const r of [...rows, ...rivals]) {
      if (!isLive(r)) continue;
      const at = newestAt.get(r.endpoint);
      if (at === undefined || r.boundAt.getTime() > at) {
        newestOnEndpoint.set(r.endpoint, r.id);
        newestAt.set(r.endpoint, r.boundAt.getTime());
      }
    }
    const winners = rows.filter((r) => newestOnEndpoint.get(r.endpoint) === r.id);
    const devicesOf = new Map<string, { id: string; endpoint: URL; keys: ReceiverKeys }[]>();
    for (const r of winners) {
      const endpoint = pushEndpointUrl(r.endpoint);
      if (endpoint === null) continue;
      let keys: ReceiverKeys | null = null;
      try {
        const plain = JSON.parse(
          await decryptFieldV2(tx, { tenantId, model: "push_subscription", rowId: r.id, field: "keys" }, r.keysCiphertext),
        ) as { p256dh?: unknown; auth?: unknown };
        keys = typeof plain.p256dh === "string" && typeof plain.auth === "string" ? receiverKeysOf(plain.p256dh, plain.auth) : null;
      } catch (e) {
        console.error(`push: device ${r.id} in tenant ${tenantId} has keys that cannot be read: ${what(e)}`);
      }
      if (keys === null) continue;
      const list = devicesOf.get(r.memberId) ?? [];
      list.push({ id: r.id, endpoint, keys });
      devicesOf.set(r.memberId, list);
    }

    const sends: PlannedSend[] = [];
    let dropped = 0;
    for (const c of claimed) {
      const receiver = receivers.get(c.receiver_id);
      const devices = devicesOf.get(c.receiver_id) ?? [];
      if (!isPushKind(c.kind) || devices.length === 0) {
        dropped += 1;
        continue;
      }
      const note = {
        kind: c.kind as NotificationKind,
        createdAt: c.created_at,
        readAt: c.read_at,
        archivedAt: c.archived_at,
        snoozedTill: c.snoozed_till,
      };
      if (pushVerdict(note, receiver, now).action !== "send" || receiver === undefined) {
        dropped += 1;
        continue;
      }
      const ttlSeconds = pushTtlSeconds(new Date(c.created_at.getTime() + PUSH_WINDOW_MINUTES * 60_000), receiver, now);
      const payload = encodePushPayload(pushPayload(c.id, c.kind, receiver.locale));
      for (const d of devices) {
        sends.push({ notificationId: c.id, deviceId: d.id, endpoint: d.endpoint, keys: d.keys, payload, ttlSeconds, plannedAt: now.getTime() });
      }
    }
    return { sends, claimed: claimed.length, dropped };
  });
}

/**
 * Each push service's sends in turn, the services side by side (M2): one slow
 * vendor holds up only its own devices. Nothing STARTS after the deadline; a
 * notification counts as attempted once any of its sends started.
 */
async function sendAll(
  sends: readonly PlannedSend[],
  transport: PushTransport,
  deadline: number,
  attempted: Set<string>,
): Promise<Map<string, PushOutcome[]>> {
  const outcomes = new Map<string, PushOutcome[]>();
  const byOrigin = new Map<string, PlannedSend[]>();
  for (const s of sends) {
    const list = byOrigin.get(s.endpoint.origin) ?? [];
    list.push(s);
    byOrigin.set(s.endpoint.origin, list);
  }
  const server = serverVapid();
  if (server === null) return outcomes;
  // Not a database transaction: plain network calls, safe side by side.
  await Promise.all(
    [...byOrigin.values()].map(async (queue) => {
      for (const s of queue) {
        if (Date.now() > deadline) return;
        attempted.add(s.notificationId);
        let outcome: PushOutcome;
        // The time this send waited behind others comes off its TTL (the
        // fix-pass review's nit): the bound before quiet hours is a moment, not
        // a duration from whenever the send starts.
        const ttlSeconds = Math.max(0, s.ttlSeconds - Math.ceil((Date.now() - s.plannedAt) / 1000));
        try {
          outcome = await transport(buildPushRequest(server.keys, s.endpoint, s.keys, s.payload, { ttlSeconds }));
        } catch (e) {
          outcome = { kind: "transient", status: null, error: what(e) };
        }
        const list = outcomes.get(s.deviceId) ?? [];
        list.push(outcome);
        outcomes.set(s.deviceId, list);
      }
    }),
  );
  return outcomes;
}

/**
 * The devices' new state, and the claim's unattempted rows handed back, in one
 * short transaction. A finalise that fails leaves the stamps (those buzzes are
 * lost — at most once) and the counts as they were; it is logged.
 *
 * THE REFUSAL COUNT IS NEVER WRITTEN FROM A SNAPSHOT (the code review's low):
 * two drains can hold one device at once (a kick and the sweep), and an
 * absolute value computed at claim time would undo the other's answer. So a
 * device whose answers were all the vendor's trouble is not written at all; a
 * delivery sets the count to the refusals that came AFTER it in this pass (the
 * last real answer was a success); refusals alone INCREMENT it, and the row is
 * forgotten when the count it then holds reaches three.
 *
 * ONE ROW AT A TIME, IN ID ORDER (the fix-pass review's low): two drains that
 * touched the same devices in different orders would otherwise lock them
 * crosswise and deadlock — and the loser's unattempted claims would never be
 * handed back. The closing delete only touches rows this transaction already
 * holds.
 */
async function finalise(
  tenantId: string,
  stamp: Date,
  outcomes: ReadonlyMap<string, readonly PushOutcome[]>,
  unattempted: readonly string[],
): Promise<{ released: number; forgotten: number }> {
  type Act = { id: string } & ({ kind: "gone" } | { kind: "delivered"; refusalsSince: number } | { kind: "refused"; refusals: number });
  const acts: Act[] = [];
  for (const [deviceId, results] of outcomes) {
    if (results.some((r) => r.kind === "gone")) {
      acts.push({ id: deviceId, kind: "gone" });
      continue;
    }
    const lastDelivery = results.map((r) => r.kind).lastIndexOf("delivered");
    const refusalsAfter = results.slice(lastDelivery + 1).filter((r) => r.kind === "refused").length;
    if (lastDelivery >= 0) acts.push({ id: deviceId, kind: "delivered", refusalsSince: refusalsAfter });
    else if (refusalsAfter > 0) acts.push({ id: deviceId, kind: "refused", refusals: refusalsAfter });
    // All transient: the device said nothing about itself — nothing to write.
  }
  acts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  try {
    return await withTenant(tenantId, SYSTEM, async (tx) => {
      const now = new Date();
      let forgotten = 0;
      for (const a of acts) {
        if (a.kind === "gone") {
          forgotten += (await tx.pushSubscription.deleteMany({ where: { tenantId, id: a.id } })).count;
        } else if (a.kind === "delivered") {
          await tx.pushSubscription.updateMany({ where: { tenantId, id: a.id }, data: { failCount: a.refusalsSince, lastSentAt: now } });
        } else {
          await tx.pushSubscription.updateMany({ where: { tenantId, id: a.id }, data: { failCount: { increment: a.refusals } } });
        }
      }
      // Forgotten at three, on the count the rows hold NOW (after any other drain's writes).
      const touched = acts.filter((a) => a.kind !== "gone").map((a) => a.id);
      if (touched.length > 0) {
        forgotten += (
          await tx.pushSubscription.deleteMany({ where: { tenantId, id: { in: touched }, failCount: { gte: REFUSALS_TO_FORGET } } })
        ).count;
      }
      const released =
        unattempted.length === 0
          ? 0
          : await tx.$executeRaw`
              UPDATE notification SET pushed_at = NULL
               WHERE tenant_id = ${tenantId}
                 AND id = ANY(${unattempted as string[]}::text[])
                 AND pushed_at = ${stamp}`;
      return { released, forgotten };
    });
  } catch (e) {
    console.error(`push: finalising a pass in tenant ${tenantId} failed: ${what(e)}`);
    return { released: 0, forgotten: 0 };
  }
}

/**
 * HOUSEKEEPING (SECURITY §10, amended by slice 106): a device whose member is
 * no longer ACTIVE in this workspace (the design review's L5 — removal ends
 * notifications, and the row would otherwise outlive it), and one whose
 * sign-in ended — the session gone or expired — and was not re-linked for
 * `DORMANT_DAYS`. As SYSTEM, no audit (C74 (k)).
 */
export async function forgetStaleDevices(tenantId: string, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - DORMANT_DAYS * 86_400_000);
  return withTenant(tenantId, SYSTEM, (tx) =>
    tx.$executeRaw`
      DELETE FROM push_subscription ps
       WHERE ps.tenant_id = ${tenantId}
         AND (
           NOT EXISTS (
             SELECT 1 FROM member m
              WHERE m.tenant_id = ps.tenant_id AND m.id = ps.member_id AND m.status = 'ACTIVE')
           OR (
             ps.bound_at < ${cutoff}
             AND NOT EXISTS (
               SELECT 1 FROM session s
                WHERE s.id = ps.session_id AND s.expires_at > ${now}))
         )`,
  );
}
