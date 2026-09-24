import { createHash } from "node:crypto";

import { MEMBER_RESET_STORED_PREFIX } from "./recovery-policy";

/**
 * HOW THE MEMBER PLANE STORES A RESET LINK (C30): `pwreset#` and the
 * base64url SHA-256 of Better Auth's whole identifier, `reset-password:<token>`.
 *
 * Hashed for the portal's reason — "raw tokens never touch the database": a
 * reader of `verification` (a leaked backup, a read-only injection, somebody's
 * query history) must not be able to set a member's password. PREFIXED,
 * unlike the portal's built-in `"hashed"`, because this table is shared: the
 * built-in form is 43 bare characters that nothing tells apart from the
 * two-factor rows beside it, so a purge of "this member's reset links" could
 * only have been written as "every row with this member's id" — which ends
 * their trusted devices too. `recovery-policy.ts` says why the prefix must
 * never be `reset-password:` itself.
 *
 * Wired into the member instance as `verification.storeIdentifier`'s override
 * for the `reset-password:` prefix ONLY, so every other kind of row keeps its
 * plain identifier — which is what RUNBOOK §8's `LIKE 'trust-device-%'`
 * relies on. Also used by the e2e seed, which plants a reset link the way the
 * instance would have stored it.
 *
 * Pure (Node's hash only), so a test can pin the exact form.
 */
export const RESET_IDENTIFIER_PREFIX = "reset-password:";

export const storedResetIdentifierSync = (identifier: string): string =>
  `${MEMBER_RESET_STORED_PREFIX}${createHash("sha256").update(identifier).digest("base64url")}`;

/** The shape `storeIdentifier`'s `{ hash }` option takes. */
export const storedResetIdentifier = async (identifier: string): Promise<string> =>
  storedResetIdentifierSync(identifier);

/** The stored identifier of the link carrying `token`. */
export const storedResetIdentifierOf = (token: string): string =>
  storedResetIdentifierSync(`${RESET_IDENTIFIER_PREFIX}${token}`);
