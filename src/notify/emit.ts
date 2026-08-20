import { randomUUID } from "node:crypto";

import type { TenantDb } from "@/db";
import { NOTIFICATION_KINDS, type NotificationKind } from "./catalog";

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
 * - dedupeKey collapses repeats while an unread row with the same key
 *   exists for the receiver.
 * - Suppressed addresses and emailLevel=NONE receivers get no outbox
 *   row (the worker re-checks suppression at send).
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
      id: randomUUID(),
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

  // Email enqueue: resolve address + locale per member, honour
  // emailLevel=NONE and the global suppression list.
  const members = await tx.member.findMany({
    where: { tenantId, id: { in: targets } },
    select: { id: true, user: { select: { email: true, locale: true } } },
  });
  const prefs = await tx.notificationPreference.findMany({
    where: { tenantId, receiverType: "MEMBER", receiverId: { in: targets } },
    select: { receiverId: true, emailLevel: true },
  });
  const noEmail = new Set(prefs.filter((p) => p.emailLevel === "NONE").map((p) => p.receiverId));
  const emails = members
    .filter((m) => !noEmail.has(m.id) && m.user.email)
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
