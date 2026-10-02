import { generateCredentialTotp } from "@/modules/vault";

import { vaultPost } from "../../respond";

/**
 * POST /api/vault/[id]/totp → `{ code, period, msLeft }` — the CURRENT
 * code, generated on the server from the stored seed (never returned);
 * audited `credential.totp_generated`. One code per press: a countdown that
 * fetched the next code by itself would spend the member's reveal budget
 * twice a minute (slice 82's note), so the page never refreshes it.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return vaultPost(request, params, async (ctx, id) => {
    const { code, validUntil, period } = await generateCredentialTotp(ctx, id);
    // How long the code has left, on THIS clock: the browser lays it on its
    // own from when the answer arrived, so two clocks never meet.
    return { code, period, msLeft: Math.max(0, validUntil.getTime() - Date.now()) };
  });
}
