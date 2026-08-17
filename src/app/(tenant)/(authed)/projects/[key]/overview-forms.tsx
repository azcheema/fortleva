"use client";

import { ChevronRightIcon, GlobeIcon, LockIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { Fragment, useTransition } from "react";
import { toast } from "sonner";

import { AutoForm } from "@/components/auto-form";
import { InlineConfirm } from "@/components/inline-confirm";
import {
  Callout,
  Field,
  InlineEdit,
  MemberAvatar,
  SectionCard,
  StatusBadge,
} from "@/components/semantic";
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

/** A field label that carries the INTERNAL lock glyph (UI.md §10.4). */
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

/**
 * One labelled property: the term on the left, the value on the right.
 * A definition list, not a stack of boxes — the value is text until
 * someone decides to change it (founder mandate 1).
 */
function Prop({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 items-center gap-x-3 gap-y-0.5 py-0.5 sm:grid-cols-[9rem_minmax(0,1fr)]">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

/**
 * The fields a member fills in only once are not worth 32px of chrome
 * apiece for the rest of the project's life. Everything that has a
 * value renders in the list; everything empty waits behind one
 * disclosure, so the card states what is true instead of advertising
 * ten blanks.
 *
 * The hidden inputs `<InlineEdit>` keeps at rest are still inside the
 * `<details>`, so the posted FormData is identical whether it is open
 * or closed — and `updateProjectAction` is `has()`-guarded either way.
 */
function Disclosure({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <details className="group/details">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-sm py-1 text-xs text-muted-foreground transition-colors duration-(--dur-instant) ease-out hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 transition-transform duration-(--dur-instant) ease-out group-open/details:rotate-90"
        />
        {label}
      </summary>
      <dl className="mt-1 flex flex-col">{children}</dl>
    </details>
  );
}

/** Public-ish project fields — auto-saving (UI.md §5.10). Read-only without project:edit. */
export function ProjectDetailsForm({
  project,
  members,
}: {
  project: ProjectDetail;
  members: { memberId: string; name: string }[];
}) {
  const t = useTranslations("projects.overview");
  const tCommon = useTranslations("common");
  const format = useFormatter();
  const ro = !project.caps.edit || project.status === "ARCHIVED";

  const date = (value: Date | null) =>
    value ? format.dateTime(value, { dateStyle: "medium" }) : "";
  const lead = members.find((m) => m.memberId === project.leadMemberId);

  // Each property states whether it is worth a line at rest. Everything
  // that is set stays; everything blank moves behind the disclosure.
  const props: { key: string; filled: boolean; node: React.ReactNode }[] = [
    {
      key: "name",
      filled: true,
      node: (
        <Prop label={t("name")}>
          <InlineEdit
            kind="text"
            name="name"
            value={project.name}
            label={t("name")}
            placeholder={t("name")}
            readOnly={ro}
            inputProps={{ required: true }}
            className="-ml-2.5"
          />
        </Prop>
      ),
    },
    {
      key: "type",
      filled: Boolean(project.type),
      node: (
        <Prop label={t("type")}>
          <InlineEdit
            kind="text"
            name="type"
            value={project.type ?? ""}
            label={t("type")}
            placeholder={t("typePlaceholder")}
            readOnly={ro}
            className="-ml-2.5"
          />
        </Prop>
      ),
    },
    {
      key: "lead",
      filled: Boolean(project.leadMemberId),
      node: (
        <Prop label={t("lead")}>
          <InlineEdit
            kind="select"
            name="leadMemberId"
            value={project.leadMemberId ?? ""}
            label={t("lead")}
            placeholder={t("leadNone")}
            options={[
              { value: "", label: t("leadNone") },
              ...members.map((m) => ({ value: m.memberId, label: m.name })),
            ]}
            display={
              lead ? (
                <span className="flex min-w-0 items-center gap-2">
                  <MemberAvatar id={lead.memberId} name={lead.name} size="sm" />
                  <span className="truncate">{lead.name}</span>
                </span>
              ) : undefined
            }
            readOnly={ro}
            className="-ml-2.5"
          />
        </Prop>
      ),
    },
    {
      key: "startDate",
      filled: Boolean(project.startDate),
      node: (
        <Prop label={t("startDate")}>
          <InlineEdit
            kind="date"
            name="startDate"
            value={isoDate(project.startDate)}
            label={t("startDate")}
            placeholder={t("setDate")}
            display={<span className="num">{date(project.startDate)}</span>}
            readOnly={ro}
            className="-ml-2.5"
          />
        </Prop>
      ),
    },
    {
      key: "launchDate",
      filled: Boolean(project.launchDate),
      node: (
        <Prop label={t("launchDate")}>
          <InlineEdit
            kind="date"
            name="launchDate"
            value={isoDate(project.launchDate)}
            label={t("launchDate")}
            placeholder={t("setDate")}
            display={<span className="num">{date(project.launchDate)}</span>}
            readOnly={ro}
            className="-ml-2.5"
          />
        </Prop>
      ),
    },
    {
      key: "productionUrl",
      filled: Boolean(project.productionUrl),
      node: (
        <Prop label={t("productionUrl")}>
          <InlineEdit
            kind="text"
            name="productionUrl"
            value={project.productionUrl ?? ""}
            label={t("productionUrl")}
            placeholder={tCommon("notSet")}
            readOnly={ro}
            inputProps={{ inputMode: "url" }}
            className="-ml-2.5"
          />
        </Prop>
      ),
    },
    {
      key: "stagingUrl",
      filled: Boolean(project.stagingUrl),
      node: (
        <Prop label={t("stagingUrl")}>
          <InlineEdit
            kind="text"
            name="stagingUrl"
            value={project.stagingUrl ?? ""}
            label={t("stagingUrl")}
            placeholder={tCommon("notSet")}
            readOnly={ro}
            inputProps={{ inputMode: "url" }}
            className="-ml-2.5"
          />
        </Prop>
      ),
    },
    {
      key: "billingCurrency",
      filled: Boolean(project.billingCurrency),
      node: (
        <Prop label={t("billingCurrency")}>
          <InlineEdit
            kind="text"
            name="billingCurrency"
            value={project.billingCurrency ?? ""}
            label={t("billingCurrency")}
            placeholder={tCommon("notSet")}
            readOnly={ro}
            inputProps={{ maxLength: 3, className: "w-24 uppercase" }}
            className="-ml-2.5 w-auto"
          />
        </Prop>
      ),
    },
    {
      key: "updateCadence",
      filled: project.updateCadence !== "NONE",
      node: (
        <Prop label={t("updateCadence")}>
          <InlineEdit
            kind="select"
            name="updateCadence"
            value={project.updateCadence}
            label={t("updateCadence")}
            placeholder={t("cadences.NONE")}
            options={CADENCES.map((c) => ({ value: c, label: t(`cadences.${c}`) }))}
            readOnly={ro}
            className="-ml-2.5"
          />
        </Prop>
      ),
    },
  ];

  const shown = props.filter((p) => p.filled);
  const rest = props.filter((p) => !p.filled);

  return (
    <AutoForm action={updateProjectAction} className="flex flex-col gap-3">
      <input type="hidden" name="projectId" value={project.id} />
      <input type="hidden" name="projectKey" value={project.key} />
      <dl className="flex flex-col">
        {shown.map((p) => (
          <Fragment key={p.key}>{p.node}</Fragment>
        ))}
      </dl>

      {/* The scope summary is a writing surface, not a labelled property
          (WORKLIST §3.8), so it keeps its control. */}
      <Field label={t("scopeSummary")} htmlFor="p-scope">
        <Textarea
          id="p-scope"
          name="scopeSummary"
          rows={3}
          defaultValue={project.scopeSummary ?? ""}
          readOnly={ro}
        />
      </Field>

      <div className="flex items-center gap-2">
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

      {rest.length > 0 ? (
        <Disclosure label={tCommon("addDetails")}>
          {rest.map((p) => (
            <Fragment key={p.key}>{p.node}</Fragment>
          ))}
        </Disclosure>
      ) : null}
    </AutoForm>
  );
}

/**
 * INTERNAL-only fields (UI.md rule 10; DATA_MODEL §6.5). The card
 * header carries the VisibilityBadge; each label repeats the lock
 * glyph, so the guarantee is visible at the field the cursor is in and
 * not only at the top of the card.
 *
 * The notes textarea stays a textarea: a surface whose whole purpose is
 * writing free text keeps its control (WORKLIST §3.8). The repository
 * and the hosting pointer are labelled properties and read as values.
 */
export function ProjectInternalForm({ project }: { project: ProjectDetail }) {
  const t = useTranslations("projects.overview");
  const tCommon = useTranslations("common");
  const ro = !project.caps.edit || project.status === "ARCHIVED";
  return (
    <AutoForm action={updateProjectAction} className="flex flex-col gap-3">
      <input type="hidden" name="projectId" value={project.id} />
      <input type="hidden" name="projectKey" value={project.key} />
      <dl className="flex flex-col">
        <Prop label={<PrivateLabel>{t("repoUrl")}</PrivateLabel>}>
          <InlineEdit
            kind="text"
            name="repoUrl"
            value={project.repoUrl ?? ""}
            label={t("repoUrl")}
            placeholder={tCommon("notSet")}
            readOnly={ro}
            inputProps={{ inputMode: "url" }}
            className="-ml-2.5"
          />
        </Prop>
        <Prop label={<PrivateLabel>{t("hostingNotes")}</PrivateLabel>}>
          <InlineEdit
            kind="multiline"
            name="hostingNotes"
            value={project.hostingNotes ?? ""}
            label={t("hostingNotes")}
            placeholder={t("hostingHint")}
            readOnly={ro}
            className="-ml-2.5"
          />
        </Prop>
      </dl>
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

/**
 * Status and key. The status rests as the badge every other screen
 * shows for the same value and becomes its select on activation; the
 * key is a code that is typed, so it keeps a real field.
 *
 * Archiving is NOT here. A destructive action does not belong in a card
 * about routine settings, directly under a sentence about renaming —
 * it lives in its own danger footer at the foot of the page.
 */
export function ProjectStatusControls({ project }: { project: ProjectDetail }) {
  const t = useTranslations("projects.overview");
  const tStatus = useTranslations("projects.status");
  const router = useRouter();
  const { pending, run } = useRun();
  const archived = project.status === "ARCHIVED";
  return (
    <div className="flex flex-col gap-4">
      <dl className="flex flex-col">
        <Prop label={t("status")}>
          {/* The resting state is the badge every other screen shows for
              the same value — one word, one tone, one silhouette. */}
          <InlineEdit
            kind="select"
            name="status"
            value={archived ? "ARCHIVED" : project.status}
            label={t("status")}
            placeholder={tStatus("PLANNED")}
            display={
              <StatusBadge domain="projectStatus" value={archived ? "ARCHIVED" : project.status} />
            }
            options={[
              ...STATUSES.map((s) => ({ value: s, label: tStatus(s) })),
              ...(archived ? [{ value: "ARCHIVED", label: tStatus("ARCHIVED") }] : []),
            ]}
            readOnly={!project.caps.edit || archived || pending}
            hiddenInput={false}
            onCommit={(next) => run(() => changeProjectStatusAction(project.id, project.key, next))}
            className="-ml-2.5"
          />
        </Prop>
      </dl>
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
    </div>
  );
}

/**
 * The page's one irreversible-ish action, in its own card at the foot
 * of the column, at resting weight `outline` — the solid destructive
 * fill is spent on the "Yes" of the question, and nowhere else.
 */
export function ProjectDangerZone({ project }: { project: ProjectDetail }) {
  const t = useTranslations("projects.overview");
  const tCommon = useTranslations("common");
  const { pending, run } = useRun();
  const archived = project.status === "ARCHIVED";
  if (!project.caps.delete) return null;
  return (
    <SectionCard title={tCommon("danger.title")} contentClassName="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        {archived ? t("unarchiveHint") : t("archiveHint")}
      </p>
      {archived ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          className="self-start"
          onClick={() => run(() => setProjectArchivedAction(project.id, project.key, false))}
        >
          {t("unarchive")}
        </Button>
      ) : (
        <span className="self-start">
          <InlineConfirm
            label={t("archive")}
            question={t("archiveConfirm")}
            variant="outline"
            tone="danger"
            size="sm"
            pending={pending}
            onConfirm={() => run(() => setProjectArchivedAction(project.id, project.key, true))}
          />
        </span>
      )}
    </SectionCard>
  );
}

/**
 * The portal switch — Project.portalEnabled is THE gate (TENANCY.md
 * §7.2): with it off a client sees nothing from this project, even
 * items marked "Client can see". That makes it the most consequential
 * control on the page, so it is deliberately not a bare toggle in a
 * row of fields: an explanatory caution Callout sits above it, the
 * switch lives in its own bordered group, and turning hours sharing on
 * adds a second warning naming exactly what leaves the team.
 *
 * The badge is BRAND, never the warm fill: a filled warm pill means
 * "Client can see" and nothing else, product-wide (§10.4). It renders
 * only for portal ON — the switch already IS the off state, and §10.4
 * specifies a badge for portal on alone.
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
          ) : null}
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
