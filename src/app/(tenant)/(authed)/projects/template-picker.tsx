"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { Field } from "@/components/semantic";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";

export type TemplateChoiceView = { id: string; name: string; tasks: number };

/**
 * The New project forms' Template field and, once one is chosen, its
 * Start date (slice 124, C100 (a)): the template's dates are counted from
 * that day, so it is required while a template is chosen, and it starts
 * at today in the workspace's zone (`today`, from the server).
 *
 * The select is UNCONTROLLED — it posts `templateId` like every other field
 * of these forms. React resets the form after each action (and the forms
 * reset it after a success), and a reset changes a select's value without a
 * change event; so the form's own `reset` event is what puts the Start date
 * away again, and the two can never disagree.
 */
export function TemplatePicker({
  templates,
  today,
  idPrefix,
  disabled,
  classNames,
}: {
  templates: TemplateChoiceView[];
  today: string;
  idPrefix: string;
  disabled?: boolean;
  /** Widths in a wrapping row (a client's Projects tab); the /projects grid sizes its own cells. */
  classNames?: { template?: string; start?: string };
}) {
  const t = useTranslations("projects.create");
  const [chosen, setChosen] = useState("");
  const selectRef = useRef<HTMLSelectElement>(null);

  // Keyed on whether the select EXISTS: the Projects tab mounts this picker
  // before the workspace has a template, and a listener added on mount would
  // find no form (the code review's LOW).
  const shown = templates.length > 0;
  useEffect(() => {
    const form = selectRef.current?.form;
    if (!form) return;
    const onReset = () => setChosen("");
    form.addEventListener("reset", onReset);
    return () => form.removeEventListener("reset", onReset);
  }, [shown]);

  if (!shown) return null;
  return (
    <>
      <Field label={t("template")} htmlFor={`${idPrefix}-template`} className={classNames?.template}>
        <NativeSelect
          ref={selectRef}
          id={`${idPrefix}-template`}
          name="templateId"
          defaultValue=""
          onChange={(e) => setChosen(e.target.value)}
          disabled={disabled}
          data-testid="project-template"
        >
          <option value="">{t("noTemplate")}</option>
          {templates.map((tpl) => (
            <option key={tpl.id} value={tpl.id}>
              {t("templateOption", { name: tpl.name, count: tpl.tasks })}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {chosen !== "" ? (
        <Field
          label={t("startDate")}
          htmlFor={`${idPrefix}-start`}
          hint={t("startDateHint")}
          required
          className={classNames?.start}
        >
          <Input
            id={`${idPrefix}-start`}
            name="startDate"
            type="date"
            defaultValue={today}
            required
            className="num"
            disabled={disabled}
            data-testid="project-start-date"
          />
        </Field>
      ) : null}
    </>
  );
}
