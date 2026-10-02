import { copyCredentialField } from "@/modules/vault";

import { vaultFieldPost } from "../../respond";

/**
 * POST /api/vault/[id]/copy `{ field }` → `{ value }` — the same field for
 * the clipboard, audited `credential.copied`: a separate route on purpose
 * (plan §3.4), because "copied" and "looked at" are different acts in a
 * trail somebody reads later. The browser writes the value to the
 * clipboard and clears it again (C52 (c)); nothing here can.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  return vaultFieldPost(request, params, async (ctx, id, field) => ({
    value: await copyCredentialField(ctx, id, field),
  }));
}
