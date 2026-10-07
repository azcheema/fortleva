import type { Metadata } from "next";
import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";

import { readReplyAddressLink } from "@/notify/reply-address";
import { allowStrict, clientIp } from "@/ratelimit";

import { ReplyAddressConfirmForm } from "./confirm-form";
import { ReplyAddressUnavailable } from "./reply-address-unavailable";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("replyAddress");
  return { title: t("metaTitle") };
}

/**
 * `/reply-address/[token]` — where the reply-address confirmation mail lands
 * (Phase 5 slice 100; founder decision C68 (f); `src/notify/reply-address.ts`).
 *
 * A workspace's owner or admin typed a new address for replies to its mail;
 * Fortleva mailed this link THERE, and replies go there only once someone
 * holding that mailbox presses Confirm. The mail itself names nothing a
 * member typed; this page, reached only by the link, names the workspace and
 * the address, so the person can tell whether it is theirs to confirm.
 *
 * **PUBLIC BY A PREFIX EXEMPTION** (`REPLY_ADDRESS_PREFIX`, src/proxy.ts): the
 * mailbox may be a shared one read by somebody with no seat. **GET CHANGES
 * NOTHING** — a business inbox's scanner opens every link it is sent — and
 * the render is limited per network (it opens a tenant transaction for
 * whoever asks: the share page's reasoning); only the button confirms
 * (`./actions.ts`).
 */
export default async function ReplyAddressPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!(await allowStrict("mail.reply_address_open", clientIp(await headers())))) {
    return <ReplyAddressUnavailable busy />;
  }
  const link = await readReplyAddressLink(token);
  if (!link) return <ReplyAddressUnavailable />;
  return <ReplyAddressConfirmForm token={token} email={link.email} workspaceName={link.workspaceName} />;
}
