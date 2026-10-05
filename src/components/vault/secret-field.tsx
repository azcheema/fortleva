"use client";

import { CopyIcon, EyeIcon, EyeOffIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { useVaultFailure } from "./use-vault-failure";
import { VaultRefusal, vaultCall, type VaultAnswer, type VaultRefusalCode } from "./vault-call";
import { vaultClipboard } from "./vault-clipboard";

/** A press longer than this is a HOLD (hidden on release); shorter is a TAP. */
export const HOLD_MS = 400;
/** How long a tap shows a value (C52 (b)). */
export const TAP_SHOW_MS = 10_000;
/** The ceiling on a HELD show: a release the button never hears must not leave a value up. */
export const HOLD_MAX_MS = 30_000;

/** Never the value's length: every masked value is the same row of dots. */
const MASK = "••••••••••";

/** A held Enter auto-repeats; each repeat would be another click — another audited reveal. */
const swallowRepeat = (e: React.KeyboardEvent<HTMLButtonElement>) => {
  if (e.repeat && (e.key === "Enter" || e.key === " ")) e.preventDefault();
};

/** How a field is fetched: the staff vault's routes by default, or the portal's actions (slice 91). */
export type SecretFieldCall = (kind: "reveal" | "copy", field: string) => Promise<VaultAnswer<{ value: string }>>;

/**
 * ONE SECRET FIELD, masked (C52 (b) and (c)). Nothing is fetched until the
 * member asks, and each ask is one audited reveal on their hourly budget.
 *
 * **The eye.** Held, it shows the value while held and hides it on
 * release. Tapped — a press shorter than `HOLD_MS`, or Enter / Space,
 * since a keyboard cannot hold — it shows the value for `TAP_SHOW_MS` and
 * hides it again; a second tap hides it at once. A press released BEFORE
 * the value arrived is a tap whatever its length: the member has not seen
 * it yet, and a reveal has been spent. A held show also ends at
 * `HOLD_MAX_MS`, on a lost pointer capture, when the window loses focus
 * and when the tab is hidden — a release the button never hears must not
 * leave a password on an unattended screen (slice 85's reviews). A tapped
 * value keeps its 10 s when the window is left, so it can be typed into
 * another program's window. A
 * long-press would open a phone's own menu, so the button refuses the
 * context menu and text selection. A shown value lives in React state and
 * nowhere else; hiding it drops it, and leaving the page drops it.
 *
 * **The copy.** A separate audited call (`credential.copied`), handed to
 * the page's clipboard guard INSIDE the click — Safari honours a write only
 * there — which then empties the clipboard when the member comes back, or
 * after 30 s if they stay (`src/lib/clipboard-guard.ts`). One at a time,
 * and an auto-repeating key presses it once.
 *
 * A member without `credential:reveal` gets the dots and no buttons
 * (§3.1: hidden, never disabled).
 */
export function SecretField({
  credentialId,
  field,
  label,
  canReveal,
  multiline = false,
  call,
  failureNamespace,
}: {
  credentialId: string;
  field: string;
  label: string;
  canReveal: boolean;
  /** A note or a private key: shown wrapped, in its own scroll box. */
  multiline?: boolean;
  /**
   * The CLIENT'S logins page (slice 91) fetches through its own server
   * actions — the contact's door, their budget, audited to them — instead
   * of the staff routes. Absent: `POST /api/vault/[id]/reveal|copy`.
   */
  call?: SecretFieldCall;
  /** Whose words a refusal is said in (`useVaultFailure`). */
  failureNamespace?: "vault.errors" | "portal.logins.errors";
}) {
  const t = useTranslations("vault");
  const fail = useVaultFailure(failureNamespace);
  // The staff path never rejects (`vaultCall` turns every failure into a
  // code); a SERVER ACTION does — the network, a server error, an ended
  // session's redirect (which the router follows by itself either way). So
  // a rejection here is a refusal too, or the eye would stay busy for good
  // (slice 91's code review).
  const fetchField = async (kind: "reveal" | "copy"): Promise<VaultAnswer<{ value: string }>> => {
    if (!call) return vaultCall<{ value: string }>(credentialId, kind, field);
    try {
      return await call(kind, field);
    } catch (e) {
      // An ended session's redirect is Next's own error (its digest says
      // so): "signed out", which refreshes — not "something went wrong".
      const digest = typeof e === "object" && e !== null ? (e as { digest?: unknown }).digest : undefined;
      return { ok: false, error: typeof digest === "string" && digest.startsWith("NEXT_REDIRECT") ? "SIGNED_OUT" : "SERVER" };
    }
  };
  const [value, setValue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The value as the handlers see it NOW: a release can land between the
  // fetch resolving and React re-rendering, when `value` in the handler's
  // closure is still null.
  const valueRef = useRef<string | null>(null);
  const hideTimer = useRef<number | null>(null);
  // The press in progress: when it began, and whether it ended before the
  // value arrived.
  const press = useRef<{ at: number; released: boolean } | null>(null);
  const copying = useRef(false);

  const stopTimer = () => {
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    hideTimer.current = null;
  };
  const hide = useCallback(() => {
    stopTimer();
    press.current = null;
    valueRef.current = null;
    setValue(null);
  }, []);
  const showFor = (v: string, ms: number) => {
    stopTimer();
    valueRef.current = v;
    setValue(v);
    hideTimer.current = window.setTimeout(hide, ms);
  };
  useEffect(() => hide, [hide]);

  // While a HELD value is up, leaving the window or the tab takes it down:
  // a release the button never hears. A TAPPED value keeps its 10 s — a
  // member reading a password into a remote-desktop window must be able to
  // click into it (slice 85's fix-pass review).
  const shown = value !== null;
  useEffect(() => {
    if (!shown) return;
    const leave = () => {
      if (press.current !== null) hide();
    };
    const onHidden = () => {
      if (document.visibilityState === "hidden") leave();
    };
    window.addEventListener("blur", leave);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("blur", leave);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, [shown, hide]);

  const fetchValue = async (): Promise<string | null> => {
    setBusy(true);
    let r: VaultAnswer<{ value: string }>;
    try {
      r = await fetchField("reveal");
    } finally {
      setBusy(false);
    }
    if (!r.ok) {
      fail(r.error);
      return null;
    }
    return r.value.value;
  };

  const onPointerDown = async (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (busy) return;
    // A value shown by a tap: this press hides it.
    if (valueRef.current !== null && press.current === null) {
      hide();
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    const current = { at: Date.now(), released: false };
    press.current = current;
    const v = valueRef.current ?? (await fetchValue());
    if (press.current !== current) return;
    if (v === null) {
      press.current = null;
      return;
    }
    if (!current.released) {
      // The window was left while the value was on its way: the blur that
      // would take a held value down has already happened (review round 3).
      if (!document.hasFocus() || document.visibilityState === "hidden") {
        press.current = null;
        return;
      }
      showFor(v, HOLD_MAX_MS); // held: until release, never past the ceiling
      return;
    }
    // Released before the value arrived: unseen, and already spent — a tap.
    press.current = null;
    showFor(v, TAP_SHOW_MS);
  };

  const onPointerEnd = () => {
    const current = press.current;
    if (current === null) return;
    if (valueRef.current === null) {
      current.released = true; // the fetch is in flight and decides
      return;
    }
    press.current = null;
    if (Date.now() - current.at < HOLD_MS) showFor(valueRef.current, TAP_SHOW_MS);
    else hide();
  };

  // The keyboard's press: Enter / Space arrive as a click with no pointer
  // (`detail === 0`). A pointer's click is the pointer handlers' business.
  const onClick = async (e: React.MouseEvent<HTMLButtonElement>) => {
    if (e.detail !== 0 || busy) return;
    if (valueRef.current !== null) {
      hide();
      return;
    }
    const v = await fetchValue();
    if (v !== null) showFor(v, TAP_SHOW_MS);
  };

  const onCopy = () => {
    if (copying.current) return;
    copying.current = true;
    // The promise is handed over NOW, inside the click. Its refusal is kept
    // HERE, not read off the rejection: WebKit rejects `clipboard.write`
    // with its own error, not the reason the item's promise rejected with.
    let refused: VaultRefusalCode | null = null;
    const promised = fetchField("copy").then((r) => {
      if (!r.ok) {
        refused = r.error;
        throw new VaultRefusal(r.error);
      }
      return r.value.value;
    });
    vaultClipboard()
      .copy(promised)
      .then(
        () => toast.success(t("copy.done", { field: label })),
        () => (refused !== null ? fail(refused) : toast.error(t("copy.failed"))),
      )
      .finally(() => {
        copying.current = false;
      });
  };

  return (
    <div className="flex min-w-0 items-start gap-2" data-slot="secret-field" data-field={field}>
      <span className="w-28 shrink-0 pt-1 text-xs text-muted-foreground">{label}</span>
      <span
        data-testid="secret-value"
        data-shown={shown ? "true" : "false"}
        aria-live="polite"
        // The value sits on the same 10px inset as the row's read-first text
        // above it, and the eye and copy follow it rather than the row's
        // far edge. A shown value WRAPS — a password cut off with "…" is a
        // password nobody can read — and a note or a key gets its own box.
        className={
          shown && multiline
            ? "min-w-0 flex-1 max-h-40 overflow-auto rounded-md bg-muted px-2.5 py-1 font-mono text-xs whitespace-pre-wrap break-all"
            : "min-w-0 pt-0.5 pl-2.5 font-mono text-sm break-all"
        }
      >
        {shown ? (
          value
        ) : (
          <>
            <span aria-hidden="true">{MASK}</span>
            <span className="sr-only">{t("reveal.hidden")}</span>
          </>
        )}
      </span>
      {canReveal ? (
        <span className="flex shrink-0 items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              {/* ONE name and a pressed state (the ARIA toggle-button
                  pattern): a name that also flips would be announced as
                  "Hide Password, pressed". */}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t("reveal.show", { field: label })}
                aria-pressed={shown}
                aria-busy={busy}
                className="touch-none select-none"
                onPointerDown={onPointerDown}
                onPointerUp={onPointerEnd}
                onPointerCancel={onPointerEnd}
                onLostPointerCapture={onPointerEnd}
                onContextMenu={(e) => e.preventDefault()}
                onKeyDown={swallowRepeat}
                onClick={onClick}
              >
                {shown ? <EyeOffIcon /> : <EyeIcon />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("reveal.show", { field: label })}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t("copy.label", { field: label })}
                data-vault-copy=""
                onKeyDown={swallowRepeat}
                onClick={onCopy}
              >
                <CopyIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("copy.label", { field: label })}</TooltipContent>
          </Tooltip>
        </span>
      ) : null}
    </div>
  );
}
