"use client";

import { GlobeIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Callout, Field, Pending } from "@/components/semantic";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { PORTAL_SECTIONS, type PortalSection } from "@/projects/portal-sections";
import type { ProjectDetail } from "@/projects/service";

import { setHoursSharingAction, setPortalEnabledAction, setPortalSectionAction } from "../actions";
import { useRun } from "@/components/use-run";

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
        {/* The fan-out is ten mass UPDATEs (eleven since project_update
            joined it) and the transition then waits
            for the whole revalidated page — which on THIS tab re-runs the
            preview's three transactions. Since slice 74 the pending state
            also covers the switch's wait on the project's gate and, after
            its transaction, the drain of in-doubt writers (skipped after
            an OFF; bounded by DRAIN_DEADLINE_MS, about a second scaled by
            the link factor) and the reconcile's passes, which
            setPortalEnabled awaits before it returns. Seconds, with the
            control deliberately not optimistic, so without this the member
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

/**
 * THE SECTION SWITCHES (Phase 3 slice 80, founder decision C47): which
 * parts of this project the client's portal draws — its page and its
 * card on the portal's overview. One row per section, the pattern of
 * Settings → Modules: a label, the one-line consequence, a switch.
 *
 * ITS OWN CARD, NOT A ROW UNDER THE MASTER SWITCH, because it is a
 * different kind of control and the card's words have to say so: the
 * master switch decides what a client can REACH, and is audited and
 * fanned out as a gate; these decide what a page SHOWS, and hiding is
 * never how something is taken away (C47b) — the card's description ends
 * on that verb, "make it private", so nobody reads a hidden section as a
 * withdrawn one.
 *
 * NOT OPTIMISTIC, like the two controls above: bound to the server value,
 * a refusal toasted by `useRun` rather than looking like a revert. The
 * track is NEUTRAL, not the brand fill — four switches all on is a stripe
 * of `--primary` saying nothing (the reason Settings → Modules gives).
 * Disabled on an archived project, as hours sharing is: an archived
 * project publishes nothing, so there is nothing for them to lay out.
 */
export function PortalSectionControls({ project }: { project: ProjectDetail }) {
  const t = useTranslations("projects.portal.sections");
  const tCommon = useTranslations("common");
  const { pending, run } = useRun();
  // Which row was pressed, so the pending mark sits beside it: a press
  // revalidates this tab, whose preview re-runs up to six transactions
  // (the member's read, the module gates, two to four projection reads),
  // so the round trip is seconds and the switch deliberately does not
  // move early (the master switch's own `Pending` note, above).
  const [pressed, setPressed] = useState<PortalSection | null>(null);
  const disabled = !project.caps.managePortal || project.status === "ARCHIVED" || pending;

  return (
    <ul data-slot="portal-sections" className="flex flex-col divide-y divide-border">
      {PORTAL_SECTIONS.map((section) => (
        <li
          key={section}
          data-section={section}
          className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0"
        >
          <div className="flex min-w-0 flex-col gap-1">
            <Label htmlFor={`p-section-${section}`} className="font-medium">
              {t(`${section}.label`)}
            </Label>
            <p id={`p-section-${section}-hint`} className="text-xs text-muted-foreground">
              {t(`${section}.hint`)}
            </p>
          </div>
          <div className="flex shrink-0 items-start gap-2">
            {pending && pressed === section ? <Pending label={tCommon("loading")} className="mt-0.5" /> : null}
            <Switch
              id={`p-section-${section}`}
              aria-describedby={`p-section-${section}-hint`}
              checked={project.portalSections[section]}
              disabled={disabled}
              onCheckedChange={(v) => {
                setPressed(section);
                run(() => setPortalSectionAction(project.id, project.key, section, v));
              }}
              className="mt-1 data-checked:bg-(--tone-neutral-line)"
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
