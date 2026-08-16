import { getTranslations } from "next-intl/server";

import { AuthzError } from "@/authz/errors";
import { handleAuthzRedirect } from "@/authz/redirects";
import { DomainError } from "@/lib/domain-error";

/**
 * Server-action plumbing shared by the Phase-2 pages: run a service
 * call, translate AuthzError / DomainError into an i18n message
 * (MFA_REQUIRED becomes step-up navigation), rethrow anything else.
 * Tenant + actor always come from requireTenantContext() at the call
 * site — never from the form.
 */

export type ActionResult<T = undefined> =
  | { ok: true; value: T }
  | { ok: false; message: string };

/** The {ok, message} shape AutoForm / FormMessage consume. */
export type FormResult = { ok: boolean; message: string };

const AUTHZ_MESSAGE_KEY: Record<AuthzError["reason"], "FORBIDDEN" | "NOT_FOUND" | "NOT_ENTITLED"> = {
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  NOT_ENTITLED: "NOT_ENTITLED",
  FEATURE_DISABLED: "NOT_ENTITLED",
  DISABLED_BY_TENANT: "NOT_ENTITLED",
  MFA_REQUIRED: "FORBIDDEN", // never reached: redirected first
};

export async function messageForError(e: unknown): Promise<string | null> {
  const t = await getTranslations("domainErrors");
  if (e instanceof AuthzError) return t(AUTHZ_MESSAGE_KEY[e.reason]);
  if (e instanceof DomainError) return t(e.code);
  return null;
}

export async function runAction<T>(returnTo: string, fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    handleAuthzRedirect(e, returnTo);
    const message = await messageForError(e);
    if (message) return { ok: false, message };
    throw e;
  }
}

/** Same, for actions whose success is a message (AutoForm / useActionState forms). */
export async function runForm(returnTo: string, fn: () => Promise<string>): Promise<FormResult> {
  const r = await runAction(returnTo, fn);
  return r.ok ? { ok: true, message: r.value } : r;
}

/** FormData helpers: "" ⇒ null; dates from <input type="date"> as UTC midnight. */
export const field = (fd: FormData, name: string): string | null => {
  const v = fd.get(name);
  if (typeof v !== "string") return null;
  return v;
};
export const has = (fd: FormData, name: string): boolean => fd.has(name);
export const dateField = (fd: FormData, name: string): Date | null => {
  const v = field(fd, name);
  if (!v) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};
export const isoDate = (d: Date | null): string => (d ? d.toISOString().slice(0, 10) : "");
