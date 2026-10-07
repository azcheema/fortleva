import type { Metadata } from "next";
import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";

import { readClientSummaryLink } from "@/notify/client-summary";
import { readClientSummaryToken } from "@/notify/client-summary-token";
import { allowStrict, clientIp } from "@/ratelimit";

import { SummarySwitchForm, SummaryUnavailable } from "./summary-switch-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("clientSummary");
  // A person's own link: never indexed, as the share page's.
  return { title: t("metaTitle"), robots: { index: false, follow: false } };
}

/**
 * `/portal/unsubscribe/[token]` — where the "Don't want these emails?" link in
 * a client person's weekly summary lands (Phase 5 slice 101; founder decision
 * C69; `src/notify/client-summary.ts`). The mail's RFC 8058 header points at
 * `/api/client-summary/unsubscribe/<token>` instead, whose POST stops it in
 * one click and whose GET comes here.
 *
 * **PUBLIC BY A PREFIX EXEMPTION** (`PORTAL_UNSUBSCRIBE_PREFIX`,
 * src/proxy.ts): stopping mail must never need a password. **GET CHANGES
 * NOTHING** — a mail scanner opens every link — and a render whose token's
 * signature holds is limited per NETWORK (it opens a tenant transaction: the
 * share page's reasoning) — never per person, so another holder of the link
 * cannot use up the person's own visits (the security review's low); a
 * forged one costs one HMAC and no limit. Only the
 * button changes the setting (`./actions.ts`): it stops the summary with the
 * link alone, and starts it again only for the person themselves, signed in
 * to their portal (C69 — nobody at the agency may).
 *
 * THE PAGE NAMES NOBODY — not the person, their address, their company or
 * the agency: a forwarded mail's link must not tell its reader whose it was.
 */
export default async function UnsubscribePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const who = readClientSummaryToken(token);
  if (!who) return <SummaryUnavailable />;
  if (!(await allowStrict("mail.client_summary_open", clientIp(await headers())))) {
    return <SummaryUnavailable busy />;
  }
  const link = await readClientSummaryLink(token);
  if (!link) return <SummaryUnavailable />;
  return <SummarySwitchForm token={token} on={link.on} />;
}
