import { record } from "@/audit/record";
import type { MemberActor } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { withTenant } from "@/db";
import { isTimezone } from "@/preferences/config";

/**
 * A member's OWN profile fields on the Member row (Member.timezone …).
 * No permission code: a member always owns these — the row is pinned to
 * the acting member id (never a form parameter), so nobody edits
 * anybody else's here. Audited as member.profile_updated with the field
 * names only.
 */
export async function setOwnTimezone(
  ctx: { tenantId: string; actor: MemberActor },
  timezone: string | null,
): Promise<void> {
  if (timezone !== null && !isTimezone(timezone)) deny("FORBIDDEN", "unknown timezone");
  await withTenant(ctx.tenantId, { type: "member", id: ctx.actor.memberId }, async (tx) => {
    const me = await tx.member.findFirst({
      where: { id: ctx.actor.memberId, status: "ACTIVE" },
      select: { id: true, timezone: true },
    });
    if (!me) deny("NOT_FOUND");
    if (me!.timezone === timezone) return;
    await tx.member.update({ where: { id: me!.id }, data: { timezone } });
    await record(tx, {
      action: "member.profile_updated",
      targetType: "Member",
      targetId: me!.id,
      metadata: { fields: ["timezone"] },
    });
  });
}
