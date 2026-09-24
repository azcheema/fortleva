/* eslint-disable no-restricted-imports -- the auth layer is the one
   sanctioned consumer of the raw client outside src/db (TENANCY.md §6.3). */
import { verifyJWT } from "better-auth/crypto";

import { runtimeClient } from "@/db/client";

import { isSignUpLink } from "./closed-endpoints";
import { auth } from "./index";

/**
 * What the member plane's recovery SCREENS read from the instance (C30).
 * Separate from `./member-recovery` because these need the instance itself,
 * and the instance imports that module for its callbacks.
 */

/**
 * THE PASSWORD POLICY, READ FROM THE INSTANCE THAT ENFORCES IT — the portal's
 * `portalPasswordPolicy`, for the member plane's new-password screen. A form
 * that asks for a length the service then refuses is a refusal the person
 * cannot act on.
 */
export async function memberPasswordPolicy(): Promise<{ readonly min: number; readonly max: number }> {
  const { minPasswordLength, maxPasswordLength } = (await auth.$context).password.config;
  return { min: minPasswordLength, max: maxPasswordLength };
}

/** A JWT header naming exactly the algorithm `/verify-email` accepts. */
function isHs256(token: string): boolean {
  try {
    const header: unknown = JSON.parse(Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8"));
    return typeof header === "object" && header !== null && (header as { alg?: unknown }).alg === "HS256";
  } catch {
    return false;
  }
}

/**
 * WHOSE ADDRESS A CONFIRMATION LINK WOULD CONFIRM, for `/confirm-email/[token]`:
 * the address and whether it is already confirmed, when the link is a live
 * sign-up link; null for everything else — forged, expired, a change-email
 * link, an account that no longer exists, a console principal's — because the
 * page renders one state for all of them.
 *
 * It VERIFIES the link — signature, expiry and HS256, the three checks Better
 * Auth's own `/verify-email` made before this plane refused that endpoint —
 * rather than merely decoding it, and it refuses anything that is not readably
 * a plain sign-up link (`isSignUpLink`, which fails closed: a change-email
 * link would name an address to move TO). Checking consumes nothing: a
 * confirmation link is a stateless JWT, so rendering the page — which is all a
 * mail scanner does — changes nothing. `confirmMemberEmail` below is the only
 * thing that confirms.
 */
export async function confirmEmailHolder(
  token: string,
): Promise<{ email: string; confirmed: boolean } | null> {
  if (token.length > 4096 || !isSignUpLink(token) || !isHs256(token)) return null;
  const claims = await verifyJWT<{ email?: unknown }>(token, (await auth.$context).secret);
  const email = claims?.email;
  if (typeof email !== "string" || email === "") return null;
  const user = await runtimeClient.user.findUnique({
    where: { email: email.toLowerCase() },
    select: { email: true, emailVerified: true, platformRole: true },
  });
  if (!user || (typeof user.platformRole === "string" && user.platformRole !== "")) return null;
  return { email: user.email, confirmed: user.emailVerified };
}

export type ConfirmOutcome =
  | { readonly kind: "confirmed"; readonly email: string }
  | { readonly kind: "dead" | "already" | "password" };

/**
 * **CONFIRMING AN ADDRESS TAKES THE LINK AND THE ACCOUNT'S PASSWORD** (C30,
 * after its review) — the member plane's ONLY way to confirm one: Better
 * Auth's own `/verify-email` is refused on this plane (`./closed-endpoints`).
 *
 * WHY BOTH. The pre-account takeover is a stranger signing somebody's address
 * up first, with a password only the stranger knows. The link proves the
 * mailbox and the password proves the account, and the stranger holds only
 * the second while the owner holds only the first — so neither can confirm
 * such an account on their own, and its password can never start working
 * for the stranger. The owner's way in is "Forgot your password?", which
 * REPLACES the stranger's password and confirms the address (a reset link is
 * a mailbox proof of its own; `./member-recovery`).
 *
 * The first cut asked for a press alone, warning "only confirm if you created
 * this account". The review showed the warning cannot hold for the likeliest
 * victim: an owner who signs up at an address a stranger already registered
 * gets the library's silent stand-in answer and no mail, while the stranger —
 * by signing in with their password, which mails a fresh link (`sendOnSignIn`)
 * — can keep a live link in the owner's inbox that reads exactly like the
 * owner's own. The owner presses it in good faith; the stranger, polling
 * sign-in, gets a session and enrols a second factor; the owner's reset then
 * stops at a code screen they cannot pass. A password check at confirmation
 * ends that whole chain at its first step.
 *
 * The check is the instance's own verifier over the account's credential, at
 * the instance's own length bound (a megabyte "password" is refused before
 * any hashing). The caller — the confirmation page's server action — limits
 * attempts per network, like sign-in; the link itself is a signed, expiring
 * JWT only its mailbox was sent.
 *
 * A confirmation that loses a race to a reset or another confirmation is still
 * a confirmation: the address ends confirmed either way.
 */
export async function confirmMemberEmail(token: string, password: string): Promise<ConfirmOutcome> {
  const holder = await confirmEmailHolder(token);
  if (!holder) return { kind: "dead" };
  if (holder.confirmed) return { kind: "already" };
  const ctx = await auth.$context;
  if (password === "" || password.length > ctx.password.config.maxPasswordLength) return { kind: "password" };
  const user = await runtimeClient.user.findUnique({ where: { email: holder.email }, select: { id: true } });
  if (!user) return { kind: "dead" };
  const credential = await runtimeClient.account.findFirst({
    where: { userId: user.id, providerId: "credential" },
    select: { password: true },
  });
  if (!credential?.password || !(await ctx.password.verify({ hash: credential.password, password }))) {
    return { kind: "password" };
  }
  await runtimeClient.user.updateMany({ where: { id: user.id, emailVerified: false }, data: { emailVerified: true } });
  return { kind: "confirmed", email: holder.email };
}
