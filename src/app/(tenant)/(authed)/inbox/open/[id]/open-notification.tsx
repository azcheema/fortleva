"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

import { openNotificationAction } from "./actions";

/** Next's redirect from a server action rejects the call, then navigates — never a failure to handle. */
const isRedirect = (e: unknown): boolean => {
  const digest = typeof e === "object" && e !== null ? (e as { digest?: unknown }).digest : undefined;
  return typeof digest === "string" && digest.startsWith("NEXT_REDIRECT");
};

/**
 * Opens the tapped notification (slice 106): once per mount — a re-render must
 * not open it twice — then goes where its inbox row would. After a workspace
 * switch it is a FULL navigation, as the picker's switch is: every segment the
 * router holds belongs to the other workspace. A failed open lands on the
 * inbox, never on a page stuck at "Opening…" — except Next's own redirect (a
 * sign-in that ended meanwhile), which rejects the call and then navigates by
 * itself: that is passed through, never raced (AGENTS.md's trap).
 */
export function OpenNotification({ id }: { id: string }) {
  const t = useTranslations("inbox.open");
  const router = useRouter();
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    openNotificationAction(id)
      .then(
        ({ href, switched }) => {
          if (switched) window.location.assign(href);
          else router.replace(href);
        },
        (e: unknown) => {
          if (!isRedirect(e)) router.replace("/inbox");
        },
      );
  }, [id, router]);
  return (
    <p className="p-6 text-sm text-muted-foreground" role="status">
      {t("opening")}
    </p>
  );
}
