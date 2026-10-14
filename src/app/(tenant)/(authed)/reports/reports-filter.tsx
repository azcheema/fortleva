"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useOptimistic, useTransition } from "react";

import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";

export type ReportsFilterOption = { readonly value: string; readonly label: string };

/**
 * One of `/reports`' two selects — the client (`?client=`, which scopes the
 * table and the charts) and the charts' period (`?period=`) — read by the
 * server page so a filtered view is a link. Choosing one KEEPS every other
 * parameter (the other select, "Show finished"); the value equal to
 * `fallback` is written as no parameter at all, so the default view is the
 * bare URL. `value` is a REQUIRED prop, the server's reading of the URL,
 * shown optimistically while the navigation runs; never re-keyed, never
 * disabled (`/invoices`' filter's rule).
 */
export function ReportsFilter({
  id,
  param,
  label,
  value,
  fallback,
  options,
}: {
  id: string;
  param: "client" | "period";
  label: string;
  value: string;
  /** The value that is written as no parameter. */
  fallback: string;
  options: readonly ReportsFilterOption[];
}) {
  const router = useRouter();
  const search = useSearchParams();
  const [, startTransition] = useTransition();
  const [shown, setShown] = useOptimistic(value);
  return (
    <div className="flex min-w-0 items-center gap-2" data-testid={id}>
      <Label htmlFor={id} className="text-sm text-muted-foreground">
        {label}
      </Label>
      <NativeSelect
        id={id}
        className="w-auto max-w-full"
        value={shown}
        onChange={(e) => {
          const next = e.target.value;
          const params = new URLSearchParams(search.toString());
          if (next === fallback) params.delete(param);
          else params.set(param, next);
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
