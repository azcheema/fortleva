"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { base64UrlToBytes, endpointHashOf, madeWithKey, pushSupport } from "@/push/browser";

import { registerPushDeviceAction, removePushDeviceAction } from "./push-actions";

/**
 * "Phone and browser" — THIS device's switch and the member's device list
 * (Phase 5 slice 106; founder decision C74 (f): the only place a device is
 * turned on; no banner anywhere else, UI.md §3.3).
 *
 * WHAT THE BROWSER SAYS FIRST, then the button: not available on this server
 * (no key pair), can't take notifications here, iPhone/iPad not added to the
 * Home Screen yet (Apple's rule), blocked in the browser's settings, or off /
 * on. "On" means BOTH halves agree: this browser holds a subscription made with
 * this server's key AND the member has a device row for it (matched by a hash
 * of the endpoint — the endpoint itself never reaches the page).
 *
 * The verbs await their actions with a busy flag of their own, never a
 * transition (AGENTS.md: a transition around a revalidating action stays
 * pending until the whole page re-rendered); every refusal is toasted. Turning
 * off removes the row FIRST, so no push can follow, then drops the browser's
 * subscription.
 */

export type PushDeviceView = {
  readonly id: string;
  /** Already translated (an unknown device's label) on the server. */
  readonly label: string;
  /** "Added Oct 8, 2026" — formatted on the server, in the request's zone. */
  readonly added: string;
  readonly signedIn: boolean;
  readonly endpointHash: string;
};

type BrowserState = "checking" | "unavailable" | "unsupported" | "ios-install" | "blocked" | "off" | "on";

/** Next's redirect from a server action (a signed-out session) rejects the call — never a failure to report. */
const isRedirect = (e: unknown): boolean => {
  const digest = typeof e === "object" && e !== null ? (e as { digest?: unknown }).digest : undefined;
  return typeof digest === "string" && digest.startsWith("NEXT_REDIRECT");
};

/**
 * The worker's registration — waiting a moment for one. `PwaRegister` (in the
 * layout) registers it, asynchronously: on a browser's first visit this page
 * can ask before that registration exists, or before its worker is active.
 * `ready` resolves once one is active; none within three seconds (a
 * development build never registers one) is none.
 */
async function workerRegistration(): Promise<ServiceWorkerRegistration | undefined> {
  const existing = await navigator.serviceWorker.getRegistration("/");
  if (existing !== undefined && existing.active !== null) return existing;
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 3_000)),
  ]);
}

async function readBrowser(vapidPublicKey: string | null): Promise<{ state: BrowserState; hash: string | null }> {
  if (vapidPublicKey === null) return { state: "unavailable", hash: null };
  const support = pushSupport();
  if (support !== "supported") return { state: support, hash: null };
  if (Notification.permission === "denied") return { state: "blocked", hash: null };
  // No worker: a development build (`PwaRegister` registers only in
  // production) or a browser that refused it — nothing can arrive here.
  const registration = await workerRegistration();
  if (registration === undefined) return { state: "unsupported", hash: null };
  const subscription = await registration.pushManager.getSubscription();
  if (subscription === null || !madeWithKey(subscription, vapidPublicKey)) return { state: "off", hash: null };
  return { state: "on", hash: await endpointHashOf(subscription.endpoint) };
}

const currentSubscription = async (): Promise<PushSubscription | null> => {
  const registration = await workerRegistration();
  return registration === undefined ? null : registration.pushManager.getSubscription();
};

export function PushDevices({
  devices,
  vapidPublicKey,
}: {
  devices: readonly PushDeviceView[];
  vapidPublicKey: string | null;
}) {
  const t = useTranslations("settings.notifications.push");
  const router = useRouter();
  const [browser, setBrowser] = useState<{ state: BrowserState; hash: string | null }>({ state: "checking", hash: null });
  const [busy, setBusy] = useState(false);
  /**
   * The browser just turned on, until the refreshed list has its row (the code
   * review's low: without it the line read "off" and offered "Turn on" again
   * for the length of the refresh).
   */
  const [justOn, setJustOn] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    readBrowser(vapidPublicKey)
      .catch(() => ({ state: "unsupported" as const, hash: null }))
      .then((read) => {
        if (live) setBrowser(read);
      });
    return () => {
      live = false;
    };
  }, [vapidPublicKey]);

  const thisRow = browser.hash === null ? undefined : devices.find((d) => d.endpointHash === browser.hash);
  // The refreshed list has the row: the optimistic hold is done (the fix-pass
  // review's nit — kept, it showed "on" without a button once the row was later
  // removed elsewhere). Adjusted while rendering, React's pattern, not an effect.
  if (justOn !== null && thisRow !== undefined) setJustOn(null);
  // On only when the server has a row for this browser too — or has just made one.
  const shown: BrowserState =
    browser.state === "on" && thisRow === undefined && browser.hash !== justOn ? "off" : browser.state;

  const turnOn = async (): Promise<void> => {
    if (vapidPublicKey === null) return;
    setBusy(true);
    try {
      // First, inside the click: Safari asks only from a user gesture.
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        toast(t("denied"));
        setBrowser({ state: permission === "denied" ? "blocked" : "off", hash: null });
        return;
      }
      const registration = await workerRegistration();
      if (registration === undefined) {
        toast.error(t("failed"));
        return;
      }
      let subscription = await registration.pushManager.getSubscription();
      // One made with another key accepts nothing we send, and blocks a new one.
      if (subscription !== null && !madeWithKey(subscription, vapidPublicKey)) {
        await subscription.unsubscribe();
        subscription = null;
      }
      subscription ??= await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToBytes(vapidPublicKey),
      });
      const r = await registerPushDeviceAction(subscription.toJSON());
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      const hash = await endpointHashOf(subscription.endpoint);
      setJustOn(hash);
      setBrowser({ state: "on", hash });
      toast.success(t("turnedOn"));
      router.refresh();
    } catch (e) {
      if (isRedirect(e)) return;
      toast.error(t("failed"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (row: PushDeviceView): Promise<void> => {
    setBusy(true);
    try {
      const r = await removePushDeviceAction(row.id);
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      if (row.endpointHash === browser.hash) {
        // This browser too: the row is gone, so nothing more can be sent here.
        // The subscription itself is dropped only when no other workspace of
        // this person still uses it (one origin, one subscription) — dropping
        // it keeps a later sign-in from re-linking this one.
        // Nothing removed (the row was already gone — another tab, the drain):
        // nothing is known about the browser's other workspaces, so leave it.
        if (r.value.removed && !r.value.stillInUse) await (await currentSubscription())?.unsubscribe();
        setBrowser({ state: "off", hash: null });
        setJustOn(null);
        toast.success(t("turnedOff"));
      } else {
        toast.success(t("removed"));
      }
      router.refresh();
    } catch (e) {
      if (isRedirect(e)) return;
      toast.error(t("failed"));
    } finally {
      setBusy(false);
    }
  };

  const stateLine: Record<BrowserState, string | null> = {
    checking: null,
    unavailable: t("notConfigured"),
    unsupported: t("unsupported"),
    "ios-install": t("iosInstall"),
    blocked: t("blocked"),
    off: t("off"),
    on: t("on"),
  };

  return (
    <div className="mt-4 flex flex-col gap-4 border-t border-border pt-4" data-testid="push-devices">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium">{t("thisDevice")}</span>
          <span className="text-xs text-muted-foreground" data-testid="push-device-state" data-state={shown}>
            {stateLine[shown]}
          </span>
        </div>
        {shown === "off" ? (
          <Button onClick={() => void turnOn()} disabled={busy} data-testid="push-turn-on">
            {t("turnOn")}
          </Button>
        ) : shown === "on" && thisRow !== undefined ? (
          <Button variant="outline" onClick={() => void remove(thisRow)} disabled={busy} data-testid="push-turn-off">
            {t("turnOff")}
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">{t("stops")}</p>
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">{t("devices")}</h3>
        {devices.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noDevices")}</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border" data-testid="push-device-list">
            {devices.map((d) => (
              <li key={d.id} className="flex items-center gap-3 px-3 py-2" data-testid="push-device" data-device-id={d.id}>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="truncate text-sm">{d.label}</span>
                    {d.endpointHash === browser.hash ? <Badge variant="success">{t("thisDevice")}</Badge> : null}
                  </span>
                  <span className="text-xs text-muted-foreground">{d.signedIn ? d.added : t("signedOutLine", { added: d.added })}</span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void remove(d)}
                  disabled={busy}
                  aria-label={t("removeLabel", { device: d.label })}
                >
                  {t("remove")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
