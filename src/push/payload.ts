import { NOTIFICATION_KINDS, emailAllowed, isNotificationKind, type EmailLevelValue, type NotificationKind } from "@/notify/catalog";
import { GENERIC_COPY_KEY, KIND_MESSAGE_KEY } from "@/notify/kind-copy";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";

/**
 * WHAT A PHONE NOTIFICATION SAYS (Phase 5 slice 106; founder decision C74 (a)):
 * WHAT HAPPENED, NEVER A NAME. The body is the inbox's own line for the kind
 * (`inbox.kind.*` — "A task was assigned to you", "A client sent a request"),
 * which names no task, client, project or person by construction: anyone near
 * a phone reads its lock screen. `payload.test.ts` pins every push kind's line in
 * both languages against the names that could leak into one (no ICU argument
 * at all — a line with `{…}` would be filled with SOMETHING).
 *
 * The title is the product's name, not the workspace's: a workspace name is the
 * agency's, but C74 (a) is "never a name", and one fixed title cannot drift.
 *
 * The tap opens `/inbox/open/<id>` (`src/app/(tenant)/(authed)/inbox/open/[id]`),
 * which re-resolves the notification for whoever is signed in — so the payload
 * carries an id, never a destination someone else's access decided.
 *
 * The whole payload is encrypted end to end for the device (RFC 8291,
 * `./web-push.ts`): the push service carries it and cannot read it.
 */

export const PUSH_PAYLOAD_VERSION = 1;

/** The tap's destination for one notification — the worker accepts only this shape. */
export const pushOpenPath = (notificationId: string): string => `/inbox/open/${notificationId}`;

export type PushPayload = {
  readonly v: typeof PUSH_PAYLOAD_VERSION;
  /** The notification id: the worker's `tag`, so a repeat replaces rather than stacks. */
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly url: string;
};

/**
 * Kinds that push although they send no work email, at any phone level but
 * Nothing (founder decision C74 (i)): the owners' security alarm — repeated
 * failed attempts to open a client's logins (slice 99). Its mail is the alarm's
 * own security notice (`door-alarm.ts`), which goes whatever the email level;
 * the phone keeps the one setting a person can always use to be left alone.
 */
const PUSH_AT_ANY_LEVEL: ReadonlySet<NotificationKind> = new Set<NotificationKind>(["contact.logins_alarm"]);

/**
 * The kinds that may push: every kind that may EMAIL (C74 — `isWorkMail`'s
 * set: INSTANT with an email block), and the alarm above.
 */
export const isPushKind = (kind: string): kind is NotificationKind =>
  isNotificationKind(kind) &&
  NOTIFICATION_KINDS[kind].class === "INSTANT" &&
  (NOTIFICATION_KINDS[kind].email !== undefined || PUSH_AT_ANY_LEVEL.has(kind));

/** Every kind that may push, for the drain's claim. */
export const PUSH_KINDS: readonly NotificationKind[] = (Object.keys(NOTIFICATION_KINDS) as NotificationKind[]).filter(isPushKind);

/**
 * Whether the member's PHONE level (C74 (b)) lets this kind through: Nothing
 * stops everything; a work kind climbs the email ladder (`emailAllowed` — the
 * same four steps, read on the phone's own setting); the alarm goes at any
 * other level.
 */
export function pushAllowed(level: EmailLevelValue, kind: NotificationKind): boolean {
  if (level === "NONE") return false;
  if (PUSH_AT_ANY_LEVEL.has(kind)) return true;
  return NOTIFICATION_KINDS[kind].email !== undefined && emailAllowed(level, kind);
}

const catalogueFor = (locale: string) => (locale === "sv" ? sv : en);

export function pushPayload(notificationId: string, kind: string, locale: string): PushPayload {
  const messages = catalogueFor(locale);
  const key = Object.hasOwn(KIND_MESSAGE_KEY, kind) ? KIND_MESSAGE_KEY[kind as NotificationKind] : GENERIC_COPY_KEY;
  return {
    v: PUSH_PAYLOAD_VERSION,
    id: notificationId,
    title: messages.push.title,
    body: messages.inbox.kind[key],
    url: pushOpenPath(notificationId),
  };
}

export const encodePushPayload = (payload: PushPayload): Buffer => Buffer.from(JSON.stringify(payload), "utf8");
