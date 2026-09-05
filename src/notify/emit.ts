import type { TenantDb } from "@/db";
import { newId } from "@/lib/ids";
import { NOTIFICATION_KINDS, emailAllowed, isEmailLevel, type NotificationKind } from "./catalog";

/**
 * notify.emit — THE one fan-out seam (§6.18): called inside the same
 * withTenant transaction as the write it describes. Inserts
 * Notification rows and, for INSTANT kinds, EmailOutbox rows; the
 * worker (src/jobs/outbox.ts) drains the outbox after commit.
 *
 * Hard rules this function owns:
 * - `params` carries IDS ONLY — rendering happens later, from live
 *   rows, under the RECEIVER's principal. Never put a name, a title or
 *   any free text in params.
 * - INSERTs use createMany, never create: the notification RLS binds
 *   SELECT to the receiver, so INSERT..RETURNING for another receiver
 *   would be rejected (principal_scope; see the migration).
 * - The actor never notifies themself.
 * - Row ids are UUIDv7 (`newId()`), because the inbox pages on them.
 * - dedupeKey collapses repeats while an unread row with the same key
 *   exists for the receiver.
 * - Suppressed addresses get no outbox row (the worker re-checks
 *   suppression at send).
 * - `NotificationPreference.emailLevel` is honoured per RECEIVER and
 *   per KIND through the catalog's level ladder: each emailing kind
 *   names the weakest level that still gets it, so MENTIONS mails a
 *   mention and not an assignment. A receiver with no preference row
 *   gets the schema default, PARTICIPATING — the same answer the column
 *   would give, so an unwritten row and a written default are the same
 *   thing here. The IN-APP row is never gated: an assignment you cannot
 *   see is work you never find out about, and the inbox is the surface
 *   the emails are only a pointer to.
 */

export type EmitInput = {
  readonly kind: NotificationKind;
  readonly entity: { readonly type: string; readonly id: string };
  readonly actorMemberId?: string;
  readonly clientId?: string;
  readonly projectId?: string;
  /** Member receivers (contact receivers arrive with Phase 3). */
  readonly memberIds: readonly string[];
  /** IDS ONLY (zod-checked shape per kind lands with more kinds). */
  readonly params?: Readonly<Record<string, string>>;
  readonly dedupeKey?: string;
};

export async function emit(tx: TenantDb, tenantId: string, input: EmitInput): Promise<void> {
  const spec = NOTIFICATION_KINDS[input.kind];
  const receivers = [...new Set(input.memberIds)].filter((id) => id !== input.actorMemberId);
  if (receivers.length === 0) return;

  // Dedupe is a DB constraint (notification_dedupe_unread partial
  // unique), NOT an app pre-check: emit runs under the ACTOR's
  // principal and principal_scope deliberately hides the receiver's
  // rows from it. Per-receiver createMany+skipDuplicates tells us —
  // via the count — whether THIS receiver's row landed, which also
  // gates the email enqueue. Receiver lists are small (assignment: 1,
  // mentions: a handful), so the loop is fine.
  const targets: string[] = [];
  const byMember = new Map<string, string>(); // receiverId → inserted notification id
  for (const receiverId of receivers) {
    const row = {
      // UUIDv7, like every other service that must know an id before
      // insert — NOT randomUUID(). The id is the inbox's pagination key
      // (src/notify/inbox.ts): v7 carries the creation millisecond, so
      // it is a total order that survives the round trip through a JS
      // Date, which `created_at` at microsecond precision does not.
      id: newId(),
      tenantId,
      receiverType: "MEMBER" as const,
      receiverId,
      clientId: input.clientId ?? null,
      projectId: input.projectId ?? null,
      kind: input.kind,
      class: spec.class,
      entityType: input.entity.type,
      entityId: input.entity.id,
      actorType: input.actorMemberId ? ("MEMBER" as const) : null,
      actorId: input.actorMemberId ?? null,
      params: input.params ?? undefined,
      dedupeKey: input.dedupeKey ?? null,
    };
    const { count } = await tx.notification.createMany({ data: [row], skipDuplicates: true });
    if (count === 1) {
      targets.push(receiverId);
      byMember.set(receiverId, row.id);
    }
  }
  if (targets.length === 0 || spec.class !== "INSTANT") return;

  // Email enqueue: resolve address + locale per member, honour the
  // receiver's emailLevel for THIS kind, and the global suppression list.
  const members = await tx.member.findMany({
    where: { tenantId, id: { in: targets } },
    select: { id: true, user: { select: { email: true, locale: true } } },
  });
  const prefs = await tx.notificationPreference.findMany({
    where: { tenantId, receiverType: "MEMBER", receiverId: { in: targets } },
    select: { receiverId: true, emailLevel: true },
  });
  // The schema default, restated here because "no row" and "a row with
  // the default" must answer identically — a member who has never
  // opened the settings page has not chosen silence.
  const levelOf = new Map(
    prefs.map((p) => [p.receiverId, isEmailLevel(p.emailLevel) ? p.emailLevel : "PARTICIPATING"]),
  );
  const emails = members
    .filter((m) => m.user.email && emailAllowed(levelOf.get(m.id) ?? "PARTICIPATING", input.kind))
    .map((m) => ({ memberId: m.id, email: m.user.email.toLowerCase(), locale: m.user.locale ?? "en" }));
  if (emails.length === 0) return;

  const suppressed = new Set(
    (
      await tx.emailSuppression.findMany({
        where: { email: { in: emails.map((e) => e.email) } },
        select: { email: true },
      })
    ).map((s) => s.email),
  );
  const sendAfter = new Date(Date.now() + (spec.email?.debounceMinutes ?? 0) * 60_000);
  const outbox = emails
    .filter((e) => !suppressed.has(e.email) && byMember.has(e.memberId))
    .map((e) => ({
      tenantId,
      idempotencyKey: `${input.kind}:${byMember.get(e.memberId)!}`,
      receiverType: "MEMBER" as const,
      receiverId: e.memberId,
      toEmail: e.email,
      kind: input.kind,
      locale: e.locale === "sv" ? "sv" : "en",
      params: input.params ?? undefined,
      notificationIds: [byMember.get(e.memberId)!],
      sendAfter,
    }));
  if (outbox.length > 0) {
    await tx.emailOutbox.createMany({ data: outbox, skipDuplicates: true });
  }
}
