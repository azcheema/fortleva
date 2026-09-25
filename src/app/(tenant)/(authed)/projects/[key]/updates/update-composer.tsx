"use client";

import type { Editor } from "@tiptap/react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { InlineConfirm, SectionCard, StatusIcon, VisibilityBadge } from "@/components/semantic";
import { Field } from "@/components/semantic/field";
import { UpdateView } from "@/components/updates/update-view";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeCheckbox } from "@/components/ui/native-checkbox";
import { PROJECT_HEALTHS, STATUS_MAP, type ProjectHealth } from "@/lib/enum-map";
import { TONE_CHIP } from "@/lib/tones";
import { cn } from "@/lib/utils";
import type { ComposerContext } from "@/modules/work/updates";
import {
  UPDATE_METRIC_GROUPS,
  UPDATE_SECTION_KEYS,
  UPDATE_TITLE_MAX,
  type UpdateBody,
  type UpdateFixedSectionKey,
  type UpdateMetricGroup,
  type UpdateMetricsInclude,
} from "@/modules/work/update-body";
import type { PortalSnapshot } from "@/modules/work/update-snapshot";

import {
  composerContextAction,
  discardUpdateDraftAction,
  publishUpdateAction,
  saveUpdateDraftAction,
} from "./actions";
import { PublishDialog } from "./publish-dialog";
import { SectionEditor, bulletListOf } from "./section-editor";

/**
 * THE COMPOSER (PLAN Phase 3: "health picker, sections with default
 * template, 'changes since last update' pull-in panel, metrics card
 * with include toggles, live portal preview").
 *
 * STATE LIVES HERE, SAVES ARE EXPLICIT. Five editors on one page would
 * autosave over each other; a status post is written in one sitting and
 * saved with a button, like a report. The preview on the right is
 * `UpdateView` — the portal's own component — fed from this state, so
 * what the author sees is what the client will read, apart from the
 * numbers' freezing at publish.
 *
 * THE NUMBERS FOLLOW THE DATES. The metrics card and the pull-in panel
 * both cover the window publish will use (`metricsWindowFor`); when the
 * author changes a date the composer re-asks the server, which is the
 * one place that rule is written.
 */

type SectionDocs = Partial<Record<UpdateFixedSectionKey, unknown>>;

export type ComposerDraft = {
  readonly id: string | null;
  readonly health: ProjectHealth;
  readonly title: string | null;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly body: UpdateBody;
};

const docsOf = (body: UpdateBody): SectionDocs => {
  const out: SectionDocs = {};
  for (const s of body.sections) {
    if (s.key !== "CUSTOM") out[s.key] = s.body;
  }
  return out;
};

const bodyOf = (docs: SectionDocs, include: UpdateMetricsInclude): UpdateBody => ({
  sections: UPDATE_SECTION_KEYS.filter((k) => docs[k] != null).map((k) => ({ key: k, title: null, body: docs[k] })),
  metrics: { include },
});

const withInclude = (metrics: PortalSnapshot, include: UpdateMetricsInclude): PortalSnapshot => {
  const out: Record<string, unknown> = { ...metrics };
  for (const group of UPDATE_METRIC_GROUPS) if (!include[group]) delete out[group];
  return out as PortalSnapshot;
};

export function UpdateComposer({
  projectId,
  projectKey,
  draft,
  context: initialContext,
}: {
  projectId: string;
  projectKey: string;
  draft: ComposerDraft;
  context: ComposerContext;
}) {
  const t = useTranslations("projects.updates.composer");
  const tPublish = useTranslations("projects.updates.publish");
  const tSections = useTranslations("updates.sections");
  const tHealth = useTranslations("states.projectHealth");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const [pending, start] = useTransition();

  const [id, setId] = useState(draft.id);
  const [health, setHealth] = useState<ProjectHealth>(draft.health);
  const [title, setTitle] = useState(draft.title ?? "");
  const [periodStart, setPeriodStart] = useState(draft.periodStart ?? "");
  const [periodEnd, setPeriodEnd] = useState(draft.periodEnd ?? "");
  const [docs, setDocs] = useState<SectionDocs>(() => docsOf(draft.body));
  const [include, setInclude] = useState<UpdateMetricsInclude>(draft.body.metrics.include);
  const [context, setContext] = useState(initialContext);
  const [dirty, setDirty] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const editors = useRef<Partial<Record<UpdateFixedSectionKey, Editor | null>>>({});

  const period = { periodStart: periodStart || null, periodEnd: periodEnd || null };

  // Re-ask the server when the window changes — after the first render,
  // whose context the page already loaded for these dates.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    let cancelled = false;
    void composerContextAction({ projectId, projectKey, ...period, excludeId: id }).then((r) => {
      if (!cancelled && r.ok) setContext(r.value);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the window is the two dates
  }, [periodStart, periodEnd]);

  const onSection = useCallback((key: UpdateFixedSectionKey) => (doc: unknown | null) => {
    setDocs((prev) => ({ ...prev, [key]: doc }));
    setDirty(true);
  }, []);
  const onEditor = useCallback((key: UpdateFixedSectionKey) => (editor: Editor | null) => {
    editors.current[key] = editor;
  }, []);

  const input = () => ({
    projectId,
    projectKey,
    id,
    health,
    title: title.trim() === "" ? null : title.trim(),
    ...period,
    body: bodyOf(docs, include),
  });

  const save = (): Promise<string | null> =>
    new Promise((resolve) => {
      start(async () => {
        const r = await saveUpdateDraftAction(input()).catch(() => ({ ok: false as const, message: t("failed") }));
        if (!r.ok) {
          toast.error(r.message || t("failed"));
          resolve(null);
          return;
        }
        setId(r.value.id);
        setDirty(false);
        resolve(r.value.id);
      });
    });

  const onSaveDraft = () =>
    void save().then((saved) => {
      if (saved) {
        toast.success(t("saved"));
        if (!id) router.replace(`/projects/${projectKey}/updates/${saved}`);
        else router.refresh();
      }
    });

  const onPublish = async (visibility: "INTERNAL" | "CLIENT_VISIBLE") => {
    const saved = await save();
    if (!saved) return;
    start(async () => {
      const r = await publishUpdateAction({ projectKey, id: saved, visibility }).catch(() => ({
        ok: false as const,
        message: t("failed"),
      }));
      setPublishing(false);
      if (!r.ok) {
        toast.error(r.message || t("failed"));
        return;
      }
      const { seq } = r.value;
      toast.success(
        r.value.visibility === "INTERNAL"
          ? tPublish("publishedInternal", { seq })
          : r.value.portalEnabled
            ? tPublish("publishedVisible", { seq })
            : tPublish("publishedPortalOff", { seq }),
      );
      router.replace(`/projects/${projectKey}/updates/${saved}`);
      router.refresh();
    });
  };

  const onDiscard = () =>
    start(async () => {
      if (!id) {
        router.push(`/projects/${projectKey}/updates`);
        return;
      }
      const r = await discardUpdateDraftAction({ projectKey, id }).catch(() => ({ ok: false as const, message: t("failed") }));
      if (!r.ok) {
        toast.error(r.message || t("failed"));
        return;
      }
      toast.success(t("discarded"));
      router.push(`/projects/${projectKey}/updates`);
      router.refresh();
    });

  const addToDone = (lines: readonly string[]) => {
    if (lines.length === 0) return;
    const editor = editors.current.DONE;
    if (!editor) return;
    const list = bulletListOf(lines);
    if (editor.isEmpty) editor.commands.setContent({ type: "doc", content: [list] }, { emitUpdate: true });
    else editor.chain().focus("end").insertContent(list).run();
  };

  const hoursOff = context.project.hoursSharingMode === "NONE";
  const preview = {
    seq: null,
    health,
    title: title.trim() === "" ? null : title.trim(),
    periodStart: periodStart ? new Date(`${periodStart}T00:00:00Z`) : null,
    periodEnd: periodEnd ? new Date(`${periodEnd}T00:00:00Z`) : null,
    publishedAt: null,
    body: bodyOf(docs, include),
    metrics: withInclude(context.metrics, include),
    editNote: null,
  };
  const changes = context.changes;
  const nothingChanged =
    changes.doneItems.length === 0 &&
    changes.milestonesHit.length === 0 &&
    changes.versionsShipped.length === 0 &&
    changes.requestsReceived.length === 0;

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-5" data-testid="update-composer">
      <div className="flex flex-col gap-4 xl:col-span-3">
        <SectionCard title={id ? t("editTitle") : t("title")}>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <p id="update-health-label" className="text-sm font-medium text-foreground">
                {t("health")}
              </p>
              <div role="radiogroup" aria-labelledby="update-health-label" className="flex flex-wrap gap-1.5">
                {PROJECT_HEALTHS.map((value) => {
                  const spec = STATUS_MAP.projectHealth[value];
                  const selected = health === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      data-testid={`health-${value}`}
                      onClick={() => {
                        setHealth(value);
                        setDirty(true);
                      }}
                      className={cn(
                        "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                        selected
                          ? cn("border-transparent font-medium", TONE_CHIP[spec.tone])
                          : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
                      )}
                    >
                      <StatusIcon name={spec.icon} className="size-3 shrink-0" />
                      {tHealth(value)}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">{t("healthHint")}</p>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
              <Field htmlFor="update-title" label={t("titleLabel")} className="md:col-span-2">
                <Input
                  id="update-title"
                  value={title}
                  maxLength={UPDATE_TITLE_MAX}
                  placeholder={t("titlePlaceholder")}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    setDirty(true);
                  }}
                />
              </Field>
              <Field htmlFor="update-from" label={t("periodFrom")}>
                <Input
                  id="update-from"
                  type="date"
                  value={periodStart}
                  max={periodEnd || undefined}
                  onChange={(e) => {
                    setPeriodStart(e.target.value);
                    setDirty(true);
                  }}
                />
              </Field>
              <Field htmlFor="update-to" label={t("periodTo")} hint={t("periodHint")}>
                <Input
                  id="update-to"
                  type="date"
                  value={periodEnd}
                  min={periodStart || undefined}
                  onChange={(e) => {
                    setPeriodEnd(e.target.value);
                    setDirty(true);
                  }}
                />
              </Field>
            </div>
          </div>
        </SectionCard>

        <SectionCard title={t("sections")}>
          <div className="flex flex-col gap-5">
            {UPDATE_SECTION_KEYS.map((key) => (
              <div key={key} className="flex flex-col gap-1.5">
                <label htmlFor={`update-section-${key}`} className="text-sm font-medium text-foreground">
                  {tSections(key)}
                </label>
                <SectionEditor
                  id={`update-section-${key}`}
                  initialDoc={docs[key] ?? null}
                  placeholder={t(`placeholders.${key}`)}
                  ariaLabel={t("sectionEditor", { section: tSections(key) })}
                  toolbarLabel={t("toolbar", { section: tSections(key) })}
                  onChange={onSection(key)}
                  onEditor={onEditor(key)}
                  testId={`update-section-${key}`}
                />
              </div>
            ))}
          </div>
        </SectionCard>

        <SectionCard title={t("metricsTitle")} description={t("metricsHint")} size="sm">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
              {UPDATE_METRIC_GROUPS.map((group: UpdateMetricGroup) => (
                <label key={group} className="flex items-center gap-2">
                  <NativeCheckbox
                    checked={include[group]}
                    disabled={group === "hours" && hoursOff}
                    onChange={(e) => {
                      setInclude({ ...include, [group]: e.target.checked });
                      setDirty(true);
                    }}
                    data-testid={`include-${group}`}
                  />
                  {t(`include.${group}`)}
                </label>
              ))}
            </div>
            {hoursOff ? <p className="text-xs text-muted-foreground">{t("hoursOff")}</p> : null}
          </div>
        </SectionCard>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <InlineConfirm
              label={t("discard")}
              question={t("discardQuestion")}
              onConfirm={onDiscard}
              pending={pending}
              variant="ghost"
              tone="danger"
            />
            {dirty ? <span className="text-xs text-muted-foreground">{t("unsaved")}</span> : null}
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onSaveDraft} disabled={pending} data-testid="save-draft">
              {t("saveDraft")}
            </Button>
            <Button type="button" size="sm" onClick={() => setPublishing(true)} disabled={pending} data-testid="open-publish">
              {t("publish")}
            </Button>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-4 xl:col-span-2">
        <SectionCard title={t("changesTitle")} description={t("changesHint")} size="sm">
          {nothingChanged ? (
            <p className="text-sm text-muted-foreground">{t("changesEmpty")}</p>
          ) : (
            <div className="flex flex-col gap-3 text-sm">
              {changes.doneItems.length > 0 ? (
                <ChangeGroup
                  heading={t("changesDone")}
                  rows={changes.doneItems.map((i) => ({
                    id: i.id,
                    text: `${i.key} ${i.title}`,
                    visibility: i.visibility,
                  }))}
                  addLabel={(text) => t("addLine", { title: text })}
                  onAdd={(text) => addToDone([text])}
                />
              ) : null}
              {changes.milestonesHit.length > 0 ? (
                <ChangeGroup
                  heading={t("changesMilestones")}
                  rows={changes.milestonesHit.map((m) => ({ id: m.id, text: m.name, visibility: m.visibility }))}
                  addLabel={(text) => t("addLine", { title: text })}
                  onAdd={(text) => addToDone([text])}
                />
              ) : null}
              {changes.versionsShipped.length > 0 ? (
                <ChangeGroup
                  heading={t("changesVersions")}
                  rows={changes.versionsShipped.map((v) => ({
                    id: v.id,
                    text: v.title ? `${v.version} — ${v.title}` : v.version,
                    visibility: "CLIENT_VISIBLE" as const,
                  }))}
                  addLabel={(text) => t("addLine", { title: text })}
                  onAdd={(text) => addToDone([text])}
                />
              ) : null}
              {changes.requestsReceived.length > 0 ? (
                <ChangeGroup
                  heading={t("changesRequests")}
                  rows={changes.requestsReceived.map((r) => ({ id: r.id, text: `${r.key} ${r.title}`, visibility: null }))}
                  addLabel={null}
                  onAdd={null}
                />
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() =>
                  addToDone([
                    ...changes.doneItems.filter((i) => i.visibility === "CLIENT_VISIBLE").map((i) => `${i.key} ${i.title}`),
                    ...changes.milestonesHit.filter((m) => m.visibility === "CLIENT_VISIBLE").map((m) => m.name),
                    ...changes.versionsShipped.map((v) => (v.title ? `${v.version} — ${v.title}` : v.version)),
                  ])
                }
              >
                {t("addAllShared")}
              </Button>
            </div>
          )}
        </SectionCard>

        <SectionCard title={t("previewTitle")} description={t("previewHint")}>
          <div data-testid="update-preview">
            <UpdateView update={preview} />
          </div>
        </SectionCard>
      </div>

      {publishing ? (
        <PublishDialog
          open
          portalEnabled={context.project.portalEnabled}
          busy={pending}
          onCancel={() => setPublishing(false)}
          onConfirm={(visibility) => void onPublish(visibility)}
        />
      ) : null}
      <span className="sr-only" aria-live="polite">
        {pending ? tCommon("loading") : ""}
      </span>
    </div>
  );
}

function ChangeGroup({
  heading,
  rows,
  addLabel,
  onAdd,
}: {
  heading: string;
  rows: readonly { id: string; text: string; visibility: "INTERNAL" | "CLIENT_VISIBLE" | null }[];
  addLabel: ((text: string) => string) | null;
  onAdd: ((text: string) => void) | null;
}) {
  const tCommon = useTranslations("common");
  return (
    <div className="flex flex-col gap-1">
      <p className="eyebrow text-muted-foreground">{heading}</p>
      <ul className="flex flex-col gap-1">
        {rows.map((row) => (
          <li key={row.id} className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate">{row.text}</span>
              {row.visibility === "INTERNAL" ? <VisibilityBadge value="INTERNAL" size="sm" /> : null}
            </span>
            {onAdd && addLabel ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                aria-label={addLabel(row.text)}
                onClick={() => onAdd(row.text)}
              >
                {tCommon("add")}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
