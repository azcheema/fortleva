"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useOptimistic, useTransition } from "react";

import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";

export type VaultFilterOption = { readonly value: string; readonly label: string };

/**
 * `/vault`'s one filter: all, our own (C49 — offered only where the
 * member's scope reaches them), or one client. The choice is the URL's
 * (`?client=`), read by the server page, so a filtered view is a link and
 * survives the door; a change navigates there.
 *
 * `value` is a REQUIRED prop — the server's reading of the URL, never a
 * local default. The member's pick shows at once as an OPTIMISTIC value
 * for the length of the navigation, and when it settles the select is the
 * server's again: a pick the server did not honour (a client whose last
 * login went while the options were on screen falls back to "all") is
 * never left showing over a list it does not describe (slice 86's code
 * review; AGENTS.md's select-in-a-transition pattern). Never re-keyed and
 * never disabled while it navigates: either would drop keyboard focus to
 * the page body.
 */
export function VaultFilter({ value, options }: { value: string; options: readonly VaultFilterOption[] }) {
  const t = useTranslations("vault.tenant");
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [shown, setShown] = useOptimistic(value);
  return (
    <div className="flex min-w-0 items-center gap-2" data-testid="vault-filter">
      <Label htmlFor="vault-filter" className="text-sm text-muted-foreground">
        {t("filter")}
      </Label>
      <NativeSelect
        id="vault-filter"
        // As wide as its longest client's name, never the page: a 1,400 px
        // select reads as a search field. Capped so a long name cannot
        // push it past a phone's edge.
        className="w-auto max-w-full"
        value={shown}
        onChange={(e) => {
          const next = e.target.value;
          startTransition(() => {
            setShown(next);
            router.push(next === "" ? "/vault" : `/vault?client=${encodeURIComponent(next)}`, { scroll: false });
          });
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}
