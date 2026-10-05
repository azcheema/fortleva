"use server";

import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";

import { checkContactPassword } from "@/auth/portal-password";
import { AuthzError } from "@/authz/errors";
import type { VaultAnswer } from "@/components/vault/vault-call";
import {
  askToOpenSealedLogins,
  confirmSealedAsk,
  lookAtPortalLogin,
  lookAtSealedLogin,
  openPortalLoginsDoor,
  resendPortalLoginsCode,
  startPortalLoginsDoor,
  withdrawSealedAsk,
  type LoginsCodeMail,
  type SealedActOutcome,
} from "@/modules/vault";
import { requirePortalContext } from "@/portal/context";

/**
 * THE CLIENT'S LOGINS PAGE, ITS WRITES (Phase 3V slice 91; C52 (d) and
 * (k), C59 — and, since slice 93, the SEALED logins: the ask, its
 * withdrawal, the confirmation after the silent wait, and a look at one
 * that opened; C52 (f)–(h), C61). Every one takes its principal AND its portal session from
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

/** What the sealed section's buttons and form get back: a sentence, and whether it went through. */
export type SealedActionResult = { readonly ok: boolean; readonly message: string };

/**
 * ASK to open the logins the agency keeps sealed for this client (slice 93,
 * C52 (f)) — the portal password and a reason. Everyone at the agency who
 * may answer is mailed at once.
 */
export async function askToOpenSealedAction(password: unknown, reason: unknown): Promise<SealedActionResult> {
  const { principal, sessionId } = await requirePortalContext();
  const t = await getTranslations("portal.logins.sealed");
  if (typeof password !== "string" || password.length === 0 || password.length > 1024) {
    return { ok: false, message: t("passwordRequired") };
  }
  const requestHeaders = await headers();
  try {
    const r = await askToOpenSealedLogins(
      { principal, sessionId },
      () => checkContactPassword(requestHeaders, password),
      reason,
    );
    if (r.ok) return { ok: true, message: t("asked") };
    switch (r.reason) {
      case "invalid":
        return { ok: false, message: t("reasonRequired") };
      case "wrong_password":
        return { ok: false, message: t("wrongPassword") };
      case "limited":
        return { ok: false, message: t("limited") };
      case "nothing":
      case "off":
        return { ok: false, message: t("unavailable") };
      case "already":
        return { ok: false, message: t("already") };
      case "cooling":
        return { ok: false, message: t("cooling") };
      case "busy":
        return { ok: false, message: t("busy") };
    }
  } catch (e) {
    if (e instanceof AuthzError) return { ok: false, message: t("unavailable") };
    throw e;
  }
}

/** The sentence for a withdrawal's or a confirmation's refusal. */
async function actMessage(r: Exclude<SealedActOutcome, { ok: true }>): Promise<string> {
  const t = await getTranslations("portal.logins.sealed");
  switch (r.reason) {
    case "locked":
      return t("doorFirst");
    case "not_yet":
      return t("notYet");
    case "settled":
    case "not_found":
    case "invalid":
      return t("settled");
    case "off":
      return t("unavailable");
    case "busy":
      return t("busy");
  }
}

/** WITHDRAW this client's ask before it opens. */
export async function withdrawSealedAskAction(requestId: unknown): Promise<SealedActionResult> {
  const { principal, sessionId } = await requirePortalContext();
  const t = await getTranslations("portal.logins.sealed");
  try {
    const r = await withdrawSealedAsk({ principal, sessionId }, requestId);
    return r.ok ? { ok: true, message: t("withdrawn") } : { ok: false, message: await actMessage(r) };
  } catch (e) {
    if (e instanceof AuthzError) return { ok: false, message: t("unavailable") };
    throw e;
  }
}

/**
 * CONFIRM after the silent wait (C52 (f)) — the door must be open in this
 * session: the password and the mailed code a moment ago. It opens 48
 * hours later unless the agency denies it first.
 */
export async function confirmSealedAskAction(requestId: unknown): Promise<SealedActionResult> {
  const { principal, sessionId } = await requirePortalContext();
  const t = await getTranslations("portal.logins.sealed");
  try {
    const r = await confirmSealedAsk({ principal, sessionId }, requestId);
    return r.ok ? { ok: true, message: t("confirmed") } : { ok: false, message: await actMessage(r) };
  } catch (e) {
    if (e instanceof AuthzError) return { ok: false, message: t("unavailable") };
    throw e;
  }
}

/**
 * One look at one field of a SEALED login that an ask has opened — the
 * shown logins' look (`lookAtLoginAction`) in every other respect,
 * answered in the shape the shared secret field reads.
 */
export async function lookAtSealedLoginAction(
  credentialId: unknown,
  field: unknown,
  kind: unknown,
): Promise<VaultAnswer<{ value: string }>> {
  const { principal, sessionId } = await requirePortalContext();
  if (typeof credentialId !== "string" || typeof field !== "string" || (kind !== "reveal" && kind !== "copy")) {
    return { ok: false, error: "INVALID_INPUT" };
  }
  try {
    const r = await lookAtSealedLogin({ principal, sessionId }, credentialId, field, kind);
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
