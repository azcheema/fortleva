"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useOptimistic, useTransition } from "react";

import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";

export type PortfolioFilterOption = { readonly value: string; readonly label: string };

/**
 * The project health table's one filter: every client, or one (`?client=`),
 * read by the server page so a filtered view is a link — `/invoices`' filter
 * (`invoice-filter.tsx`), keeping "Show finished" (`finished=1`) as it goes.
 * `value` is a REQUIRED prop, the server's reading of the URL, shown
 * optimistically while the navigation runs; never re-keyed, never disabled.
 */
export function PortfolioFilter({
  value,
  finished,
  options,
}: {
  value: string;
  finished: boolean;
  options: readonly PortfolioFilterOption[];
}) {
  const t = useTranslations("reports.health");
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [shown, setShown] = useOptimistic(value);
  return (
    <div className="flex min-w-0 items-center gap-2" data-testid="portfolio-filter">
      <Label htmlFor="portfolio-filter" className="text-sm text-muted-foreground">
        {t("filter")}
      </Label>
      <NativeSelect
        id="portfolio-filter"
        className="w-auto max-w-full"
        value={shown}
        onChange={(e) => {
          const next = e.target.value;
          const params = new URLSearchParams();
          if (next !== "") params.set("client", next);
          if (finished) params.set("finished", "1");
          const query = params.toString();
          startTransition(() => {
            setShown(next);
            router.push(query === "" ? "/reports" : `/reports?${query}`, { scroll: false });
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
