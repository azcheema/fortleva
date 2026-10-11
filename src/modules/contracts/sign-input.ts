import { fail } from "@/lib/domain-error";

/**
 * WHAT A CLIENT'S SIGNER MAY SEND (Phase 4 slice 112b2; C84, C85) — a leaf,
 * so the portal's sign card (a client island) and the census writer
 * (`portal-sign.ts`) share the limits and the one parse.
 *
 * SIGN: "I have read and accept this contract" ticked, and the signer's full
 * name typed — the same act as the agency's signature at sending (C84 (b)), so
 * both read alike on the signature page. DECLINE: an optional reason, the
 * client's own words, shown to the agency and to the client's other main
 * contacts. The database holds the same limits (`contract_signature`'s
 * CHECKs); this says them first, as a sentence.
 */

/** The typed name: `contract_signature_typed_name`'s 1–200. */
export const SIGN_NAME_MAX = 200;
/** A decline's reason: `contract_signature_decline_reason`'s 1–1000. */
export const DECLINE_REASON_MAX = 1000;

export type ContractDecisionInput =
  | { readonly decision: "SIGNED"; readonly typedName: string }
  | { readonly decision: "DECLINED"; readonly reason: string | null };

/** What crossed the action boundary → a decision, or INVALID_INPUT. */
export function parseContractDecision(raw: {
  readonly decision: unknown;
  readonly accepted?: unknown;
  readonly typedName?: unknown;
  readonly reason?: unknown;
}): ContractDecisionInput {
  if (raw.decision === "SIGNED") {
    // The tick is the act: a name without it is not a signature.
    if (raw.accepted !== true) return fail("INVALID_INPUT", "accepted");
    const name = typeof raw.typedName === "string" ? raw.typedName.trim().replace(/\s+/g, " ") : "";
    if (name.length === 0 || name.length > SIGN_NAME_MAX) return fail("INVALID_INPUT", "typed name");
    return { decision: "SIGNED", typedName: name };
  }
  if (raw.decision === "DECLINED") {
    if (raw.reason !== undefined && raw.reason !== null && typeof raw.reason !== "string") return fail("INVALID_INPUT", "reason");
    const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
    if (reason.length > DECLINE_REASON_MAX) return fail("INVALID_INPUT", "reason");
    return { decision: "DECLINED", reason: reason.length > 0 ? reason : null };
  }
  return fail("INVALID_INPUT", "decision");
}
