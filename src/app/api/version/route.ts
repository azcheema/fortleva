import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { AuthzError } from "@/authz/errors";
import { requireTenantContext } from "@/members/tenant-context";
import { projectWorkVersion } from "@/modules/work";

/**
 * GET /api/version?scope=project:<id> — the freshness poll (ARC-18).
 * Returns a content-free token that changes whenever the project's work
 * items or states are written; the board/backlog compares it with the
 * one it rendered and calls `router.refresh()` on a difference. Tenant
 * and member come from the session; the service applies the same
 * `work_item:view` + scope check as the list, so an out-of-scope project
 * is 404 — the poll cannot probe existence. `no-store` per ARC-25, and
 * the worker is network-only for `/api/*`.
 */
const SCOPE = /^project:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

const json = (body: unknown, status = 200): NextResponse =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

export async function GET(request: NextRequest): Promise<Response> {
  const scope = request.nextUrl.searchParams.get("scope") ?? "";
  const match = SCOPE.exec(scope);
  if (!match) return json({ error: "scope" }, 400);
  const { membership, actor } = await requireTenantContext();
  try {
    const version = await projectWorkVersion({ tenantId: membership.tenantId, actor }, match[1]!);
    return json({ version });
  } catch (e) {
    if (e instanceof AuthzError) return json({ error: "not_found" }, 404);
    throw e;
  }
}
