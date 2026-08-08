/**
 * Deterministic denial reasons (AUTHZ.md §5): the gate that denies
 * fixes the reason, which fixes the UX. NOT_FOUND vs FORBIDDEN is
 * load-bearing — out-of-scope resources 404 so existence never leaks
 * across the client boundary (§4).
 */
export type DenialReason =
  | "FEATURE_DISABLED" // gate 1 — kill-switch
  | "NOT_ENTITLED" // gate 2 — plan
  | "DISABLED_BY_TENANT" // gate 3 — preference
  | "FORBIDDEN" // gate 4 — permission held? no
  | "NOT_FOUND" // gate 4 — out of scope: existence must not leak
  | "MFA_REQUIRED"; // ✦ permission without MFA enrolled / fresh factor

export class AuthzError extends Error {
  constructor(
    readonly reason: DenialReason,
    detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "AuthzError";
  }
}

export const deny = (reason: DenialReason, detail?: string): never => {
  throw new AuthzError(reason, detail);
};
