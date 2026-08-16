import { notFound } from "next/navigation";
import { cache } from "react";

import { AuthzError } from "@/authz/errors";
import { handleAuthzRedirect } from "@/authz/redirects";
import { requireTenantContext } from "@/members/tenant-context";
import { getProjectByKey, type ProjectDetail } from "@/projects/service";

/**
 * Per-request memoised project detail shared by the [key] layout and its
 * tab pages. Out of scope, missing, or no permission ⇒ 404 (UI.md §7.3).
 */
export const loadProject = cache(async (key: string): Promise<ProjectDetail> => {
  const { membership, actor } = await requireTenantContext();
  try {
    return await getProjectByKey({ tenantId: membership.tenantId, actor }, key);
  } catch (e) {
    handleAuthzRedirect(e, `/projects/${key}`);
    if (e instanceof AuthzError) notFound();
    throw e;
  }
});
