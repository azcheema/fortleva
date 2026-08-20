"use client";

import { PlayIcon, SquareIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { Field, SectionCard } from "@/components/semantic";
import { notifyTimerChanged } from "@/components/shell/timer-pill";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeCheckbox } from "@/components/ui/native-checkbox";
import { NativeSelect } from "@/components/ui/native-select";
import { formatDurationClock } from "@/lib/format";

import { pickerOptionsAction, startTimerAction, stopTimerAction, undoStartAction } from "./actions";

export type PickerProject = { id: string; key: string; name: string; clientId: string; clientName: string };
export type PickerOption = { id: string; name: string };

export type RunningView = {
  id: string;
  label: string;
  projectKey: string | null;
  startedAt: string;
  description: string | null;
};

/**
 * The quick start (UI.md rule 9): type what you are doing, optionally pick
 * a project → task → agreement → work type, start. Plain text with no
 * project = an instant (ad-hoc) task (D2). While a timer runs, the card
 * shows it ticking with a Stop button ABOVE the form — the form stays, so
 * starting another timer is one gesture: it auto-stops the running one
 * (same transaction) and the toast offers UNDO.
 */
export function QuickStart({
  running,
  projects,
  workTypes,
  serverNow,
  noticeRequired,
}: {
  running: RunningView | null;
  projects: PickerProject[];
  workTypes: PickerOption[];
  serverNow: string;
  noticeRequired: boolean;
}) {
  const t = useTranslations("time.quickStart");
  const locale = useLocale();
  const router = useRouter();
  const [pending, start] = useTransition();

  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState("");
  const [workItemId, setWorkItemId] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [workTypeId, setWorkTypeId] = useState("");
  const [billable, setBillable] = useState<"" | "yes" | "no">("");
  const [options, setOptions] = useState<{ items: PickerOption[]; services: PickerOption[] }>({ items: [], services: [] });
  const optionsRequest = useRef(0);

  // Task + agreement options follow the project (lazy; ids only). Done in
  // the change handler — the dependent selects reset with the project.
  const chooseProject = (next: string) => {
    setProjectId(next);
    setWorkItemId("");
    setServiceId("");
    const token = ++optionsRequest.current;
    const project = projects.find((p) => p.id === next);
    if (!next || !project) {
      setOptions({ items: [], services: [] });
      return;
    }
    void pickerOptionsAction(next, project.clientId).then((r) => {
      if (optionsRequest.current !== token) return;
      if (r.ok) setOptions({ items: r.value.items.map((i) => ({ id: i.id, name: i.label })), services: r.value.services });
      else toast.error(r.message);
    });
  };

  const startTimer = () =>
    start(async () => {
      const r = await startTimerAction({
        projectId: projectId || null,
        workItemId: workItemId || null,
        serviceId: serviceId || null,
        workTypeId: workTypeId || null,
        description: description.trim() || null,
        billable: billable === "" ? null : billable === "yes",
      }).catch(() => ({ ok: false as const, message: t("failed") }));
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      const { startedId, stoppedId, stoppedLabel } = r.value;
      if (stoppedId) {
        toast.success(t("startedStopped", { label: stoppedLabel ?? "" }), {
          action: {
            label: t("undo"),
            onClick: () => {
              start(async () => {
                const u = await undoStartAction({ startedId, resumeId: stoppedId }).catch(() => ({ ok: false as const, message: t("failed") }));
                if (!u.ok) toast.error(u.message);
                else toast.success(u.message);
                notifyTimerChanged();
                router.refresh();
              });
            },
          },
        });
      } else {
        toast.success(t("started"));
      }
      setDescription("");
      notifyTimerChanged();
      router.refresh();
    });

  const stop = () =>
    start(async () => {
      const r = await stopTimerAction().catch(() => ({ ok: false as const, message: t("failed") }));
      if (!r.ok) toast.error(r.message);
      else toast.success(t("stopped", { duration: formatDurationClock(locale, r.value.durationSeconds) }));
      notifyTimerChanged();
      router.refresh();
    });

  const canStart = !pending && (projectId !== "" || description.trim() !== "") && !noticeRequired;

  return (
    <SectionCard
      id="quick-start"
      title={running ? t("runningTitle") : t("title")}
      description={noticeRequired ? t("noticeFirst") : running ? running.label : t("description")}
      actions={
        running ? (
          <Button type="button" size="sm" onClick={stop} disabled={pending} data-testid="quick-start-stop">
            <SquareIcon aria-hidden="true" />
            {t("stop")}
          </Button>
        ) : null
      }
    >
      {running ? (
        <div className="mb-4 flex items-baseline gap-3">
          <RunningClock startedAt={running.startedAt} serverNow={serverNow} />
          <span className="text-xs text-muted-foreground">{t("startAnotherHint")}</span>
        </div>
      ) : null}
      <form
        className="grid grid-cols-1 items-end gap-3 md:grid-cols-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (canStart) startTimer();
        }}
      >
        <Field htmlFor="qs-description" label={t("what")} className="md:col-span-2">
          <Input
            id="qs-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("whatPlaceholder")}
            autoComplete="off"
            data-testid="quick-start-description"
          />
        </Field>
        <Field htmlFor="qs-project" label={t("project")}>
          <NativeSelect id="qs-project" value={projectId} onChange={(e) => chooseProject(e.target.value)} data-testid="quick-start-project">
            <option value="">{t("noProject")}</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.key} · {p.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field htmlFor="qs-task" label={t("task")}>
          <NativeSelect id="qs-task" value={workItemId} onChange={(e) => setWorkItemId(e.target.value)} disabled={!projectId}>
            <option value="">{t("noTask")}</option>
            {options.items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field htmlFor="qs-agreement" label={t("agreement")}>
          <NativeSelect id="qs-agreement" value={serviceId} onChange={(e) => setServiceId(e.target.value)} disabled={!projectId}>
            <option value="">{t("defaultAgreement")}</option>
            {options.services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field htmlFor="qs-type" label={t("workType")}>
          <NativeSelect id="qs-type" value={workTypeId} onChange={(e) => setWorkTypeId(e.target.value)}>
            <option value="">{t("noWorkType")}</option>
            {workTypes.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <div className="flex items-center gap-3 md:col-span-6">
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
          <Button type="submit" size="sm" disabled={!canStart} className="ml-auto" data-testid="quick-start-start">
            <PlayIcon aria-hidden="true" />
            {running ? t("startAnother") : t("start")}
          </Button>
        </div>
      </form>
    </SectionCard>
  );
}

function RunningClock({ startedAt, serverNow }: { startedAt: string; serverNow: string }) {
  const locale = useLocale();
  const [skew] = useState(() => Date.now() - Date.parse(serverNow));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const elapsed = Math.max(0, Math.floor((now - skew - Date.parse(startedAt)) / 1000));
  return (
    <p className="num text-3xl font-semibold tabular-nums" data-testid="quick-start-elapsed">
      {formatDurationClock(locale, elapsed)}
    </p>
  );
}
