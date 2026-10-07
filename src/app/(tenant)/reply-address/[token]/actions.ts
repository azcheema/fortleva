"use server";

import { headers } from "next/headers";

import { confirmReplyAddress } from "@/notify/reply-address";
import { allowStrict, clientIp } from "@/ratelimit";

export type ConfirmReplyAddressResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "dead" | "tooMany" };

/**
 * CONFIRM — the public `/reply-address/<token>` page's one action (Phase 5
 * slice 100; founder decision C68 (f)).
 *
 * **THIS ACTION IS PUBLIC**, like its page (`REPLY_ADDRESS_PREFIX`,
 * src/proxy.ts): the person holding the link holds a mailbox, not
 * necessarily a seat. So it trusts nothing the call carries:
 * `confirmReplyAddress` re-checks the link's hash and age and the asker's
 * standing under a row lock, and all a token can ever do is confirm the
 * address the asker already chose. Presses are limited per network through
 * `allowStrict`, whose in-process floor holds while Upstash is unset — not to
 * stop guessing (the secret is 32 random bytes) but so an unauthenticated
 * POST that opens a transaction is not free to repeat.
 */
export async function confirmReplyAddressAction(token: unknown): Promise<ConfirmReplyAddressResult> {
  if (typeof token !== "string") return { ok: false, reason: "dead" };
  if (!(await allowStrict("mail.reply_address_confirm", clientIp(await headers())))) {
    return { ok: false, reason: "tooMany" };
  }
  return (await confirmReplyAddress(token)) === "confirmed" ? { ok: true } : { ok: false, reason: "dead" };
}
