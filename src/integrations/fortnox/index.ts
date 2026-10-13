import { fortnoxTransportKind } from "@/config";

import { fakeFortnox } from "./fake";
import { liveFortnox } from "./live";
import type { FortnoxTransport } from "./types";

/**
 * THE FORTNOX THIS PROCESS SPEAKS TO (Phase 4 slice 114; `src/config`'s
 * `fortnoxTransportKind`): Fortnox itself, the file-backed fake, or none at
 * all — `off`, the default everywhere, under which the Fortnox card says "not
 * available yet" and nothing is ever asked of Fortnox (C89 (a)).
 */
export function fortnoxTransport(): FortnoxTransport | null {
  return fortnoxTransportKind === "live" ? liveFortnox : fortnoxTransportKind === "fake" ? fakeFortnox : null;
}

export { FORTNOX_SCOPES } from "./live";
export { codeChallengeOf, isStateShape, newPkceVerifier, newState, stateHashOf } from "./pkce";
export { fakeCompanyTenantIdFor } from "./fake";
export { fileConnectionBody, isFileId, voucherBody } from "./body";
export * from "./types";
