"use client";

import { CopyIcon } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { startTransition, useActionState, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Field, FormMessage } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { useFocusReturn } from "@/components/ui/use-focus-return";
import type { ShareLinkView } from "@/modules/vault";

import { createShareLinkAction, listShareLinksAction, revokeShareLinkAction, type ShareCreateState } from "./actions";
import type { VaultSurface } from "./surface";
import { fieldLabelKey, type VaultItem } from "./vault-shape";

/** The lifetimes offered, in hours; each must be within the workspace's cap. */
const LIFETIMES = [1, 24, 72, 168] as const;

/** Three days when allowed, else the longest the workspace allows. */
const defaultLifetime = (maxHours: number): number =>
  LIFETIMES.includes(72) && 72 <= maxHours ? 72 : Math.max(...LIFETIMES.filter((h) => h <= maxHours), 1);

/**
 * SHARE ONE SECRET WITH SOMEBODY OUTSIDE (Phase 3V slice 90) — the row
 * menu's "Share…". A dialog, because it is a deliberate act with its own
 * confirmation: the member's authenticator code (sharing ALWAYS asks —
 * AUTHZ.md §7.5). It makes a link to ONE field, for one address, for a
 * lifetime the workspace allows; shows the link ONCE to copy (only its
 * hash is kept); and lists the login's links — every open one first, then
 * the newest that have ended — with Revoke on any still waiting.
 *
 * Opened from the row menu after the menu has gone (`afterClosingLayers`),
 * returning focus through `useFocusReturn` since it has no trigger of its
 * own. Its body lives INSIDE the content, which Radix unmounts on close,
 * so every opening starts blank: no typed code, no earlier link.
 */
export function ShareDialog({
  surface,
  item,
  maxHours,
  open,
  onOpenChange,
}: {
  surface: VaultSurface;
  item: VaultItem;
  /** `vault.shareLinkMaxTtlHours` — the longest a link may live here. */
  maxHours: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("vault.share");
  const focusReturn = useFocusReturn();
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent {...focusReturn} className="sm:max-w-lg" data-testid="share-dialog">
        <DialogHeader>
          <DialogTitle>{t("title", { name: item.name })}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <ShareBody surface={surface} item={item} maxHours={maxHours} onDone={close} />
      </DialogContent>
    </Dialog>
  );
}

function ShareBody({
  surface,
  item,
  maxHours,
  onDone,
}: {
  surface: VaultSurface;
  item: VaultItem;
  maxHours: number;
  onDone: () => void;
}) {
  const t = useTranslations("vault.share");
  const tVault = useTranslations("vault");
  const tCommon = useTranslations("common");
  const format = useFormatter();
  const [state, action, pending] = useActionState<ShareCreateState | null, FormData>(createShareLinkAction, null);
  const [links, setLinks] = useState<readonly ShareLinkView[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Bumped after a revoke, so the list reads again; a NEW link re-reads it
  // through `created` below.
  const [listVersion, setListVersion] = useState(0);
  const created = state?.ok ? state : null;

  useEffect(() => {
    let live = true;
    listShareLinksAction(surface, item.id).then(
      (r) => {
        if (!live) return;
        if (r.ok) {
          setLinks(r.value);
          setListError(null);
        } else setListError(r.message);
      },
      // A thrown action — the network, a 500, or the vault's window lapsing
      // (`runAction` redirects to the door, which reaches here as a
      // rejection) — must not leave "Loading…" forever (the code review).
      () => {
        if (live) setListError(tVault("errors.SERVER"));
      },
    );
    return () => {
      live = false;
    };
  }, [surface, item.id, listVersion, created, tVault]);

  const lifetimes = LIFETIMES.filter((h) => h <= maxHours);
  const fields = item.secretFieldKeys;
  const when = (d: Date) => format.dateTime(d, { dateStyle: "medium", timeStyle: "short" });

  const copyLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success(t("copied"));
    } catch {
      toast.error(t("copyFailed"));
    }
  };

  const revoke = async (linkId: string) => {
    try {
      const r = await revokeShareLinkAction(surface, linkId);
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
    } catch {
      toast.error(tVault("errors.SERVER"));
    } finally {
      // Whatever happened, the list says what is true now.
      setListVersion((v) => v + 1);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {created ? (
        <div className="flex flex-col gap-3" data-testid="share-created">
          <Field label={t("created.link")} htmlFor={`sh-${item.id}-url`}>
            <div className="flex min-w-0 items-center gap-2">
              <Input
                id={`sh-${item.id}-url`}
                readOnly
                value={created.url}
                className="min-w-0 flex-1 font-mono text-xs"
                onFocus={(e) => e.currentTarget.select()}
                data-testid="share-url"
              />
              <Button type="button" variant="outline" onClick={() => void copyLink(created.url)}>
                <CopyIcon aria-hidden="true" />
                {copied ? t("copiedShort") : t("copy")}
              </Button>
            </div>
          </Field>
          <p className="text-sm text-muted-foreground">
            {t("created.body", { email: created.email, date: when(created.expiresAt) })}
          </p>
          <DialogFooter>
            <Button type="button" onClick={onDone}>
              {t("done")}
            </Button>
          </DialogFooter>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            // NOT a `<form action>`: React 19 resets one after EVERY action,
            // a refusal included, and a mistyped code would empty the
            // address under the member (AGENTS.md's standing trap).
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            startTransition(() => action(fd));
          }}
          className="flex flex-col gap-3"
          data-testid="share-form"
        >
          <input type="hidden" name="surface" value={surface} />
          <input type="hidden" name="credentialId" value={item.id} />
          {fields.length === 1 ? (
            <p className="text-sm text-muted-foreground">
              <input type="hidden" name="field" value={fields[0]} />
              {t("fieldFixed", { field: tVault(fieldLabelKey(fields[0]!)) })}
            </p>
          ) : (
            <Field label={t("field")} htmlFor={`sh-${item.id}-field`}>
              <NativeSelect id={`sh-${item.id}-field`} name="field" defaultValue={fields[0]} disabled={pending}>
                {fields.map((k) => (
                  <option key={k} value={k}>
                    {tVault(fieldLabelKey(k))}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          )}
          <Field label={t("email")} htmlFor={`sh-${item.id}-email`} hint={t("emailHint")} required>
            <Input
              id={`sh-${item.id}-email`}
              name="email"
              type="email"
              required
              maxLength={320}
              autoComplete="off"
              disabled={pending}
            />
          </Field>
          <Field label={t("lifetime")} htmlFor={`sh-${item.id}-hours`}>
            <NativeSelect
              id={`sh-${item.id}-hours`}
              name="hours"
              defaultValue={String(defaultLifetime(maxHours))}
              disabled={pending}
            >
              {lifetimes.map((h) => (
                <option key={h} value={String(h)}>
                  {t(`lifetimes.${h}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          {item.username ? (
            <Label className="flex items-center gap-2.5 font-normal">
              <Checkbox name="includeUsername" value="1" defaultChecked disabled={pending} />
              {t("includeUsername")}
            </Label>
          ) : null}
          <Field label={t("code")} htmlFor={`sh-${item.id}-code`} hint={t("codeHint")} required>
            <Input
              id={`sh-${item.id}-code`}
              name="code"
              required
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={32}
              className="font-mono"
              disabled={pending}
            />
          </Field>
          {state && !state.ok ? <FormMessage state={state} /> : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onDone} disabled={pending}>
              {tCommon("cancel")}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? t("submitting") : t("submit")}
            </Button>
          </DialogFooter>
        </form>
      )}

      <section className="flex min-w-0 flex-col gap-2 border-t border-border pt-3" data-testid="share-links">
        <h3 className="text-sm font-medium text-foreground">{t("links.title")}</h3>
        {listError ? (
          <FormMessage state={{ ok: false, message: listError }} />
        ) : links === null ? (
          <p className="text-sm text-muted-foreground">{t("links.loading")}</p>
        ) : links.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("links.empty")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {links.map((link) => (
              <li
                key={link.id}
                className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 py-2"
                data-testid="share-link"
                data-status={link.status}
              >
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm text-foreground">{link.recipientEmail}</span>
                  <span className="text-xs text-muted-foreground">
                    {link.status === "waiting"
                      ? t("status.waiting", { date: when(link.expiresAt) })
                      : link.status === "viewed" || link.status === "revoked"
                        ? t(`status.${link.status}`, { date: when(link.closedAt ?? link.createdAt) })
                        : link.status === "expired"
                          ? t("status.expired", { date: when(link.expiresAt) })
                          : t(`status.${link.status}`)}
                  </span>
                </div>
                {link.status === "waiting" ? (
                  <Button type="button" variant="outline" size="sm" onClick={() => void revoke(link.id)}>
                    {t("revoke")}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
