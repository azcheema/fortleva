"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { AuthShell } from "@/app/(tenant)/login/auth-shell";
import { FormMessage } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { useFocusHeadingOnChange } from "@/components/use-focus-heading";

import { confirmReplyAddressAction } from "./actions";
import { ReplyAddressUnavailable } from "./reply-address-unavailable";

type View = "form" | "confirmed" | "dead";

/**
 * The reply-address confirmation's one control (Phase 5 slice 100; founder
 * decision C68 (f)) — `page.tsx` beside it holds why the page exists.
 *
 * ONE BUTTON, AND IT IS A REAL PRESS: rendering the page changes nothing, so
 * the mail scanner that opens every link in a business inbox confirms
 * nothing; a person reads which workspace asked and for which address, and
 * presses Confirm. Called from a click handler rather than as a `<form
 * action>` (React 19's form reset, AGENTS.md), with `busy` held so a second
 * press cannot follow the first. A network failure throws out of a
 * server-action call, so the call is wrapped — pressing again is safe either
 * way: a confirmed link is simply dead.
 *
 * The views that replace the button are announced through a live region that
 * exists before it fills, and focused at their heading.
 */
export function ReplyAddressConfirmForm({
  token,
  email,
  workspaceName,
}: {
  token: string;
  email: string;
  workspaceName: string;
}) {
  const t = useTranslations("replyAddress");
  const [view, setView] = useState<View>("form");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    setError(null);
    let result: Awaited<ReturnType<typeof confirmReplyAddressAction>>;
    try {
      result = await confirmReplyAddressAction(token);
    } catch {
      setBusy(false);
      setError(t("unreachable"));
      return;
    }
    setBusy(false);
    if (result.ok) {
      setView("confirmed");
      return;
    }
    if (result.reason === "tooMany") {
      setError(t("tooMany"));
      return;
    }
    setView("dead");
  }

  useFocusHeadingOnChange(view);
  const strong = (chunks: React.ReactNode) => <strong className="font-medium text-foreground">{chunks}</strong>;
  const announcement =
    view === "confirmed"
      ? `${t("confirmedTitle")}.`
      : view === "dead"
        ? `${t("unavailableTitle")}. ${t("unavailable")}`
        : "";

  return (
    <>
      {view === "dead" ? (
        <ReplyAddressUnavailable />
      ) : view === "confirmed" ? (
        <AuthShell
          title={t("confirmedTitle")}
          description={t.rich("confirmed", { email, workspace: workspaceName, strong })}
        />
      ) : (
        <AuthShell
          title={t("title")}
          description={t.rich("subtitle", { email, workspace: workspaceName, strong })}
        >
          <div className="flex flex-col gap-4">
            <Button type="button" size="lg" className="w-full" disabled={busy} onClick={confirm}>
              {busy ? t("submitting") : t("submit")}
            </Button>
            <p className="text-sm text-muted-foreground">{t("notYou")}</p>
            {error ? <FormMessage state={{ ok: false, message: error }} /> : null}
          </div>
        </AuthShell>
      )}
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </>
  );
}
