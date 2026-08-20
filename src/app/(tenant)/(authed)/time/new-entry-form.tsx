"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useActionState, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Field, FormMessage, SectionCard } from "@/components/semantic";
import { notifyTimerChanged } from "@/components/shell/timer-pill";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeCheckbox } from "@/components/ui/native-checkbox";
import { NativeSelect } from "@/components/ui/native-select";
import type { FormResult } from "@/lib/server-actions";

import { createEntryAction, pickerOptionsAction } from "./actions";
import type { PickerOption, PickerProject } from "./quick-start";

/**
 * "New entry" (`N` on /time; UI.md rule 9): a finished entry typed in —
 * either a duration ("1h 30m" / "90m" / "1,5") on a date, or a start
 * and end time on a date (past midnight = one row on the start date).
 * A real <form action>: a create form WANTS the reset React performs
 * after the action (the trap applies to controls that mirror server
 * state, not to an empty form). Errors stay on screen as a FormMessage.
 */
export function NewEntryForm({
  today,
  projects,
  workTypes,
}: {
  today: string;
  projects: PickerProject[];
  workTypes: PickerOption[];
}) {
  const t = useTranslations("time.newEntry");
  const router = useRouter();
  const [state, action, pending] = useActionState<FormResult | null, FormData>(
    async (_prev, fd) => createEntryAction(fd),
    null,
  );
  const [projectId, setProjectId] = useState("");
  const [options, setOptions] = useState<{ items: PickerOption[]; services: PickerOption[] }>({ items: [], services: [] });
  const optionsRequest = useRef(0);

  const chooseProject = (next: string) => {
    setProjectId(next);
    const token = ++optionsRequest.current;
    const project = projects.find((p) => p.id === next);
    if (!next || !project) {
      setOptions({ items: [], services: [] });
      return;
    }
    void pickerOptionsAction(next, project.clientId).then((r) => {
      if (optionsRequest.current !== token) return;
      if (r.ok) setOptions({ items: r.value.items.map((i) => ({ id: i.id, name: i.label })), services: r.value.services });
    });
  };

  useEffect(() => {
    if (state?.ok) {
      toast.success(state.message);
      notifyTimerChanged();
      router.refresh();
    }
  }, [state, router]);

  return (
    <SectionCard id="new-entry" title={t("title")} description={t("description")} className="scroll-mt-16">
      <form action={action} className="grid grid-cols-1 items-end gap-3 md:grid-cols-6">
        <Field htmlFor="ne-date" label={t("date")}>
          <Input id="ne-date" name="date" type="date" defaultValue={today} required />
        </Field>
        <Field htmlFor="ne-duration" label={t("duration")} hint={t("durationHint")}>
          <Input id="ne-duration" name="duration" placeholder={t("durationPlaceholder")} autoComplete="off" data-testid="new-entry-duration" />
        </Field>
        <Field htmlFor="ne-start" label={t("start")}>
          <Input id="ne-start" name="start" type="time" />
        </Field>
        <Field htmlFor="ne-end" label={t("end")}>
          <Input id="ne-end" name="end" type="time" />
        </Field>
        <Field htmlFor="ne-project" label={t("project")} className="md:col-span-2">
          <NativeSelect id="ne-project" name="projectId" value={projectId} onChange={(e) => chooseProject(e.target.value)}>
            <option value="">{t("noProject")}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.key} · {p.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field htmlFor="ne-task" label={t("task")} className="md:col-span-2">
          <NativeSelect id="ne-task" name="workItemId" disabled={!projectId} defaultValue="">
            <option value="">{t("noTask")}</option>
            {options.items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field htmlFor="ne-agreement" label={t("agreement")}>
          <NativeSelect id="ne-agreement" name="serviceId" disabled={!projectId} defaultValue="">
            <option value="">{t("defaultAgreement")}</option>
            {options.services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field htmlFor="ne-type" label={t("workType")}>
          <NativeSelect id="ne-type" name="workTypeId" defaultValue="">
            <option value="">{t("noWorkType")}</option>
            {workTypes.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field htmlFor="ne-description" label={t("note")} className="md:col-span-4">
          <Input id="ne-description" name="description" placeholder={t("notePlaceholder")} autoComplete="off" data-testid="new-entry-description" />
        </Field>
        <div className="flex items-center gap-3 md:col-span-2">
          <input type="hidden" name="billableMarker" value="1" />
          <label className="flex items-center gap-2 text-sm">
            <NativeCheckbox name="billable" defaultChecked disabled={!projectId} />
            {t("billable")}
          </label>
          <Button type="submit" size="sm" disabled={pending} className="ml-auto" data-testid="new-entry-submit">
            {t("add")}
          </Button>
        </div>
        <FormMessage state={state?.ok ? null : state} className="md:col-span-6" />
      </form>
    </SectionCard>
  );
}
