"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useOptimistic, useTransition } from "react";

import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";

/**
 * The calendar's project filter (slice 128; C105 (a)) — the reports filter's
 * pattern (`reports/reports-filter.tsx`): a native select that writes `?project=`
 * and keeps the other parameters. The server reads the key against the
 * member's own scope, so a key typed into the URL is no filter unless it names
 * a project they reach.
 */
export function CalendarProjectFilter({
  label,
  value,
  options,
}: {
  label: string;
  /** The applied key, or "" for all projects. */
  value: string;
  options: readonly { readonly value: string; readonly label: string }[];
}) {
  const router = useRouter();
  const search = useSearchParams();
  const [, startTransition] = useTransition();
  const [shown, setShown] = useOptimistic(value);
  return (
    <div className="flex min-w-0 items-center gap-2" data-testid="calendar-project-filter">
      <Label htmlFor="calendar-project" className="text-sm text-muted-foreground">
        {label}
      </Label>
      <NativeSelect
        id="calendar-project"
        className="w-auto max-w-full"
        value={shown}
        onChange={(e) => {
          const next = e.target.value;
          const params = new URLSearchParams(search.toString());
          if (next === "") params.delete("project");
          else params.set("project", next);
          const query = params.toString();
          startTransition(() => {
            setShown(next);
            router.push(query === "" ? "/calendar" : `/calendar?${query}`, { scroll: false });
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
