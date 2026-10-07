"use server";

import { headers } from "next/headers";

import { getPortalSession } from "@/auth/session";
import { setClientSummary } from "@/notify/client-summary";
import { readClientSummaryToken } from "@/notify/client-summary-token";
import { allowStrict, clientIp } from "@/ratelimit";

export type ClientSummarySwitchResult =
  | { readonly ok: true; readonly on: boolean }
  | { readonly ok: false; readonly reason: "dead" | "tooMany" | "signIn" };

/**
 * STOP — OR START AGAIN — the weekly summary of the person the link names:
 * the public `/portal/unsubscribe/<token>` page's one action (Phase 5 slice
 * 101; founder decision C69).
 *
 * **THIS ACTION IS PUBLIC**, like its page (`PORTAL_UNSUBSCRIBE_PREFIX`,
 * src/proxy.ts): the person pressing holds a mailbox, and needs no session to
 * stop mail they never asked for. So it trusts nothing the call carries but
 * the token — the workspace and the person come from its signed ids
 * (`client-summary-token.ts`), never from anything else — and all a token can
 * ever do is STOP that one person's summary. STARTING it again also needs the
 * portal session of that very person (`getPortalSession`, read here, never a
 * value from the call): the mail carries the agency's reply address, so the
 * link can end up in the agency's mailbox (`src/notify/client-summary.ts`).
 *
 * THE LIMIT IS PER NETWORK, and a start without that session is turned away
 * BEFORE it spends anything (the security review's low): keyed per person, a
 * second holder of the link — the agency's mailbox, a forward — could spend
 * the person's budget with presses that change nothing and leave them unable
 * to stop their own mail. Per network, they spend only their own; the token
 * is an HMAC, so the limit is not what stops guessing — it keeps a POST that
 * opens a transaction from being free to repeat.
 */
export async function setClientSummaryAction(token: unknown, on: unknown): Promise<ClientSummarySwitchResult> {
  if (typeof token !== "string" || typeof on !== "boolean") return { ok: false, reason: "dead" };
  const who = readClientSummaryToken(token);
  if (!who) return { ok: false, reason: "dead" };
  const signedInAs = on ? ((await getPortalSession())?.user.id ?? null) : null;
  if (on && signedInAs !== who.contactId) return { ok: false, reason: "signIn" };
  if (!(await allowStrict("mail.client_summary_switch", clientIp(await headers())))) {
    return { ok: false, reason: "tooMany" };
  }
  const result = await setClientSummary(token, on, "page", signedInAs);
  if (result === "done") return { ok: true, on };
  return { ok: false, reason: result };
}
