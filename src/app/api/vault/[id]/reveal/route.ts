import { revealCredentialField } from "@/modules/vault";

import { vaultFieldPost } from "../../respond";

/**
 * POST /api/vault/[id]/reveal `{ field }` → `{ value }` — show ONE secret
 * field (`credential:reveal` ✦, the vault window, the budget; audited
 * `credential.revealed` by the service). `respond.ts` holds the edge's
 * rules: same-origin only, no-store, refusals as codes.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return vaultFieldPost(request, params, async (ctx, id, field) => ({
    value: await revealCredentialField(ctx, id, field),
  }));
}
