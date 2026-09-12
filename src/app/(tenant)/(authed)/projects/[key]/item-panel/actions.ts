"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireTenantContext } from "@/members/tenant-context";
import { updateItemDescription, type DescriptionSaved } from "@/modules/work";
import { runAction, type ActionResult } from "@/lib/server-actions";

/**
 * The item panel's server actions. Tenant and member come from
 * `requireTenantContext()`, never from the caller — and the DOCUMENT is
 * whatever the browser sent, so the service's normaliser decides what is
 * stored (src/lib/rich-text/normalize.ts), not a schema here. A shape
 * check still runs on the two identifiers, which ARE addresses.
 */

const Save = z.object({
  itemId: z.uuid(),
  projectKey: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,7}$/),
  /** 32 hex characters — the token the panel handed this editor. */
  baseToken: z.string().regex(/^[0-9a-f]{32}$/),
});

export async function saveDescriptionAction(input: {
  itemId: string;
  projectKey: string;
  doc: unknown;
  baseToken: string;
}): Promise<ActionResult<DescriptionSaved>> {
  const { membership, actor } = await requireTenantContext();
  const parsed = Save.safeParse(input);
  const key = parsed.success ? parsed.data.projectKey : "";
  return runAction(`/projects/${key}`, async () => {
    if (!parsed.success) throw new Error("invalid description save input");
    const saved = await updateItemDescription(
      { tenantId: membership.tenantId, actor },
      parsed.data.itemId,
      { doc: input.doc, baseToken: parsed.data.baseToken },
    );
    // ONLY the board. Its cards carry the checklist badge this write
    // changes (board.tsx), so it would otherwise show a stale n/m.
    //
    // NOT the backlog: its table renders no checklist and no description,
    // so revalidating it bought nothing and evicted the member's
    // prefetch cache on a field that saves every two seconds.
    //
    // NOT the item page either — and this is the fix, not an omission.
    // `revalidatePath('/projects/ACME/items/[number]', 'page')` mixes a
    // RESOLVED segment with a bracket placeholder, which matches no
    // route and no cache tag: it was a silent no-op that read as
    // coverage. The page is dynamic, so a real navigation re-renders it
    // from the row regardless, and the editor already holds the newer
    // document than any cache could.
    revalidatePath(`/projects/${key}/board`);
    return saved;
  });
}
