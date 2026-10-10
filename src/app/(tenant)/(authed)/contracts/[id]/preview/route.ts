import type { NextRequest } from "next/server";

import { isUuid } from "@/db/context";
import { badRequest, crossSiteRefusal, downloadFailure, fileResponse } from "@/lib/http-download";
import { requireTenantContext } from "@/members/tenant-context";
import { contractPreviewPdf } from "@/modules/contracts";

/**
 * GET /contracts/<id>/preview (Phase 4 slice 112) — a DRAFT's preview PDF,
 * drawn now and never stored (`contractPreviewPdf`, which checks
 * `contract:view` and the client's scope). Tenant and member from the
 * session, never the URL; a same-origin attachment, `no-store` (ARC-25).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const refused = crossSiteRefusal(request);
  if (refused) return refused;
  const { id } = await params;
  if (!isUuid(id)) return badRequest("contract");
  const { membership, actor } = await requireTenantContext();
  try {
    const pdf = await contractPreviewPdf({ tenantId: membership.tenantId, actor }, id);
    return fileResponse(pdf.bytes, pdf.fileName, "application/pdf");
  } catch (e) {
    return downloadFailure(e, `/contracts/${id}`);
  }
}
