"use client";

import { CopyIcon, TimerIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { useVaultFailure } from "./use-vault-failure";
import { vaultCall } from "./vault-call";
import { vaultClipboard } from "./vault-clipboard";

type Code = { readonly code: string; readonly expiresAt: number };

/** "123456" → "123 456"; an 8-digit code → "1234 5678". Display only — the copy is the raw code. */
const grouped = (code: string) => (code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : `${code.slice(0, 3)} ${code.slice(3)}`);

/** A held Enter auto-repeats; a repeat must not press again. */
const swallowRepeat = (e: React.KeyboardEvent<HTMLButtonElement>) => {
  if (e.repeat && (e.key === "Enter" || e.key === " ")) e.preventDefault();
};

/**
 * THE CURRENT ONE-TIME CODE of a credential that carries an authenticator
 * key. One press, one code, one audited `credential.totp_generated` — and
 * it is NEVER fetched again by itself: a countdown that refreshed would
 * spend the member's reveal budget twice a minute (slice 82's note). When
 * the code expires it goes, and the button comes back.
 *
 * The countdown is what the SERVER said the code had left, laid on this
 * browser's clock from the moment the answer arrived — so a browser clock
 * that disagrees with the server's moves nothing.
 *
 * For a keyboard and a screen reader (slice 85's code review): the live
 * region is always mounted, so a code that appears in it is announced;
 * and focus FOLLOWS the swap — to the copy button when the code arrives,
 * back to "Show code" when it expires — instead of dropping to the page
 * when the focused control unmounts.
 *
 * Copying the shown code needs no second server call — it is already on
 * the screen and already audited — but goes through the same clipboard
 * guard, so it clears itself too.
 */
export function TotpField({ credentialId, label, canReveal }: { credentialId: string; label: string; canReveal: boolean }) {
  const t = useTranslations("vault");
  const fail = useVaultFailure();
  const [shown, setShown] = useState<Code | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const rootRef = useRef<HTMLDivElement>(null);
  const showRef = useRef<HTMLButtonElement>(null);
  const copyRef = useRef<HTMLButtonElement>(null);
  // Set when KEYBOARD focus was inside the field as it swapped; the effect
  // below puts it on the control that took the other's place. A mouse
  // press does not move focus on (its tooltip would cover the row).
  const refocus = useRef(false);
  const keyboardFocusInside = () => {
    const el = document.activeElement;
    return el instanceof HTMLElement && (rootRef.current?.contains(el) ?? false) && el.matches(":focus-visible");
  };

  // One tick a second while a code is shown; the tick that finds it
  // expired takes it away (and the button comes back).
  useEffect(() => {
    if (shown === null) return;
    const tick = window.setInterval(() => {
      const at = Date.now();
      if (at >= shown.expiresAt) {
        refocus.current = keyboardFocusInside();
        setShown(null);
      } else setNow(at);
    }, 1000);
    return () => window.clearInterval(tick);
  }, [shown]);

  useEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    (shown === null ? showRef : copyRef).current?.focus();
  }, [shown]);

  const left = shown === null ? 0 : Math.max(1, Math.ceil((shown.expiresAt - now) / 1000));

  const show = async () => {
    if (busy) return;
    // Read BEFORE the button disables: a disabled button drops its focus.
    const hadFocus = keyboardFocusInside();
    setBusy(true);
    const r = await vaultCall<{ code: string; period: number; msLeft: number }>(credentialId, "totp");
    setBusy(false);
    if (!r.ok) {
      fail(r.error);
      return;
    }
    const arrived = Date.now();
    const msLeft = Math.min(r.value.period * 1000, Math.max(0, r.value.msLeft));
    refocus.current = hadFocus;
    setNow(arrived);
    setShown({ code: r.value.code, expiresAt: arrived + msLeft });
  };

  const copy = () => {
    if (shown === null) return;
    vaultClipboard()
      .copy(shown.code)
      .then(
        () => toast.success(t("copy.done", { field: label })),
        () => toast.error(t("copy.failed")),
      );
  };

  return (
    <div ref={rootRef} className="flex min-w-0 items-center gap-2" data-slot="totp-field">
      <span className="w-28 shrink-0 text-xs text-muted-foreground">{label}</span>
      {/* Always mounted, so the code that appears in it is announced — and
          ONLY the code: a countdown in here would be read out every second. */}
      <span aria-live="polite" className="flex items-center">
        {shown !== null ? (
          <span data-testid="totp-code" className="pl-2.5 font-mono text-sm tracking-wider">
            {grouped(shown.code)}
          </span>
        ) : null}
      </span>
      {shown !== null ? (
        <span className="num text-xs text-muted-foreground">{t("totp.secondsLeft", { seconds: left })}</span>
      ) : null}
      {shown !== null ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              ref={copyRef}
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("copy.label", { field: label })}
              data-vault-copy=""
              onKeyDown={swallowRepeat}
              onClick={copy}
            >
              <CopyIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("copy.label", { field: label })}</TooltipContent>
        </Tooltip>
      ) : canReveal ? (
        <Button ref={showRef} type="button" variant="outline" size="sm" disabled={busy} onKeyDown={swallowRepeat} onClick={show}>
          <TimerIcon />
          {t("totp.show")}
        </Button>
      ) : (
        <span className="text-sm text-muted-foreground">{t("totp.set")}</span>
      )}
    </div>
  );
}
