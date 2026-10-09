"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useOptimistic, useTransition } from "react";

import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";

export type InvoiceFilterOption = { readonly value: string; readonly label: string };

/**
 * `/invoices`' one filter: every client, or one (`?client=`), read by the
 * server page so a filtered view is a link. `value` is a REQUIRED prop — the
 * server's reading of the URL — shown optimistically while the navigation
 * runs and the server's again when it settles; never re-keyed and never
 * disabled (either would drop focus to the page). `/vault`'s filter's rule.
 */
export function InvoiceFilter({ value, options }: { value: string; options: readonly InvoiceFilterOption[] }) {
  const t = useTranslations("invoices.list");
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [shown, setShown] = useOptimistic(value);
  return (
    <div className="flex min-w-0 items-center gap-2" data-testid="invoice-filter">
      <Label htmlFor="invoice-filter" className="text-sm text-muted-foreground">
        {t("filter")}
      </Label>
      <NativeSelect
        id="invoice-filter"
        className="w-auto max-w-full"
        value={shown}
        onChange={(e) => {
          const next = e.target.value;
          startTransition(() => {
            setShown(next);
            router.push(next === "" ? "/invoices" : `/invoices?client=${encodeURIComponent(next)}`, { scroll: false });
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
