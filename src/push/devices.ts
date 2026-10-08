import { createHash } from "node:crypto";

import { record } from "@/audit/record";
import type { MemberActor } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { deviceLabel } from "@/auth/device-label";
import { pushEndpointUrl } from "@/config";
import { encryptFieldV2 } from "@/crypto/field-encryption";
import { withTenant, type TenantDb } from "@/db";
import { isUuid } from "@/db/context";
import { fail } from "@/lib/domain-error";
import { newId } from "@/lib/ids";
import { allowStrict } from "@/ratelimit";

import { serverVapid } from "./keys";
import { receiverKeysOf } from "./web-push";

/**
 * A MEMBER'S OWN DEVICES FOR PHONE AND BROWSER NOTIFICATIONS (Phase 5 slice
 * 106; founder decision C74). Turned on and removed only on Settings →
 * Notifications (C74 (f)), only by the member themself — the database holds
 * that too (`own_device`: a member reads and writes their own rows, the
 * drain's SYSTEM principal all of them, nobody else any) — and NEVER under
 * impersonation: an operator acting as a member runs as the member's own
 * principal, so the application refuses before the database could tell
 * (the vault door's rule, `door.ts`).
 *
 * WHAT A ROW IS: the push service's endpoint (one of the four vendors —
 * `pushEndpointUrl`, checked here and again before every send), the browser's
 * keys v2-encrypted under the tenant's key with the row's own AAD, the
 * fingerprint of OUR key it subscribed with, a label from the request's user
 * agent ("Chrome · Android" — the browser's own claim, a recognition aid like
 * "Your devices"), and the SESSION it is live under (C74 (d)).
 *
 * THE SESSION IS THE STOP. The drain sends only to a row whose session still
 * exists, is unexpired, is the member's own user's and is not impersonated
 * (`src/jobs/push.ts`). Signing out, "Your devices", an owner's reset and a
 * week unused all end the session; the browser keeps its subscription, so the
 * same person signing in there again re-links the row by itself
 * (`resumePushDevices`, called by the worker's registration on each full page
 * load) — and NOBODY ELSE can: a re-link only ever finds the signed-in
 * member's own row. A re-link writes no audit row (C74 (k)): the sign-in is
 * audited, and nothing anyone sees has changed.
 */

/** More devices than one person uses; past it, remove one first. */
export const MAX_PUSH_DEVICES = 10;

/** The label when the user agent names neither a browser nor a system; the page translates it. */
export const UNKNOWN_DEVICE_LABEL = "unknown";

export type PushSubscriptionInput = {
  readonly endpoint: unknown;
  readonly p256dh: unknown;
  readonly auth: unknown;
};

type CheckedSubscription = { readonly endpoint: string; readonly p256dh: string; readonly auth: string };

const MAX_KEY_TEXT = 200;

/** The browser's subscription, or null when it is nothing a push could be sent to. */
function checked(input: PushSubscriptionInput): CheckedSubscription | null {
  const { endpoint, p256dh, auth } = input;
  if (typeof endpoint !== "string" || typeof p256dh !== "string" || typeof auth !== "string") return null;
  if (p256dh.length > MAX_KEY_TEXT || auth.length > MAX_KEY_TEXT) return null;
  const url = pushEndpointUrl(endpoint);
  if (url === null || receiverKeysOf(p256dh, auth) === null) return null;
  // THE CANONICAL FORM is what is stored and compared (the migration review's
  // low): the parsed URL's `href` — lower-case scheme and host, ASCII, nothing
  // a later parse would strip — so one device is one spelling, and the CHECK
  // (`^https://[!-~]+$`, ≤ 1024 bytes) can never refuse what the app accepted.
  if (url.href.length > 1024 || !/^https:\/\/[!-~]+$/.test(url.href)) return null;
  return { endpoint: url.href, p256dh, auth };
}

const labelOf = (userAgent: string | null): string => {
  const { browser, os } = deviceLabel(userAgent);
  const label = [browser, os].filter((part): part is string => part !== null).join(" · ");
  return label.length > 0 ? label.slice(0, 80) : UNKNOWN_DEVICE_LABEL;
};

/** What the page may know of an endpoint: enough to say "this device", never the address itself. */
export const endpointHash = (endpoint: string): string => createHash("sha256").update(endpoint, "utf8").digest("hex").slice(0, 16);

const keysText = (s: CheckedSubscription): string => JSON.stringify({ p256dh: s.p256dh, auth: s.auth });

const encryptKeys = (tx: TenantDb, tenantId: string, rowId: string, s: CheckedSubscription): Promise<string> =>
  encryptFieldV2(tx, { tenantId, model: "push_subscription", rowId, field: "keys" }, keysText(s));

export type PushDeviceCtx = {
  readonly tenantId: string;
  readonly actor: MemberActor;
  /** The member-plane session making the call — its id, never its token. */
  readonly sessionId: string;
  /** The request's User-Agent, for the label. */
  readonly userAgent: string | null;
};

/**
 * "Turn on for this device." A device this member already has (the same
 * endpoint) is refreshed and re-linked to this sign-in; a new one is added —
 * at most `MAX_PUSH_DEVICES`, twenty turn-ons an hour — and audited
 * (`push_device.added`). The cap is checked inside the transaction but not
 * locked: two turn-ons racing at nine devices may land eleven, which the
 * next one's check then refuses (a soft cap, recorded).
 */
export async function registerPushDevice(ctx: PushDeviceCtx, input: PushSubscriptionInput): Promise<{ readonly id: string }> {
  if (ctx.actor.impersonated) return deny("FORBIDDEN", "impersonation never turns notifications on");
  const server = serverVapid();
  if (server === null) return fail("PUSH_UNAVAILABLE");
  const sub = checked(input);
  if (sub === null) return fail("PUSH_DEVICE_INVALID");
  if (!(await allowStrict("push.register", `${ctx.tenantId}:${ctx.actor.memberId}`))) return fail("PUSH_RATE_LIMITED");

  const { tenantId } = ctx;
  const memberId = ctx.actor.memberId;
  const label = labelOf(ctx.userAgent);
  return withTenant(tenantId, { type: "member", id: memberId }, async (tx) => {
    const now = new Date();
    const refresh = async (id: string): Promise<{ id: string }> => {
      const keysCiphertext = await encryptKeys(tx, tenantId, id, sub);
      await tx.pushSubscription.update({
        where: { id },
        data: { keysCiphertext, vapidKey: server.fingerprint, label, sessionId: ctx.sessionId, boundAt: now, failCount: 0 },
        select: { id: true },
      });
      return { id };
    };
    const existing = await tx.pushSubscription.findFirst({
      where: { tenantId, memberId, endpoint: sub.endpoint },
      select: { id: true },
    });
    if (existing) return refresh(existing.id);

    const held = await tx.pushSubscription.count({ where: { tenantId, memberId } });
    if (held >= MAX_PUSH_DEVICES) return fail("PUSH_DEVICE_LIMIT");
    const id = newId();
    const keysCiphertext = await encryptKeys(tx, tenantId, id, sub);
    // ON CONFLICT DO NOTHING (the design review's nit): a second turn-on of
    // the same browser racing this one inserted first — refresh that row
    // instead (its AAD names ITS id, so the keys are encrypted again).
    const { count } = await tx.pushSubscription.createMany({
      data: [
        { id, tenantId, memberId, endpoint: sub.endpoint, keysCiphertext, vapidKey: server.fingerprint, label, sessionId: ctx.sessionId, boundAt: now },
      ],
      skipDuplicates: true,
    });
    if (count === 0) {
      const raced = await tx.pushSubscription.findFirst({ where: { tenantId, memberId, endpoint: sub.endpoint }, select: { id: true } });
      if (raced === null) return fail("PUSH_DEVICE_INVALID");
      return refresh(raced.id);
    }
    await record(tx, {
      action: "push_device.added",
      targetType: "Member",
      targetId: memberId,
      metadata: { deviceId: id, label },
    });
    return { id };
  });
}

/**
 * The same person signed in again on a browser that had notifications on:
 * re-link THEIR OWN row for this endpoint, in every workspace they are an
 * active member of (the design review's L1), to the session making the call.
 * Never creates a row — a different member signing in on that browser
 * re-links nothing — and only rows made under this server's key. Quiet: no
 * audit (C74 (k)), no rate limit (nothing new is written), no error — it
 * answers how many it re-linked.
 */
export async function resumePushDevices(
  ctx: {
    readonly sessionId: string;
    readonly impersonated: boolean;
    readonly memberships: readonly { readonly tenantId: string; readonly memberId: string }[];
  },
  input: PushSubscriptionInput,
): Promise<number> {
  if (ctx.impersonated) return 0;
  const server = serverVapid();
  const sub = checked(input);
  if (server === null || sub === null) return 0;
  let relinked = 0;
  // In turn: one transaction per workspace, each as that workspace's member.
  for (const m of ctx.memberships) {
    relinked += await withTenant(m.tenantId, { type: "member", id: m.memberId }, async (tx) => {
      const row = await tx.pushSubscription.findFirst({
        where: { tenantId: m.tenantId, memberId: m.memberId, endpoint: sub.endpoint, vapidKey: server.fingerprint },
        select: { id: true, sessionId: true },
      });
      if (row === null || row.sessionId === ctx.sessionId) return 0;
      const keysCiphertext = await encryptKeys(tx, m.tenantId, row.id, sub);
      await tx.pushSubscription.update({
        where: { id: row.id },
        data: { sessionId: ctx.sessionId, boundAt: new Date(), keysCiphertext },
        select: { id: true },
      });
      return 1;
    });
  }
  return relinked;
}

/**
 * "Remove" / "Turn off for this device": the member's own row, audited. Answers
 * the removed device's endpoint (so the caller can tell whether the browser is
 * still in use elsewhere — `endpointHeldElsewhere`), or null when there was none.
 */
export async function removePushDevice(
  ctx: { readonly tenantId: string; readonly actor: MemberActor },
  id: unknown,
): Promise<string | null> {
  if (ctx.actor.impersonated) return deny("FORBIDDEN", "impersonation never changes a member's devices");
  if (typeof id !== "string" || !isUuid(id)) return null;
  const { tenantId } = ctx;
  const memberId = ctx.actor.memberId;
  return withTenant(tenantId, { type: "member", id: memberId }, async (tx) => {
    const row = await tx.pushSubscription.findFirst({ where: { id, tenantId, memberId }, select: { id: true, label: true, endpoint: true } });
    if (row === null) return null;
    await tx.pushSubscription.deleteMany({ where: { id, tenantId, memberId } });
    await record(tx, {
      action: "push_device.removed",
      targetType: "Member",
      targetId: memberId,
      metadata: { deviceId: row.id, label: row.label },
    });
    return row.endpoint;
  });
}

/**
 * Whether the same person still has this browser turned on in another of their
 * workspaces (the code review's low): one origin serves every workspace, so a
 * browser holds ONE subscription for all of them, and turning it off in one
 * must not unsubscribe it from under another. Their OWN rows only — each
 * workspace read as that workspace's member, in turn.
 */
export async function endpointHeldElsewhere(
  memberships: readonly { readonly tenantId: string; readonly memberId: string }[],
  endpoint: string,
): Promise<boolean> {
  for (const m of memberships) {
    const held = await withTenant(m.tenantId, { type: "member", id: m.memberId }, (tx) =>
      tx.pushSubscription.count({ where: { tenantId: m.tenantId, memberId: m.memberId, endpoint } }),
    );
    if (held > 0) return true;
  }
  return false;
}

export type PushDeviceRow = {
  readonly id: string;
  /** "Chrome · Android", or `UNKNOWN_DEVICE_LABEL`. */
  readonly label: string;
  readonly createdAt: Date;
  readonly lastSentAt: Date | null;
  /** `endpointHash` — the page tells "this device" by hashing its own endpoint the same way. */
  readonly endpointHash: string;
  /** Its sign-in is alive: it gets notifications. False: signed out there, waiting for the same person to sign in again. */
  readonly signedIn: boolean;
};

/** The member's own devices, newest first. */
export async function listOwnPushDevices(ctx: {
  readonly tenantId: string;
  readonly actor: MemberActor;
  readonly userId: string;
}): Promise<PushDeviceRow[]> {
  const { tenantId } = ctx;
  const memberId = ctx.actor.memberId;
  return withTenant(tenantId, { type: "member", id: memberId }, async (tx) => {
    const rows = await tx.pushSubscription.findMany({
      where: { tenantId, memberId },
      select: { id: true, label: true, endpoint: true, sessionId: true, createdAt: true, lastSentAt: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: MAX_PUSH_DEVICES * 2,
    });
    // In sequence after the read above (one transaction, one connection).
    const alive = new Set(
      (
        await tx.session.findMany({
          where: {
            id: { in: rows.map((r) => r.sessionId) },
            userId: ctx.userId,
            plane: "MEMBER",
            impersonatedBy: null,
            expiresAt: { gt: new Date() },
          },
          select: { id: true },
        })
      ).map((s) => s.id),
    );
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      createdAt: r.createdAt,
      lastSentAt: r.lastSentAt,
      endpointHash: endpointHash(r.endpoint),
      signedIn: alive.has(r.sessionId),
    }));
  });
}
