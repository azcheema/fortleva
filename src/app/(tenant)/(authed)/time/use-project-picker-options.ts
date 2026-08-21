"use client";

import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { pickerOptionsAction } from "./actions";
import type { PickerOptions, PickerProject } from "./picker-types";

const EMPTY: PickerOptions = { items: [], services: [] };

/**
 * The task + agreement options that follow a chosen project (the quick
 * start and the New-entry form share it): lazy, ids only, and raced
 * correctly — a slower answer for a project the member has already
 * left never overwrites the current one (the request token). The
 * caller keeps its own project state; this owns only the dependent
 * options and the fetch. `load("")` clears them.
 */
export function useProjectPickerOptions(projects: readonly PickerProject[]): {
  options: PickerOptions;
  load: (projectId: string) => void;
} {
  const tCommon = useTranslations("common");
  const [options, setOptions] = useState<PickerOptions>(EMPTY);
  const request = useRef(0);

  const load = (projectId: string) => {
    const token = ++request.current;
    const project = projects.find((p) => p.id === projectId);
    // The previous project's tasks must never be offered under the new one, not even for the in-flight window.
    setOptions(EMPTY);
    if (!projectId || !project) return;
    void pickerOptionsAction(projectId, project.clientId)
      .then((r) => {
        if (request.current !== token) return;
        if (r.ok) setOptions({ items: r.value.items.map((i) => ({ id: i.id, name: i.label })), services: r.value.services });
        else toast.error(r.message);
      })
      .catch(() => {
        // A dropped connection mid-deploy: say so, like every other action call here — never an unhandled rejection and two silently empty selects.
        if (request.current === token) toast.error(tCommon("loadFailed"));
      });
  };

  return { options, load };
}
