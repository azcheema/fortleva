"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Field, FormMessage, SectionCard } from "@/components/semantic";
import { notifyTimerChanged } from "@/components/shell/timer-pill";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeCheckbox } from "@/components/ui/native-checkbox";
import { NativeSelect } from "@/components/ui/native-select";
import type { FormResult } from "@/lib/server-actions";

import { createEntryAction } from "./actions";
import type { PickerOption, PickerProject } from "./picker-types";
import { useProjectPickerOptions } from "./use-project-picker-options";

/**
 * "New entry" (`N` on /time; UI.md rule 9): a finished entry typed in —
 * either a duration ("1h 30m" / "90m" / "1,5") on a date, or a start
 * and end time on a date (past midnight = one row on the start date).
 *
 * Submitted from onSubmit in a transition, NOT as a `<form action>`:
 * React 19 resets a form action's uncontrolled fields when the action
 * settles — on failure too — which wiped a typo'd duration, the note and
 * every select (the standing trap, PLAN.md §0). Here the form is reset
 * by hand, only after success. Billable is tri-state like the quick
 * start: indeterminate = the work type's / project's default decides.
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
  const [pending, start] = useTransition();
  const [failure, setFailure] = useState<FormResult | null>(null);
  const [projectId, setProjectId] = useState("");
  const [billable, setBillable] = useState<"" | "yes" | "no">("");
  const { options, load } = useProjectPickerOptions(projects);

  const chooseProject = (next: string) => {
    setProjectId(next);
    load(next);
  };

  const submit = (form: HTMLFormElement) =>
    start(async () => {
      const r = await createEntryAction(new FormData(form)).catch(() => ({ ok: false, message: t("failed") }));
      if (!r.ok) {
        setFailure(r);
        return;
      }
      setFailure(null);
      form.reset();
      chooseProject("");
      setBillable("");
      toast.success(r.message);
      notifyTimerChanged();
      router.refresh();
    });

  return (
    <SectionCard id="new-entry" title={t("title")} description={t("description")} className="scroll-mt-16">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(e.currentTarget);
        }}
        className="grid grid-cols-1 items-end gap-3 md:grid-cols-6"
      >
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
          {/* "" ⇒ the default decides; "1" / "0" ⇒ explicit (the action maps it to null / true / false). */}
          <input type="hidden" name="billable" value={billable === "" ? "" : billable === "yes" ? "1" : "0"} />
          <label className="flex items-center gap-2 text-sm">
            <NativeCheckbox
              checked={billable === "yes"}
              ref={(el) => {
                if (el) el.indeterminate = billable === "";
              }}
              onChange={(e) => setBillable(e.target.checked ? "yes" : "no")}
              disabled={!projectId}
              aria-label={t("billable")}
            />
            {projectId ? (billable === "" ? t("billableDefault") : t("billable")) : t("adhocNonBillable")}
          </label>
          <Button type="submit" size="sm" disabled={pending} className="ml-auto" data-testid="new-entry-submit">
            {t("add")}
          </Button>
        </div>
        <FormMessage state={failure} className="md:col-span-6" />
      </form>
    </SectionCard>
  );
}
