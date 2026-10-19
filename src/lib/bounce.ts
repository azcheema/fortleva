import { redirect } from "next/navigation";
import { getMessages, getTranslations } from "next-intl/server";

import { handleAuthzRedirect } from "@/authz/redirects";
import { isOwnMessage, parseBounce, withBounce, type BounceCode } from "@/lib/bounce-code";
import { domainMessageKey } from "@/lib/server-actions";

/**
 * The server half of `bounce-code.ts`: a form-POST action's refusal sent back
 * to its page as a code, and the page's lookup of that code.
 */

/** A DomainError's or an AuthzError's `domainErrors.*` key, as a code. */
export const domainBounceOf = (e: unknown): BounceCode | null => {
  const key = domainMessageKey(e);
  return key === null ? null : `domain.${key}`;
};

/**
 * Run `fn`; on a refusal `codeOf` can name, redirect to `returnTo` with its
 * code. MFA_REQUIRED is step-up navigation first; anything unnamed is thrown.
 */
export async function orBounce<T>(
  returnTo: string,
  fn: () => Promise<T>,
  codeOf: (e: unknown) => BounceCode | null = domainBounceOf,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    handleAuthzRedirect(e, returnTo);
    const code = codeOf(e);
    if (code === null) throw e;
    redirect(withBounce(returnTo, code));
  }
}

/**
 * The sentence for a page's `?error=`, or undefined — no callout — for
 * anything that is not one of our own message keys.
 */
export async function bounceMessage(raw: unknown): Promise<string | undefined> {
  const parsed = parseBounce(raw);
  if (parsed === null) return undefined;
  const messages = (await getMessages()) as { files?: { errors?: unknown }; domainErrors?: unknown };
  if (parsed.catalogue === "files") {
    if (!isOwnMessage(messages.files?.errors, parsed.key)) return undefined;
    const t = await getTranslations("files.errors");
    // A key from the address, checked against the catalogue above.
    return t(parsed.key as "notFound");
  }
  if (!isOwnMessage(messages.domainErrors, parsed.key)) return undefined;
  const t = await getTranslations("domainErrors");
  return t(parsed.key as "NOT_FOUND");
}
