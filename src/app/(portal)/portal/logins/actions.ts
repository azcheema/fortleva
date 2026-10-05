"use server";

import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";

import { checkContactPassword } from "@/auth/portal-password";
import { AuthzError } from "@/authz/errors";
import type { VaultAnswer } from "@/components/vault/vault-call";
import {
  lookAtPortalLogin,
  openPortalLoginsDoor,
  resendPortalLoginsCode,
  startPortalLoginsDoor,
  type LoginsCodeMail,
} from "@/modules/vault";
import { requirePortalContext } from "@/portal/context";

/**
 * THE CLIENT'S LOGINS PAGE, ITS FOUR WRITES (Phase 3V slice 91; C52 (d)
 * and (k), C59). Every one takes its principal AND its portal session from
 * `requirePortalContext()` — never from what was posted (the
 * brokered-writes pin) — and hands them to the vault's portal broker,
 * which proves the contact may first, then works as SYSTEM.
 *
 * NOT `runAction` / `runForm` (the member plane's runners, which would
 * tell a client the difference between FORBIDDEN and NOT_ENTITLED): each
 * outcome is mapped to the page's own sentence here, and any authorization
 * refusal becomes the one quiet `unavailable` — on this plane the reason is
 * a fact about the agency.
 */

export type LoginsDoorResult =
  | { readonly ok: true; readonly message: string }
  | {
      readonly ok: false;
      readonly message: string;
      /** The door must be started again from the password (the page goes back a step). */
      readonly restart?: boolean;
      /** A door and its code exist although the mail failed: the code step, where a new one can be asked for. */
      readonly toCode?: boolean;
    };

/** The code's mail, in the contact's language. */
const mailOf =
  (t: Awaited<ReturnType<typeof getTranslations<"portal.logins">>>): LoginsCodeMail =>
  ({ code, tenantName, minutes }) => ({
    subject: t("mail.subject", { tenant: tenantName }),
    text: t("mail.body", { code, tenant: tenantName, minutes }),
  });

/** Step one: the portal password, then a code by mail. */
export async function startLoginsDoorAction(password: unknown): Promise<LoginsDoorResult> {
  const { principal, sessionId } = await requirePortalContext();
  const t = await getTranslations("portal.logins");
  if (typeof password !== "string" || password.length === 0 || password.length > 1024) {
    return { ok: false, message: t("door.passwordRequired") };
  }
  const requestHeaders = await headers();
  try {
    const r = await startPortalLoginsDoor(
      { principal, sessionId },
      () => checkContactPassword(requestHeaders, password),
      mailOf(t),
    );
    if (r.ok) return { ok: true, message: t("door.sent") };
    switch (r.reason) {
      case "wrong_password":
        return { ok: false, message: t("door.wrongPassword") };
      case "limited":
        return { ok: false, message: t("door.limited") };
      case "address_busy":
        return { ok: false, message: t("door.addressBusy") };
      case "mail_failed":
        return { ok: false, message: t("door.mailFailed"), toCode: true };
      case "off":
        return { ok: false, message: t("unavailable") };
      case "busy":
        return { ok: false, message: t("door.busy") };
    }
  } catch (e) {
    if (e instanceof AuthzError) return { ok: false, message: t("unavailable") };
    throw e;
  }
}

/** A fresh code for this session's waiting door. */
export async function resendLoginsCodeAction(): Promise<LoginsDoorResult> {
  const { principal, sessionId } = await requirePortalContext();
  const t = await getTranslations("portal.logins");
  try {
    const r = await resendPortalLoginsCode({ principal, sessionId }, mailOf(t));
    if (r.ok) return { ok: true, message: t("door.sent") };
    switch (r.reason) {
      case "start_again":
        return { ok: false, message: t("door.startAgain"), restart: true };
      case "wait":
        return { ok: false, message: t("door.wait") };
      case "limited":
        return { ok: false, message: t("door.limited") };
      case "address_busy":
        return { ok: false, message: t("door.addressBusy") };
      case "mail_failed":
        return { ok: false, message: t("door.mailFailed") };
      case "off":
        return { ok: false, message: t("unavailable") };
      case "busy":
        return { ok: false, message: t("door.busy") };
    }
  } catch (e) {
    if (e instanceof AuthzError) return { ok: false, message: t("unavailable") };
    throw e;
  }
}

/** Step two: the mailed code. On success the page re-renders behind the open door. */
export async function openLoginsDoorAction(code: unknown): Promise<LoginsDoorResult> {
  const { principal, sessionId } = await requirePortalContext();
  const t = await getTranslations("portal.logins");
  try {
    const r = await openPortalLoginsDoor({ principal, sessionId }, code);
    // The page refreshes into the list; nothing is said on success.
    if (r.ok) return { ok: true, message: "" };
    switch (r.reason) {
      case "malformed":
        return { ok: false, message: t("door.malformed") };
      case "no_code":
        return { ok: false, message: t("door.noCode") };
      case "wrong_code":
        return { ok: false, message: t("door.wrongCode", { left: r.attemptsLeft ?? 0 }) };
      case "start_again":
        return { ok: false, message: t("door.startAgain"), restart: true };
      case "off":
        return { ok: false, message: t("unavailable") };
      case "busy":
        return { ok: false, message: t("door.busy") };
    }
  } catch (e) {
    if (e instanceof AuthzError) return { ok: false, message: t("unavailable") };
    throw e;
  }
}

/**
 * One look at one field — the eye (`reveal`) or the clipboard (`copy`) —
 * answered in the shape the shared secret field reads (`VaultAnswer`), so
 * the staff vault's control works here unchanged: a closed door is
 * MFA_REQUIRED (the field's cue to refresh the page, which draws the door
 * again), anything this contact may not open is NOT_FOUND.
 */
export async function lookAtLoginAction(
  credentialId: unknown,
  field: unknown,
  kind: unknown,
): Promise<VaultAnswer<{ value: string }>> {
  const { principal, sessionId } = await requirePortalContext();
  if (
    typeof credentialId !== "string" ||
    typeof field !== "string" ||
    (kind !== "reveal" && kind !== "copy")
  ) {
    return { ok: false, error: "INVALID_INPUT" };
  }
  try {
    const r = await lookAtPortalLogin({ principal, sessionId }, credentialId, field, kind);
    if (r.ok) return { ok: true, value: { value: r.value } };
    switch (r.reason) {
      case "locked":
        return { ok: false, error: "MFA_REQUIRED" };
      case "not_found":
        return { ok: false, error: "NOT_FOUND" };
      case "budget":
        return { ok: false, error: "REVEAL_BUDGET_EXCEEDED" };
      case "invalid":
        return { ok: false, error: "INVALID_INPUT" };
      case "busy":
        return { ok: false, error: "VAULT_BUSY" };
    }
  } catch (e) {
    if (e instanceof AuthzError) return { ok: false, error: "NOT_FOUND" };
    throw e;
  }
}
