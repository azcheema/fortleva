"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { AuthShell } from "@/app/(tenant)/login/auth-shell";
import { FormMessage } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { useFocusHeadingOnChange } from "@/components/use-focus-heading";

import { setClientSummaryAction } from "./actions";

/**
 * THE WEEKLY SUMMARY'S ONE SWITCH (Phase 5 slice 101; founder decision C69) —
 * `page.tsx` beside it holds why the page exists.
 *
 * ONE BUTTON, AND IT IS A REAL PRESS: the page changed nothing when it was
 * drawn. It stops the summary, and once stopped offers to start it again —
 * which works only for the person themselves, signed in to their portal
 * (C69: nobody at the agency may; the link alone could have reached the
 * agency's mailbox in a reply), so a press without that session is told to
 * sign in and is brought back here. Called from a
 * click handler rather than as a `<form action>` (React 19's form reset,
 * AGENTS.md), with `busy` held so a second press cannot follow the first. A
 * network failure throws out of a server-action call, so the call is wrapped;
 * pressing again is safe either way — the change is idempotent.
 *
 * Each new state is announced through a live region that exists before it
 * fills, and focused at its heading.
 */
export function SummarySwitchForm({ token, on: initial }: { token: string; on: boolean }) {
  const t = useTranslations("clientSummary");
  const [on, setOn] = useState(initial);
  const [dead, setDead] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Only a CHANGE is announced: the state the page opened in is its heading.
  const [changed, setChanged] = useState(false);
  // Starting again needs the person's own portal session (C69): without one,
  // the press answers "signIn" and the page offers the way there and back.
  const [signIn, setSignIn] = useState(false);

  async function flip() {
    setBusy(true);
    setError(null);
    setSignIn(false);
    let result: Awaited<ReturnType<typeof setClientSummaryAction>>;
    try {
      result = await setClientSummaryAction(token, !on);
    } catch {
      setBusy(false);
      setError(t("unreachable"));
      return;
    }
    setBusy(false);
    if (result.ok) {
      setOn(result.on);
      setChanged(true);
      return;
    }
    if (result.reason === "tooMany") {
      setError(t("tooMany"));
      return;
    }
    if (result.reason === "signIn") {
      setSignIn(true);
      return;
    }
    setDead(true);
  }

  useFocusHeadingOnChange(dead ? "dead" : on ? "on" : "off");
  const announcement = dead
    ? `${t("unavailableTitle")}. ${t("unavailable")}`
    : changed
      ? `${on ? t("onTitle") : t("offTitle")}.`
      : "";

  return (
    <>
      {dead ? (
        <SummaryUnavailable />
      ) : (
        <AuthShell plane="portal" title={on ? t("onTitle") : t("offTitle")} description={on ? t("on") : t("off")}>
          <div className="flex flex-col gap-4">
            <Button
              type="button"
              size="lg"
              variant={on ? "default" : "outline"}
              className="w-full"
              disabled={busy}
              onClick={flip}
            >
              {busy ? (on ? t("stopping") : t("starting")) : on ? t("stop") : t("start")}
            </Button>
            {error ? <FormMessage state={{ ok: false, message: error }} /> : null}
            {signIn ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-muted-foreground">{t("signInToStart")}</p>
                <Button asChild variant="outline" className="w-full">
                  <Link href={`/portal/login?next=${encodeURIComponent(`/portal/unsubscribe/${token}`)}`} prefetch={false}>
                    {t("signIn")}
                  </Link>
                </Button>
              </div>
            ) : null}
          </div>
        </AuthShell>
      )}
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </>
  );
}

/**
 * THE ONE STATE FOR A LINK THAT CANNOT BE USED — malformed, signed under a
 * key since rotated, or naming a person no longer there — and, with `busy`, a
 * network over its budget. `readClientSummaryLink` answers the same null for
 * every dead link, so this says the same thing for all of them. No button:
 * the reader holds a mailbox, and there is nothing to sign in to for this.
 */
export function SummaryUnavailable({ busy = false }: { busy?: boolean }) {
  const t = useTranslations("clientSummary");
  return (
    <AuthShell
      plane="portal"
      title={busy ? t("tooManyTitle") : t("unavailableTitle")}
      description={busy ? t("tooMany") : t("unavailable")}
    />
  );
}
