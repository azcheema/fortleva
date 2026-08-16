"use client";

import { GlobeIcon, LockIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { toast } from "sonner";

import { AutoForm } from "@/components/auto-form";
import { InlineConfirm } from "@/components/inline-confirm";
import { Callout, Field } from "@/components/semantic";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeCheckbox } from "@/components/ui/native-checkbox";
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

/** A field label that carries the INTERNAL lock glyph (DESIGN SPEC §2.4). */
function PrivateLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <LockIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
      {children}
    </span>
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
    <AutoForm action={updateProjectAction} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <input type="hidden" name="projectId" value={project.id} />
      <input type="hidden" name="projectKey" value={project.key} />
      <Field label={t("name")} htmlFor="p-name" className="sm:col-span-2">
        <Input id="p-name" name="name" defaultValue={project.name} required readOnly={ro} />
      </Field>
      <Field label={t("type")} htmlFor="p-type">
        <Input
          id="p-type"
          name="type"
          defaultValue={project.type ?? ""}
          placeholder={t("typePlaceholder")}
          readOnly={ro}
        />
      </Field>
      <Field label={t("lead")} htmlFor="p-lead">
        <NativeSelect
          id="p-lead"
          name="leadMemberId"
          defaultValue={project.leadMemberId ?? ""}
          disabled={ro}
        >
          <option value="">{t("leadNone")}</option>
          {members.map((m) => (
            <option key={m.memberId} value={m.memberId}>
              {m.name}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label={t("scopeSummary")} htmlFor="p-scope" className="sm:col-span-2">
        <Textarea
          id="p-scope"
          name="scopeSummary"
          rows={3}
          defaultValue={project.scopeSummary ?? ""}
          readOnly={ro}
        />
      </Field>
      <Field label={t("startDate")} htmlFor="p-start">
        <Input
          id="p-start"
          name="startDate"
          type="date"
          className="num"
          defaultValue={isoDate(project.startDate)}
          readOnly={ro}
        />
      </Field>
      <Field label={t("launchDate")} htmlFor="p-launch">
        <Input
          id="p-launch"
          name="launchDate"
          type="date"
          className="num"
          defaultValue={isoDate(project.launchDate)}
          readOnly={ro}
        />
      </Field>
      <Field label={t("productionUrl")} htmlFor="p-prod">
        <Input
          id="p-prod"
          name="productionUrl"
          type="url"
          defaultValue={project.productionUrl ?? ""}
          readOnly={ro}
        />
      </Field>
      <Field label={t("stagingUrl")} htmlFor="p-staging">
        <Input
          id="p-staging"
          name="stagingUrl"
          type="url"
          defaultValue={project.stagingUrl ?? ""}
          readOnly={ro}
        />
      </Field>
      <Field label={t("billingCurrency")} htmlFor="p-currency">
        <Input
          id="p-currency"
          name="billingCurrency"
          maxLength={3}
          defaultValue={project.billingCurrency ?? ""}
          className="w-24 uppercase"
          readOnly={ro}
        />
      </Field>
      <Field label={t("updateCadence")} htmlFor="p-cadence">
        <NativeSelect
          id="p-cadence"
          name="updateCadence"
          defaultValue={project.updateCadence}
          disabled={ro}
        >
          {CADENCES.map((c) => (
            <option key={c} value={c}>
              {t(`cadences.${c}`)}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <div className="flex items-center gap-2 sm:col-span-2">
        <input type="hidden" name="defaultBillableMarker" value="1" />
        {/* Native, not Radix: <AutoForm> saves on a real change event. */}
        <NativeCheckbox
          id="p-billable"
          name="defaultBillable"
          defaultChecked={project.defaultBillable}
          disabled={ro}
        />
        <Label htmlFor="p-billable" className="font-normal">
          {t("defaultBillable")}
        </Label>
      </div>
    </AutoForm>
  );
}

/**
 * INTERNAL-only fields (UI.md rule 10; DATA_MODEL §6.5). The card
 * header carries the VisibilityBadge; each label repeats the lock
 * glyph, so the guarantee is visible at the field the cursor is in and
 * not only at the top of the card.
 */
export function ProjectInternalForm({ project }: { project: ProjectDetail }) {
  const t = useTranslations("projects.overview");
  const ro = !project.caps.edit || project.status === "ARCHIVED";
  return (
    <AutoForm action={updateProjectAction} className="grid grid-cols-1 gap-4">
      <input type="hidden" name="projectId" value={project.id} />
      <input type="hidden" name="projectKey" value={project.key} />
      <Field label={<PrivateLabel>{t("repoUrl")}</PrivateLabel>} htmlFor="p-repo">
        <Input
          id="p-repo"
          name="repoUrl"
          type="url"
          defaultValue={project.repoUrl ?? ""}
          readOnly={ro}
        />
      </Field>
      <Field
        label={<PrivateLabel>{t("hostingNotes")}</PrivateLabel>}
        htmlFor="p-hosting"
        hint={t("hostingHint")}
      >
        <Textarea
          id="p-hosting"
          name="hostingNotes"
          rows={2}
          defaultValue={project.hostingNotes ?? ""}
          readOnly={ro}
        />
      </Field>
      <Field label={<PrivateLabel>{t("internalNotes")}</PrivateLabel>} htmlFor="p-notes">
        <Textarea
          id="p-notes"
          name="internalNotes"
          rows={5}
          defaultValue={project.internalNotes ?? ""}
          readOnly={ro}
        />
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
      <Field label={t("status")} htmlFor="p-status">
        <NativeSelect
          id="p-status"
          value={archived ? "ARCHIVED" : project.status}
          disabled={!project.caps.edit || archived || pending}
          onChange={(e) =>
            run(() => changeProjectStatusAction(project.id, project.key, e.target.value))
          }
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
          <Field label={t("key")} htmlFor="p-key" hint={t("keyHint")}>
            <Input
              id="p-key"
              name="key"
              defaultValue={project.key}
              maxLength={8}
              pattern="[A-Za-z][A-Za-z0-9]{0,7}"
              className="num w-40 font-mono uppercase"
            />
          </Field>
        </AutoForm>
      ) : null}
      {project.caps.delete ? (
        <div className="border-t border-border pt-4">
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
 * §7.2): with it off a client sees nothing from this project, even
 * items marked "Client can see". That makes it the most consequential
 * control on the page, so it is deliberately not a bare toggle in a
 * row of fields: an explanatory caution Callout sits above it, the
 * switch lives in its own bordered group with the current state
 * spelled out as a badge, and turning hours sharing on adds a second
 * warning naming exactly what leaves the team.
 *
 * The badge is BRAND, never the warm fill: a filled warm pill means
 * "Client can see" and nothing else, product-wide (§2.4).
 */
export function PortalControls({ project }: { project: ProjectDetail }) {
  const t = useTranslations("projects.overview");
  const { pending, run } = useRun();
  const disabled = !project.caps.edit || project.status === "ARCHIVED" || pending;
  // Deliberately NOT optimistic: the select stays bound to the server
  // value, so a rejected write can never leave the screen claiming the
  // client sees hours they cannot (or worse, the reverse).
  const sharingHours = project.portalEnabled && project.hoursSharingMode !== "NONE";

  return (
    <div className="flex flex-col gap-4">
      <Callout tone="caution" title={t("portalCalloutTitle")}>
        {t("portalHint")}
      </Callout>

      <div className="flex items-start justify-between gap-3 rounded-md border border-input p-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor="p-portal" className="text-sm">
            {t("portalEnabled")}
          </Label>
          {project.portalEnabled ? (
            <Badge variant="brand">
              <GlobeIcon aria-hidden="true" />
              {t("portalOn")}
            </Badge>
          ) : (
            <Badge variant="outline">
              <GlobeIcon aria-hidden="true" />
              {t("portalOff")}
            </Badge>
          )}
        </div>
        <Switch
          id="p-portal"
          checked={project.portalEnabled}
          disabled={disabled}
          onCheckedChange={(v) => run(() => setPortalEnabledAction(project.id, project.key, v))}
          className="mt-1"
        />
      </div>

      <Field label={t("hoursSharing")} htmlFor="p-hours" hint={t("hoursSharingHint")}>
        <NativeSelect
          id="p-hours"
          value={project.hoursSharingMode}
          disabled={disabled}
          onChange={(e) => run(() => setHoursSharingAction(project.id, project.key, e.target.value))}
        >
          {HOURS_MODES.map((m) => (
            <option key={m} value={m}>
              {t(`hoursModes.${m}`)}
            </option>
          ))}
        </NativeSelect>
      </Field>

      {sharingHours ? (
        <Callout tone="caution" role="status">
          {t("hoursSharingWarning")}
        </Callout>
      ) : null}
    </div>
  );
}
