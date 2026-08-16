import { notFound } from "next/navigation";
import { cache } from "react";

import { AuthzError } from "@/authz/errors";
import { handleAuthzRedirect } from "@/authz/redirects";
import { getClient, type ClientDetail } from "@/clients/service";
import { requireTenantContext } from "@/members/tenant-context";

/**
 * Per-request memoised client detail shared by the [id] layout and its
 * tab pages (one service call, one set of scope checks). Out of scope
 * or missing ⇒ 404 — never 403 (UI.md §7.3, AUTHZ.md §4). A missing
 * permission also renders 404: the nav hides the entry, and a direct
 * URL must not confirm the client exists.
 */
export const loadClient = cache(async (clientId: string): Promise<ClientDetail> => {
  const { membership, actor } = await requireTenantContext();
  try {
    return await getClient({ tenantId: membership.tenantId, actor }, clientId);
  } catch (e) {
    handleAuthzRedirect(e, `/clients/${clientId}`);
    if (e instanceof AuthzError) notFound();
    throw e;
  }
});
