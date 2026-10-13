import type { NextRequest } from "next/server";

import { AuthzError } from "@/authz/errors";
import { handleAuthzRedirect } from "@/authz/redirects";
import { absoluteUrl } from "@/config";
import { DomainError } from "@/lib/domain-error";
import { requireTenantContext } from "@/members/tenant-context";
import { completeFortnoxConnect } from "@/modules/invoicing";

/**
 * GET /settings/invoicing/fortnox/callback — where Fortnox's consent screen
 * sends the administrator back (Phase 4 slice 114; founder decision C89; the
 * redirect URI registered in Fortnox's developer portal, built in
 * `src/config`). The member's own session (the top-level redirect carries its
 * `SameSite=Lax` cookie) and the attempt the `state` names — single use, ten
 * minutes, this member's, in this workspace — are the whole of its trust
 * (`completeFortnoxConnect`). It is a GET with an effect because OAuth's
 * callback is one; a refresh of it finds the attempt spent.
 *
 * It answers with a redirect to the Fortnox card carrying ONLY the attempt's
 * id: the card reads the outcome from the viewer's own attempt row, so a link
 * someone else made can never paint a banner (the design review's S9), and
 * nothing Fortnox said ever travels in a URL. A callback that finds no attempt
 * (ran out of time, already used, not this member's) carries a fixed flag
 * instead, `?fortnox=expired`, whose note says only "press Connect again" —
 * no data, so nothing for a forged link to say (the code review's 2).
 */
export async function GET(request: NextRequest): Promise<Response> {
  const { membership, actor } = await requireTenantContext();
  const q = request.nextUrl.searchParams;
  const to = new URL(absoluteUrl("/settings/invoicing"));
  try {
    const done = await completeFortnoxConnect(
      { tenantId: membership.tenantId, actor },
      { state: q.get("state"), code: q.get("code"), error: q.get("error") },
    );
    if (done.attemptId) to.searchParams.set("attempt", done.attemptId);
    else to.searchParams.set("fortnox", "expired");
  } catch (e) {
    // A stale factor: the step-up, then back to the card (Connect again).
    handleAuthzRedirect(e, "/settings/invoicing");
    if (!(e instanceof AuthzError) && !(e instanceof DomainError)) throw e;
  }
  to.hash = "fortnox";
  return new Response(null, { status: 303, headers: { Location: to.toString(), "Cache-Control": "no-store" } });
}
