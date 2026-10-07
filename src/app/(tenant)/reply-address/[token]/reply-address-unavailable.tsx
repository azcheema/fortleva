import { useTranslations } from "next-intl";

import { AuthShell } from "@/app/(tenant)/login/auth-shell";

/**
 * THE ONE STATE FOR A REPLY-ADDRESS LINK THAT CANNOT BE USED — malformed,
 * unknown, replaced by a newer request, cancelled, expired, already used, or
 * asked by somebody who may no longer make the change. `readReplyAddressLink`
 * answers the same null for all of them, so this says the same thing for all
 * of them: the way forward is a new link, sent from the workspace's settings.
 * It offers no button, because the person reading it may hold only a
 * mailbox — there is nothing in Fortleva for them to sign in to.
 *
 * Two callers, like `ConfirmUnavailable`: the page, for a link dead on
 * arrival (or a network over its budget — `busy`), and the form, when Confirm
 * is refused after the page was drawn. No `"use client"`: it holds no state.
 */
export function ReplyAddressUnavailable({ busy = false }: { busy?: boolean }) {
  const t = useTranslations("replyAddress");
  return (
    <AuthShell
      title={busy ? t("tooManyTitle") : t("unavailableTitle")}
      description={busy ? t("tooMany") : t("unavailable")}
    />
  );
}
