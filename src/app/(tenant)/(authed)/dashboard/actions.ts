"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { switchActiveTenant } from "@/auth/active-tenant";
import { requireMemberSession } from "@/auth/session";

const schema = z.object({ tenantId: z.uuid() });

/**
 * Choose a workspace from the picker (UI.md rule 8).
 *
 * The tenant IS the parameter here, which is the one place the standing
 * rule "server actions derive tenant and member from
 * `requireTenantContext()`, never from form parameters" reads oddly — so
 * to be exact about why this is not a breach: the parameter is never
 * TRUSTED. The USER comes from the session cookie as always, and
 * `switchActiveTenant` matches the posted id against the memberships RLS
 * returns for that user before it writes anything. A forged or stale id
 * writes nothing and lands back on the picker. `requireTenantContext`
 * could not be used to decide this: its whole job is to resolve the ONE
 * active workspace, which is the thing being changed.
 *
 * A POST, not a link, for the same reason: Next PREFETCHES `<Link>`s, so
 * a GET that switched workspaces would fire on hover.
 *
 * `revalidatePath("/", "layout")` because every cached segment in the
 * router now belongs to the wrong workspace — the same sweep
 * `setLocaleAction` does for a change of identity.
 */
export async function switchWorkspaceAction(formData: FormData): Promise<void> {
  const session = await requireMemberSession();
  const parsed = schema.safeParse({ tenantId: formData.get("tenantId") });
  if (!parsed.success) redirect("/dashboard?notice=unavailable");

  // Already there: no write, no router sweep, no redirect chain. The
  // current row is a submit like every other (one affordance, not two),
  // so this is the common accidental click, and `revalidatePath("/",
  // "layout")` is an expensive no-op to hand it.
  const pointer = (session.session as { activeTenantId?: string | null }).activeTenantId;
  if (pointer === parsed.data.tenantId) redirect("/home");

  const result = await switchActiveTenant({
    sessionId: session.session.id,
    userId: session.user.id,
    tenantId: parsed.data.tenantId,
  });
  // The membership went away or was suspended between the render and the
  // click. Back to the picker, which now shows that truth, with a notice
  // — never a silent landing somewhere the member did not choose.
  if (result !== "ok") redirect("/dashboard?notice=unavailable");

  revalidatePath("/", "layout");
  redirect("/home");
}
