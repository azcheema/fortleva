"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { runAction, type ActionResult } from "@/lib/server-actions";
import { requireTenantContext } from "@/members/tenant-context";
import {
  MAX_INBOX_IDS,
  archive,
  markAllRead,
  markRead,
  markUnread,
  snooze,
  unarchive,
  unsnooze,
  type InboxCtx,
} from "@/notify/inbox";

/**
 * Thin server actions for `/inbox`: parse → call the inbox service →
 * revalidate. Tenant and member come from `requireTenantContext()`,
 * never from the form — and the RECEIVER is always that member, which
 * is why no action takes one: a notification you may act on is one the
 * `principal_scope` RLS policy already agreed is yours.
 *
 * EVERY EXPORT IS AN `async function` DECLARATION, not a const arrow.
 * A `"use server"` module may only export async functions, and the
 * compiler — not `tsc` — is what enforces it: an exported arrow was
 * accepted by typecheck and lint and then failed `pnpm build` with
 * "export was not found in module".
 */

const idList = z.array(z.uuid()).min(1).max(MAX_INBOX_IDS);

const ctxOf = async (): Promise<InboxCtx> => {
  const { membership, actor } = await requireTenantContext();
  return { tenantId: membership.tenantId, actor };
};

/** The badge lives in the member-plane layout, so an inbox write
 * invalidates the whole segment, not just the list. */
const revalidate = () => revalidatePath("/inbox", "layout");

type Changed = { changed: number };

/** A client-side shape failure gets the same translated string the
 * service's own `INVALID_INPUT` would produce — never a raw code. */
const invalidInput = async (): Promise<ActionResult<never>> => {
  const t = await getTranslations("domainErrors");
  return { ok: false, message: t("INVALID_INPUT") };
};

const run = async (
  ids: unknown,
  verb: (ctx: InboxCtx, ids: readonly string[]) => Promise<number>,
): Promise<ActionResult<Changed>> => {
  const parsed = idList.safeParse(ids);
  if (!parsed.success) return invalidInput();
  const ctx = await ctxOf();
  const r = await runAction("/inbox", async () => ({ changed: await verb(ctx, parsed.data) }));
  if (r.ok) revalidate();
  return r;
};

export async function markReadAction(ids: string[]): Promise<ActionResult<Changed>> {
  return run(ids, markRead);
}

export async function markUnreadAction(ids: string[]): Promise<ActionResult<Changed>> {
  return run(ids, markUnread);
}

export async function archiveAction(ids: string[]): Promise<ActionResult<Changed>> {
  return run(ids, archive);
}

export async function unarchiveAction(ids: string[]): Promise<ActionResult<Changed>> {
  return run(ids, unarchive);
}

export async function unsnoozeAction(ids: string[]): Promise<ActionResult<Changed>> {
  return run(ids, unsnooze);
}

/**
 * The instant is computed by the browser and validated by the service
 * (see `snooze`): "tomorrow morning" is a question about the member's
 * own wall clock, and `Member.timezone` is routinely empty.
 */
export async function snoozeAction(ids: string[], tillIso: string): Promise<ActionResult<Changed>> {
  const parsed = idList.safeParse(ids);
  const till = z.iso.datetime().safeParse(tillIso);
  if (!parsed.success || !till.success) return invalidInput();
  const ctx = await ctxOf();
  const r = await runAction("/inbox", async () => ({
    changed: await snooze(ctx, parsed.data, new Date(till.data)),
  }));
  if (r.ok) revalidate();
  return r;
}

export async function markAllReadAction(): Promise<ActionResult<Changed>> {
  const ctx = await ctxOf();
  const r = await runAction("/inbox", async () => ({ changed: await markAllRead(ctx) }));
  if (r.ok) revalidate();
  return r;
}
