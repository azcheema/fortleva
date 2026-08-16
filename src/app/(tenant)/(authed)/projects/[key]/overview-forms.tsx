"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { toast } from "sonner";

import { AutoForm } from "@/components/auto-form";
import { InlineConfirm } from "@/components/inline-confirm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { isoDate, type FormResult } from "@/lib/server-actions";
import type { ProjectDetail } from "@/projects/service";

import {
  changeProjectKeyAction,
  changeProjectStatusAction,
  setHoursSharingAction,
  setPortalEnabledAction,
  setProjectArchivedAction,
  updateProjectAction,
} from "./actions";

const STATUSES = ["PLANNED", "ACTIVE", "PAUSED", "COMPLETED", "CANCELLED"] as const;
const CADENCES = ["NONE", "WEEKLY", "BIWEEKLY", "MONTHLY"] as const;
const HOURS_MODES = ["NONE", "HOURS", "BILLABLE_AMOUNT"] as const;

function Field({
  id,
  label,
  children,
  hint,
  className,
}: {
  id: string;
  label: React.ReactNode;
  children: React.ReactNode;
  hint?: string;
  className?: string;
}) {
  return (
    <div className={className ?? "flex flex-col gap-1"}>
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {children}
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

const useRun = () => {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<FormResult>, onOk?: (r: FormResult) => void) =>
    start(async () => {
      const r = await fn();
      if (r.ok) {
        toast.success(r.message);
        onOk?.(r);
      } else toast.error(r.message);
      router.refresh();
    });
  return { pending, run };
};

/** Public-ish project fields — auto-saving (UI.md §5.10). Read-only without project:edit. */
export function ProjectDetailsForm({
  project,
  members,
}: {
  project: ProjectDetail;
  members: { memberId: string; name: string }[];
}) {
  const t = useTranslations("projects.overview");
  const ro = !project.caps.edit || project.status === "ARCHIVED";
  return (
    <AutoForm action={updateProjectAction} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <input type="hidden" name="projectId" value={project.id} />
      <input type="hidden" name="projectKey" value={project.key} />
      <Field id="p-name" label={t("name")} className="flex flex-col gap-1 sm:col-span-2">
        <Input id="p-name" name="name" defaultValue={project.name} required readOnly={ro} />
      </Field>
      <Field id="p-type" label={t("type")}>
        <Input id="p-type" name="type" defaultValue={project.type ?? ""} placeholder={t("typePlaceholder")} readOnly={ro} />
      </Field>
      <Field id="p-lead" label={t("lead")}>
        <NativeSelect id="p-lead" name="leadMemberId" defaultValue={project.leadMemberId ?? ""} disabled={ro}>
          <option value="">{t("leadNone")}</option>
          {members.map((m) => (
            <option key={m.memberId} value={m.memberId}>
              {m.name}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field id="p-scope" label={t("scopeSummary")} className="flex flex-col gap-1 sm:col-span-2">
        <Textarea id="p-scope" name="scopeSummary" rows={3} defaultValue={project.scopeSummary ?? ""} readOnly={ro} />
      </Field>
      <Field id="p-start" label={t("startDate")}>
        <Input id="p-start" name="startDate" type="date" defaultValue={isoDate(project.startDate)} readOnly={ro} />
      </Field>
      <Field id="p-launch" label={t("launchDate")}>
        <Input id="p-launch" name="launchDate" type="date" defaultValue={isoDate(project.launchDate)} readOnly={ro} />
      </Field>
      <Field id="p-prod" label={t("productionUrl")}>
        <Input id="p-prod" name="productionUrl" type="url" defaultValue={project.productionUrl ?? ""} readOnly={ro} />
      </Field>
      <Field id="p-staging" label={t("stagingUrl")}>
        <Input id="p-staging" name="stagingUrl" type="url" defaultValue={project.stagingUrl ?? ""} readOnly={ro} />
      </Field>
      <Field id="p-currency" label={t("billingCurrency")}>
        <Input id="p-currency" name="billingCurrency" maxLength={3} defaultValue={project.billingCurrency ?? ""} className="uppercase" readOnly={ro} />
      </Field>
      <Field id="p-cadence" label={t("updateCadence")}>
        <NativeSelect id="p-cadence" name="updateCadence" defaultValue={project.updateCadence} disabled={ro}>
          {CADENCES.map((c) => (
            <option key={c} value={c}>
              {t(`cadences.${c}`)}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <div className="flex items-center gap-2 sm:col-span-2">
        <input type="hidden" name="defaultBillableMarker" value="1" />
        {/* Native checkbox: fires a real change event for the auto-saving form. */}
        <input
          id="p-billable"
          type="checkbox"
          name="defaultBillable"
          defaultChecked={project.defaultBillable}
          disabled={ro}
          className="size-4 rounded border-input accent-primary"
        />
        <Label htmlFor="p-billable" className="font-normal">
          {t("defaultBillable")}
        </Label>
      </div>
    </AutoForm>
  );
}

/** INTERNAL-only fields, marked private (UI.md rule 10; DATA_MODEL §6.5). */
export function ProjectInternalForm({ project }: { project: ProjectDetail }) {
  const t = useTranslations("projects.overview");
  const tCommon = useTranslations("common");
  const ro = !project.caps.edit || project.status === "ARCHIVED";
  const privateBadge = <Badge variant="secondary">{tCommon("private")}</Badge>;
  return (
    <AutoForm action={updateProjectAction} className="grid grid-cols-1 gap-3">
      <input type="hidden" name="projectId" value={project.id} />
      <input type="hidden" name="projectKey" value={project.key} />
      <p className="text-xs text-muted-foreground">{t("internalHint")}</p>
      <Field
        id="p-repo"
        label={
          <span className="flex items-center gap-2">
            {t("repoUrl")}
            {privateBadge}
          </span>
        }
      >
        <Input id="p-repo" name="repoUrl" type="url" defaultValue={project.repoUrl ?? ""} readOnly={ro} />
      </Field>
      <Field
        id="p-hosting"
        label={
          <span className="flex items-center gap-2">
            {t("hostingNotes")}
            {privateBadge}
          </span>
        }
        hint={t("hostingHint")}
      >
        <Textarea id="p-hosting" name="hostingNotes" rows={2} defaultValue={project.hostingNotes ?? ""} readOnly={ro} />
      </Field>
      <Field
        id="p-notes"
        label={
          <span className="flex items-center gap-2">
            {t("internalNotes")}
            {privateBadge}
          </span>
        }
      >
        <Textarea id="p-notes" name="internalNotes" rows={4} defaultValue={project.internalNotes ?? ""} readOnly={ro} />
      </Field>
    </AutoForm>
  );
}

/** Status select (commits on change), key change (Enter/blur), archive/restore. */
export function ProjectStatusControls({ project }: { project: ProjectDetail }) {
  const t = useTranslations("projects.overview");
  const tStatus = useTranslations("projects.status");
  const router = useRouter();
  const { pending, run } = useRun();
  const archived = project.status === "ARCHIVED";
  return (
    <div className="flex flex-col gap-4">
      <Field id="p-status" label={t("status")}>
        <NativeSelect
          id="p-status"
          value={archived ? "ARCHIVED" : project.status}
          disabled={!project.caps.edit || archived || pending}
          onChange={(e) => run(() => changeProjectStatusAction(project.id, project.key, e.target.value))}
          className="w-56"
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {tStatus(s)}
            </option>
          ))}
          {archived ? <option value="ARCHIVED">{tStatus("ARCHIVED")}</option> : null}
        </NativeSelect>
      </Field>
      {project.caps.edit && !archived ? (
        <AutoForm
          action={changeProjectKeyAction}
          onSaved={(r) => {
            if (r.message !== project.key && /^[A-Z][A-Z0-9]{0,7}$/.test(r.message)) {
              router.push(`/projects/${r.message}`);
            }
          }}
        >
          <input type="hidden" name="projectId" value={project.id} />
          <input type="hidden" name="projectKey" value={project.key} />
          <Field id="p-key" label={t("key")} hint={t("keyHint")}>
            <Input
              id="p-key"
              name="key"
              defaultValue={project.key}
              maxLength={8}
              pattern="[A-Za-z][A-Za-z0-9]{0,7}"
              className="w-40 font-mono uppercase"
            />
          </Field>
        </AutoForm>
      ) : null}
      {project.caps.delete ? (
        <div>
          {archived ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => run(() => setProjectArchivedAction(project.id, project.key, false))}
            >
              {t("unarchive")}
            </Button>
          ) : (
            <InlineConfirm
              label={t("archive")}
              question={t("archiveConfirm")}
              variant="destructive"
              size="sm"
              pending={pending}
              onConfirm={() => run(() => setProjectArchivedAction(project.id, project.key, true))}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The portal switch — Project.portalEnabled is THE gate (TENANCY.md
 * §7.2); the portal UI itself is Phase 3, so the hint says so. Shown to
 * project:edit holders (project:manage_portal arrives with the portal).
 */
export function PortalControls({ project }: { project: ProjectDetail }) {
  const t = useTranslations("projects.overview");
  const { pending, run } = useRun();
  const disabled = !project.caps.edit || project.status === "ARCHIVED" || pending;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <Switch
          id="p-portal"
          checked={project.portalEnabled}
          disabled={disabled}
          onCheckedChange={(v) => run(() => setPortalEnabledAction(project.id, project.key, v))}
          className="mt-0.5"
        />
        <div className="flex flex-col gap-1">
          <Label htmlFor="p-portal">{t("portalEnabled")}</Label>
          <span className="text-xs text-muted-foreground">{t("portalHint")}</span>
        </div>
      </div>
      <Field id="p-hours" label={t("hoursSharing")}>
        <NativeSelect
          id="p-hours"
          value={project.hoursSharingMode}
          disabled={disabled}
          onChange={(e) => run(() => setHoursSharingAction(project.id, project.key, e.target.value))}
          className="w-72"
        >
          {HOURS_MODES.map((m) => (
            <option key={m} value={m}>
              {t(`hoursModes.${m}`)}
            </option>
          ))}
        </NativeSelect>
      </Field>
    </div>
  );
}
