"use client";

import { GlobeIcon } from "lucide-react";
import { useTranslations } from "next-intl";

import { Callout, Field, Pending } from "@/components/semantic";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import type { ProjectDetail } from "@/projects/service";

import { setHoursSharingAction, setPortalEnabledAction } from "../actions";
import { useRun } from "../use-run";

const HOURS_MODES = ["NONE", "HOURS", "BILLABLE_AMOUNT"] as const;

/**
 * THE MASTER SWITCH — `Project.portalEnabled` is THE gate (TENANCY.md
 * §7.2): with it off a client sees nothing from this project, even items
 * marked "Client can see", because the trigger fans the column out
 * across ten tables and `portal_gate` reads it on every one. That makes
 * it the most consequential control in the product, so it is
 * deliberately not a bare toggle in a row of fields: an explanatory
 * caution Callout sits above it, the switch lives in its own bordered
 * group, and turning hours sharing on adds a second warning naming
 * exactly what leaves the team.
 *
 * It lived on the Overview tab until 2026-09-21 and now has its own
 * route, beside the preview of what the switch actually publishes. One
 * home per control: a switch in two places is a switch someone flips in
 * the one that is out of date.
 *
 * NOT OPTIMISTIC, ANYWHERE. Both controls stay bound to the SERVER
 * value. A rejected write must never leave the screen claiming a client
 * can see hours they cannot — or, worse, the reverse — and this is also
 * the control whose failure is REAL rather than theoretical:
 * `setPortalEnabled` can spend its lock-wait budget under a concurrent
 * bulk edit and come back `PORTAL_SWITCH_BUSY`, at which point nothing
 * was written and the switch must still read false. `useRun` toasts the
 * typed `ActionResult` (AGENTS.md's standing trap: a failure must never
 * look like a revert).
 *
 * The badge is BRAND, never the warm fill: a filled warm pill means
 * "Client can see" and nothing else, product-wide (UI.md §10.4). It
 * renders only for portal ON — the switch already IS the off state, and
 * §10.4 specifies a badge for portal on alone.
 */
export function PortalControls({ project }: { project: ProjectDetail }) {
  const t = useTranslations("projects.portal");
  const tCommon = useTranslations("common");
  const { pending, run } = useRun();
  const archived = project.status === "ARCHIVED";
  const disabled = !project.caps.managePortal || archived || pending;
  // THE SWITCH KEEPS ITS OFF DIRECTION WHILE ARCHIVED, and that asymmetry
  // is deliberate (code review, 2026-09-21). The Overview tab disabled
  // the control outright on an archived project, which meant the member
  // shown the PROJECT_ARCHIVED blocker had no verb on this tab at all —
  // and, worse, could not turn sharing OFF. Archiving hides the shared
  // TASK LIST because `listPortalTasks` filters it, not because any
  // policy does; `project.portal_gate` binds client + `portal_enabled`
  // and has no archive term, so a projection added later that forgets
  // the filter publishes again. Turning the switch off is the only act
  // that closes that for good, it is never the unsafe direction, and the
  // service has no archived guard to fight.
  const offOnly = archived && project.portalEnabled;
  const switchDisabled = !project.caps.managePortal || pending || (archived && !project.portalEnabled);
  const sharingHours = project.portalEnabled && project.hoursSharingMode !== "NONE";

  return (
    <div className="flex flex-col gap-4">
      <Callout tone="caution" title={t("calloutTitle")}>
        {t("hint")}
      </Callout>

      <div className="flex items-start justify-between gap-3 rounded-md border border-input p-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor="p-portal" className="text-sm">
            {t("enabled")}
          </Label>
          {project.portalEnabled ? (
            <Badge variant="brand">
              <GlobeIcon aria-hidden="true" />
              {t("on")}
            </Badge>
          ) : null}
          {offOnly ? <span className="text-xs text-muted-foreground">{t("archivedHint")}</span> : null}
        </div>
        {/* The fan-out is ten mass UPDATEs and the transition then waits
            for the whole revalidated page — which on THIS tab re-runs the
            preview's three transactions. Seconds, with the control
            deliberately not optimistic, so without this the member
            presses the switch and nothing visibly happens (review). */}
        {pending ? <Pending label={tCommon("loading")} className="mt-2" /> : null}
        <Switch
          id="p-portal"
          checked={project.portalEnabled}
          disabled={switchDisabled}
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
