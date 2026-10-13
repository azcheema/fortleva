import type { NextRequest } from "next/server";

import { absoluteUrl, FORTNOX_CALLBACK_PATH, fortnoxTransportKind } from "@/config";
import { fakeConsent, isFakeTenantId } from "@/integrations/fortnox/fake";
import { isStateShape } from "@/integrations/fortnox/pkce";
import { requireTenantContext } from "@/members/tenant-context";

/**
 * GET /settings/invoicing/fortnox/fake-consent — THE FAKE FORTNOX's consent
 * screen (Phase 4 slice 114), answering ONLY under `FORTNOX_TRANSPORT=fake`
 * (which `src/config` refuses on a production build off loopback); a 404
 * otherwise. It stands where Fortnox's own screen stands: it makes the
 * workspace's fake company on first sight and sends the browser straight back
 * to the callback with a code bound to the PKCE challenge — or with
 * `error=access_denied` when a test set the company to deny.
 */
export async function GET(request: NextRequest): Promise<Response> {
  if (fortnoxTransportKind !== "fake") return new Response(null, { status: 404 });
  // A signed-in member only, as at Fortnox's own screen (the security review's nit 6).
  await requireTenantContext();
  const q = request.nextUrl.searchParams;
  const state = q.get("state");
  const challenge = q.get("code_challenge") ?? "";
  const company = q.get("company") ?? "";
  const name = (q.get("name") ?? "").slice(0, 200);
  const org = (q.get("org") ?? "").slice(0, 20);
  if (!isStateShape(state) || !/^[A-Za-z0-9_-]{43}$/.test(challenge) || !isFakeTenantId(company) || name === "") {
    return new Response("invalid consent request", { status: 400 });
  }
  const answer = fakeConsent({ companyTenantId: company, name, orgNr: org, codeChallenge: challenge });
  const back = new URL(absoluteUrl(FORTNOX_CALLBACK_PATH));
  back.searchParams.set("state", state);
  if ("code" in answer) back.searchParams.set("code", answer.code);
  else back.searchParams.set("error", answer.error);
  return new Response(null, { status: 303, headers: { Location: back.toString(), "Cache-Control": "no-store" } });
}
