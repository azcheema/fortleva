"use server";

import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";

import { openShareLink, sendShareCode, type SharedSecret } from "@/modules/vault";
import { allowStrict, clientIp } from "@/ratelimit";

/**
 * THE SHARE PAGE'S TWO WRITES (Phase 3V slice 90), from somebody with NO
 * session — the recipient of a vault share link, usually outside the
 * agency and outside every plane. The token in the URL is the only
 * credential, and the address the code goes to comes from the LINK, never
 * from this form: nothing here reads an identity or an address out of the
 * request (`brokered-writes.test.ts` holds sessionless actions to that).
 *
 * **NOT `runAction` / `runForm` / `runPortalForm`**, for the invite page's
 * reasons: the first two are the member plane's runners and translate a
 * refusal's code into its own message; the third needs a portal session.
 * Each outcome below is mapped to the page's own sentence instead.
 *
 * **THE BUCKET FIRST, THEN THE LINK.** Each action spends its per-address
 * bucket (`vault.share_code`, `vault.share_verify`) through `allowStrict`,
 * which holds without Upstash, before the service is reached. The bucket
 * is the loop-stopper, not the authority: the link's own row allows five
 * codes and five checks in its life and fails closed
 * (`src/modules/vault/share-open.ts`). A malformed code is refused before
 * either is spent.
 *
 * EVERY DEAD LINK GETS THE ONE SENTENCE the page draws for it (`dead`):
 * expired, opened, revoked, never real — nobody learns which.
 */

export type ShareSendResult =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly dead: boolean; readonly message: string };

export type ShareOpenResult =
  | { readonly ok: true; readonly secret: SharedSecret }
  | { readonly ok: false; readonly dead: boolean; readonly message: string };

const TOKEN_MAX = 128;

const tokenOf = (raw: unknown): string | null =>
  typeof raw === "string" && raw.length > 0 && raw.length <= TOKEN_MAX ? raw : null;

/** Mail a fresh code to the address the link was made for. */
export async function sendShareCodeAction(rawToken: string): Promise<ShareSendResult> {
  const t = await getTranslations("auth.portalShare");
  const token = tokenOf(rawToken);
  if (token === null) return { ok: false, dead: true, message: t("dead") };
  if (!(await allowStrict("vault.share_code", clientIp(await headers())))) {
    return { ok: false, dead: false, message: t("limited") };
  }
  const outcome = await sendShareCode(token, ({ code, tenantName, minutes }) => ({
    subject: t("mail.subject", { tenant: tenantName }),
    text: t("mail.body", { code, tenant: tenantName, minutes }),
  }));
  if (outcome.ok) return { ok: true, message: t("sent") };
  switch (outcome.reason) {
    case "dead":
      return { ok: false, dead: true, message: t("dead") };
    case "wait":
      return { ok: false, dead: false, message: t("wait") };
    case "no_codes":
      return { ok: false, dead: false, message: t("noCodes") };
    case "address_busy":
      return { ok: false, dead: false, message: t("addressBusy") };
    case "mail_failed":
      return { ok: false, dead: false, message: t("mailFailed") };
    case "busy":
      return { ok: false, dead: false, message: t("busy") };
  }
}

/** Check the code and, when it is right, return the secret — once. */
export async function openShareLinkAction(rawToken: string, code: unknown): Promise<ShareOpenResult> {
  const t = await getTranslations("auth.portalShare");
  const token = tokenOf(rawToken);
  if (token === null) return { ok: false, dead: true, message: t("dead") };
  // FREE, so it comes before the bucket: a typo spends nothing. The service
  // applies the same rule again (`normalizeShareCode`) before it counts.
  if (typeof code !== "string" || code.length > 32 || !/^\d{6}$/.test(code.replace(/[\s-]/g, ""))) {
    return { ok: false, dead: false, message: t("malformed") };
  }
  if (!(await allowStrict("vault.share_verify", clientIp(await headers())))) {
    return { ok: false, dead: false, message: t("limited") };
  }
  const outcome = await openShareLink(token, code);
  if (outcome.ok) return { ok: true, secret: outcome.secret };
  switch (outcome.reason) {
    case "dead":
      return { ok: false, dead: true, message: t("dead") };
    case "malformed":
      return { ok: false, dead: false, message: t("malformed") };
    case "no_code":
      return { ok: false, dead: false, message: t("noCode") };
    case "wrong_code":
      return { ok: false, dead: false, message: t("wrongCode", { left: outcome.attemptsLeft ?? 0 }) };
    case "busy":
      return { ok: false, dead: false, message: t("busy") };
  }
}
