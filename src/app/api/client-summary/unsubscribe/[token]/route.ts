import { NextResponse } from "next/server";

import { appUrl } from "@/config";
import { setClientSummary } from "@/notify/client-summary";
import { readClientSummaryToken } from "@/notify/client-summary-token";
import { allowStrict } from "@/ratelimit";

/**
 * THE CLIENTS' WEEKLY SUMMARY'S ONE-CLICK UNSUBSCRIBE (Phase 5 slice 101;
 * founder decision C69; RFC 8058) — the address in the mail's
 * `List-Unsubscribe` header.
 *
 * **POST STOPS IT**, with no person in front of it: a mailbox provider sends
 * `List-Unsubscribe=One-Click` here when the reader presses its own
 * Unsubscribe button, and RFC 8058 §3.2 says that must work without a
 * cookie, a redirect or a page. The body is REQUIRED to say exactly that
 * (urlencoded or multipart, as §3.1 allows), so a POST that is not a
 * provider's one-click — a scanner's, a stray form's — changes nothing. A
 * stop answers an empty 200, as does a link whose signature holds but whose
 * person is gone (there is nothing left to stop, and a provider shown an
 * error might keep the mail flowing in its own eyes); a forged link is a 404.
 *
 * **GET CHANGES NOTHING**: a client that cannot POST opens the header's
 * address in a browser instead (RFC 2369), and a scanner opens every address
 * it sees — so a GET with a well-formed token is sent to the page that asks
 * (`/portal/unsubscribe/<token>`), and anything else is a 404.
 *
 * **PUBLIC BY A PREFIX EXEMPTION** (`CLIENT_SUMMARY_API_PREFIX`,
 * src/proxy.ts). The token is checked BEFORE the database or the limiter is
 * touched — a forged one costs one HMAC — and a real one is limited per
 * PERSON, never per network (the design review's medium): a provider's
 * POSTs for every reader come from a few of its own servers, and a
 * per-network limit would refuse a real unsubscribe while telling the reader
 * it worked.
 */

const empty = (status: number): Response =>
  new NextResponse(null, { status, headers: { "Cache-Control": "no-store" } });

const ONE_CLICK = "One-Click";

/** Does the body say `List-Unsubscribe=One-Click`? Anything unreadable says no. */
async function isOneClick(request: Request): Promise<boolean> {
  try {
    const form = await request.formData();
    return form.get("List-Unsubscribe") === ONE_CLICK;
  } catch {
    return false;
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  const who = readClientSummaryToken(token);
  if (who === null) return empty(404);
  if (!(await isOneClick(request))) return empty(400);
  if (!(await allowStrict("mail.client_summary_one_click", `${who.tenantId}:${who.contactId}`))) return empty(429);
  await setClientSummary(token, false, "one_click");
  return empty(200);
}

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params;
  if (readClientSummaryToken(token) === null) return empty(404);
  return NextResponse.redirect(new URL(`/portal/unsubscribe/${token}`, appUrl), {
    status: 303,
    headers: { "Cache-Control": "no-store" },
  });
}
