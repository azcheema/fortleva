import { createHash } from "node:crypto";

/**
 * THE INVITATION'S TWO CONSTANTS, IN A LEAF THAT IMPORTS NOTHING BUT
 * `node:crypto` — so the seam split above them is real and not merely a
 * lint rule's view of the world.
 *
 * `contact-invite-token.ts` is exempt from the platform-seam rule
 * because a contact presenting a token has no tenant to open
 * `withTenant` for. `contact-access.ts` is NOT exempt. But the first cut
 * had the second importing the first for these two values, and that
 * file's own top-level imports are `@/auth/portal` (which constructs the
 * Better Auth instance at module scope) and `withPlatform` — so every
 * server action that invites a contact pulled both in anyway, and only
 * the lint rule's VIEW had narrowed. A fresh code review caught it.
 *
 * A constant and a one-line hash have no business dragging an auth
 * instance into a module graph. They live here, both halves import
 * here, and the exemption now bounds what it appears to bound.
 */

/**
 * **72 HOURS, which is SECURITY.md §3.4's number for this plane** — not
 * the member invitation's seven days. The first cut copied that constant
 * and called it "one number for both planes"; a fresh security review
 * caught that the document specifies a TIGHTER bound for the portal, and
 * the least-trusted plane is the wrong place to inherit a looser one.
 * (`src/members/invites.ts`'s seven days is its own, older deviation
 * from the 48 h the same paragraph gives for `MemberInvite`; it is
 * recorded in PLAN §0 rather than changed from here.)
 *
 * The mail body says the same number by reading THIS constant, so the
 * two cannot drift — the first cut hard-coded "7 days" in the sentence
 * and changed only the constant.
 */
export const INVITE_TTL_MS = 72 * 60 * 60 * 1000;

/** For the copy that tells a contact how long their link lasts. */
export const INVITE_TTL_HOURS = INVITE_TTL_MS / (60 * 60 * 1000);

/**
 * Raw tokens never touch the database. The column is `token_hash` and is
 * UNIQUE on the hash, so a lookup is by hash and a leak of the table
 * leaks nothing usable.
 */
export const hashToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");
