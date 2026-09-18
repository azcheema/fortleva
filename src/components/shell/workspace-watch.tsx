"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { switchWorkspaceAction } from "@/app/(tenant)/(authed)/dashboard/actions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useFocusReturn } from "@/components/ui/use-focus-return";
import {
  isHere,
  isStale,
  isWho,
  WORKSPACE_CHANNEL,
  type WorkspaceMessage,
} from "@/lib/workspace-watch";

import { useScopeKeys } from "./use-hotkeys";

/**
 * THE STALE-TAB FENCE, the half that touches the browser. The protocol,
 * and why this belongs here rather than at the database seam, are in
 * `src/lib/workspace-watch.ts` — read that first.
 *
 * Mounted once by the shell, on every authed page, for a member who is
 * IN a workspace. It answers one question: has another tab moved this
 * session's active workspace since the server rendered this one? When it
 * has, this tab is showing one workspace and writing to another, so the
 * tab stops being usable — and says so — instead of quietly creating the
 * member's next client in a workspace they are not looking at.
 *
 * A MODAL DIALOG, not a banner, and not `inert` on the shell. A banner
 * leaves every control clickable, and the write it has to stop is one
 * click. `inert` would be the right shape for the page, but the surfaces
 * that most need stopping — the item peek, any picker, a confirm — are
 * Radix PORTALS at the end of `<body>`, outside the shell subtree it
 * would cover. A modal layer is the one thing that sits over all of
 * them, and it is the product's own mechanism rather than a second one.
 *
 * It cannot be dismissed: `onOpenChange` ignores every close, so Escape
 * and a click outside leave it standing. There is no close button for
 * the same reason. Both verbs it offers resolve the split rather than
 * hide it — reload into the workspace the session is actually in, or put
 * the session back into the one this tab is showing.
 *
 * `tenantId` and `tenantName` are REQUIRED props, `null` meaning "this
 * member is in no workspace" (the picker with nothing picked). State a
 * shared component must reflect is a prop, never a default (the standing
 * trap), and a fence that silently defaults to "nothing to watch" is a
 * fence that is not there.
 *
 * `at` is the third, and it is what makes the fence SYMMETRIC rather
 * than one-way. The shell keys this component on `tenantId` AND `at`, so
 * a watcher is per SERVER RENDER: every time the layout is re-rendered
 * — which is every time the session's workspace could have moved, since
 * switching sweeps the router cache with `revalidatePath("/", "layout")`
 * — this tab starts a fresh watcher, clears `stale`, and announces
 * itself with a newer stamp than anyone else holds.
 *
 * Without that, "Go back to {name}" would be a half-fix: it puts the
 * session pointer back into THIS tab's workspace, which makes the other
 * tab the stale one — but the other tab would never hear, because
 * nothing about this tab's own workspace changed. It would go on making
 * create-shaped writes into a workspace it is not showing, which is the
 * exact hazard, just pointing the other way. A review caught it; the
 * e2e below passed anyway, on a remount that happened to fall out of
 * the redirect, which is not a thing to depend on.
 *
 * Keying it also clears `stale` without a setState in an effect body,
 * the cascading-render shape the lint rule refuses — and it is the
 * truer statement: a new server render is a new watcher, not an old one
 * to reset.
 *
 * ONE RESIDUAL, named rather than papered over (security review,
 * 2026-09-18): `at` is a wall clock, so tabs served by two app instances
 * whose clocks disagree could fence the wrong one of the two. Nothing an
 * attacker steers and no tenant boundary crossed — the loser is fenced
 * out of a workspace it is a member of either way — and the alternative,
 * a monotonic counter, is a database write on every layout render. If
 * the product ever needs it, `Session.updatedAt` is the counter that is
 * already there.
 */
export function WorkspaceWatch({
  tenantId,
  tenantName,
  at,
}: {
  tenantId: string | null;
  tenantName: string | null;
  /** When the SERVER resolved `tenantId` for this render, ISO — see above. */
  at: string;
}) {
  const t = useTranslations("shell.workspaceChanged");
  const router = useRouter();
  const [stale, setStale] = useState(false);

  useEffect(() => {
    // A member on `/dashboard` with no active membership has no workspace
    // to be stale about, and there is no channel in a browser old enough
    // to lack one — in both cases the tab simply does not take part.
    if (!tenantId || typeof BroadcastChannel === "undefined") return;

    // WHEN this tab last learned its workspace, taken from the SERVER
    // render rather than from the clock at hydration. A tab opened in the
    // background — a ctrl-clicked link — can render before a switch and
    // hydrate after it, and a hydration stamp would make that tab look
    // like the newest truth: it would stay live AND fence the tab that is
    // actually in the session's workspace, which is the fence backwards.
    const mine = Date.parse(at);
    // Our own stamp, from our own layout — it cannot fail to parse. If it
    // ever did, a NaN would compare false in every direction and this tab
    // would neither be fenced nor fence anyone, silently; so it says so
    // instead of pretending to watch.
    if (!Number.isFinite(mine)) return;
    const own = { tenantId, at: mine };
    const channel = new BroadcastChannel(WORKSPACE_CHANNEL);
    const post = (message: WorkspaceMessage) => {
      // A channel closed by the cleanup of an effect that has already run
      // throws on post; nothing about this fence is worth an error overlay.
      try {
        channel.postMessage(message);
      } catch {
        /* the tab is going away */
      }
    };
    const here = () => post({ kind: "here", ...own });

    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (isWho(event.data)) {
        here();
        return;
      }
      if (isHere(event.data) && isStale(own, event.data)) setStale(true);
    };

    // Ask first, then announce. A tab mounting into a session another tab
    // has already moved learns it from the answers; the tabs that were
    // there learn about this one from the announcement.
    post({ kind: "who" });
    here();

    // A tab restored from the back/forward cache was FROZEN while the
    // switch happened and heard nothing — so it asks again on the way
    // back in. `persisted` only: an ordinary load has just mounted.
    //
    // And it asks the SERVER too, because `who` alone has a blind spot a
    // security review found: a member who switches and then goes Back
    // across a document boundary has a restored tab showing the old
    // workspace and NO PEER to answer it, so nothing would ever tell it.
    // `refresh()` re-renders the layout, which is the authoritative
    // answer — a new `tenantId` and a new `at`, so this watcher restarts
    // on the truth rather than waiting to be corrected by a tab that may
    // not exist.
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      post({ kind: "who" });
      router.refresh();
    };
    window.addEventListener("pageshow", onPageShow);

    return () => {
      window.removeEventListener("pageshow", onPageShow);
      channel.onmessage = null;
      channel.close();
    };
  }, [tenantId, at, router]);

  // The dialog owns the keyboard while it stands, for the stop confirm's
  // reason: its content is not a suppressing layer, so a single key
  // pressed on either button would otherwise reach the page behind — the
  // page this fence exists to stop being used. `exclusive` FOLLOWS the
  // open state (the standing trap: an unconditional exclusive scope kills
  // every key in the app).
  useScopeKeys("modal", [], { exclusive: stale });

  const focusReturn = useFocusReturn();
  const name = tenantName ?? "";

  return (
    <Dialog open={stale} onOpenChange={() => undefined}>
      <DialogContent showCloseButton={false} data-testid="workspace-changed" {...focusReturn}>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("body", { name })}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          {/* Staying here is a real answer, not a dismissal: it moves the
              session's pointer back to what this tab is showing, which
              makes the OTHER tab the stale one — the same trade the
              picker makes, stated out loud. The id is this tab's own
              rendered workspace, and `switchWorkspaceAction` re-derives
              the membership under RLS before it writes, so a tab left
              open past a membership being revoked lands on the picker
              with a notice rather than anywhere it should not be. */}
          <form action={switchWorkspaceAction}>
            <input type="hidden" name="tenantId" value={tenantId ?? ""} />
            <Button type="submit" variant="outline">
              {t("stay", { name })}
            </Button>
          </form>
          {/* A reload, not `router.refresh()`: the router cache in this
              tab is a whole workspace's worth of the wrong segments, and
              a refresh keeps the ones it is not told about. */}
          <Button onClick={() => window.location.reload()}>{t("reload")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
