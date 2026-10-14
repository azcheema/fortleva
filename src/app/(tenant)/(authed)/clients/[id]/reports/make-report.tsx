"use client";

import { FileChartColumnIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Callout, Field, FormMessage } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { NativeCheckbox } from "@/components/ui/native-checkbox";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { isActionRedirect } from "@/lib/action-redirect";

import { makeReportAction } from "./actions";
import { MonthPicker } from "./month-picker";

/**
 * MAKE A REPORT (Phase 7 slice 119; founder decision C95) — the month (one
 * that has ended, last month first), the language (the client's invoice
 * language unless changed), the projects the client sees (all ticked, untick
 * any), the team's two texts, one button. Fortleva then reads what the client
 * can already see — as one of the client's own people — draws the PDF and
 * files it as a report, private until published (`src/documents/made-reports.ts`).
 *
 * NOT a `<form action>`: React 19 resets one after every action, a refusal
 * included (AGENTS.md's standing trap). The values stay on a refusal, which
 * is toasted — an action failure never looks like a revert.
 */

export const REPORT_TEXT_MAX = 2000;

export type MakeReportProject = { readonly id: string; readonly name: string };

export function MakeReport({
  clientId,
  latestMonth,
  defaultLocale,
  projects,
  hasAudience,
}: {
  clientId: string;
  /** `YYYY-MM` — the newest month that has ENDED, in the workspace's zone; the picker starts there. */
  latestMonth: string;
  /** The client's invoice language. */
  defaultLocale: "sv" | "en";
  /** The projects the client sees in their portal (portal on, not archived), by name. */
  projects: readonly MakeReportProject[];
  /** Whether anyone at the client could sign in to read it — without one, no report can be made. */
  hasAudience: boolean;
}) {
  const t = useTranslations("clients.reports.make");
  const [month, setMonth] = useState(latestMonth);
  const [locale, setLocale] = useState<"sv" | "en">(defaultLocale);
  // The UNTICKED set, so every project starts ticked (C95 (e)) — including
  // one that appears after a refresh (the code review's nit).
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(() => new Set());
  const [summary, setSummary] = useState("");
  const [comingNext, setComingNext] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  if (!hasAudience) {
    return (
      <Callout tone="info" data-testid="make-report-no-audience">
        {t("noAudience")}
      </Callout>
    );
  }
  if (projects.length === 0) {
    return (
      <Callout tone="info" data-testid="make-report-no-projects">
        {t("noProjects")}
      </Callout>
    );
  }

  const toggle = (id: string, on: boolean) =>
    setUnticked((prev) => {
      const next = new Set(prev);
      if (on) next.delete(id);
      else next.add(id);
      return next;
    });
  const tickedProjects = projects.filter((p) => !unticked.has(p.id));

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      try {
        const r = await makeReportAction({
          clientId,
          month,
          locale,
          projectIds: tickedProjects.map((p) => p.id),
          summary,
          comingNext,
        });
        if (!r.ok) {
          setError(r.message);
          return;
        }
        toast.success(t("done"));
        setSummary("");
        setComingNext("");
        setMonth(latestMonth);
        setLocale(defaultLocale);
        setUnticked(new Set());
        router.refresh();
      } catch (err) {
        // A redirect (an expired session, a step-up) rejects the action's
        // promise and then navigates by itself: let it pass silently.
        if (isActionRedirect(err)) return;
        setError(t("failed"));
      }
    });
  };

  const none = tickedProjects.length === 0;

  return (
    <form onSubmit={onSubmit} className="flex max-w-lg flex-col gap-4" data-testid="make-report">
      <MonthPicker id="make-report" value={month} latest={latestMonth} onChange={setMonth} disabled={pending} />
      <Field label={t("language")} htmlFor="make-report-locale" hint={t("languageHint")}>
        <NativeSelect
          id="make-report-locale"
          value={locale}
          onChange={(e) => setLocale(e.target.value === "en" ? "en" : "sv")}
          disabled={pending}
          className="w-auto min-w-36"
          data-testid="make-report-locale"
        >
          <option value="sv">{t("languages.sv")}</option>
          <option value="en">{t("languages.en")}</option>
        </NativeSelect>
      </Field>
      <fieldset className="flex min-w-0 flex-col gap-1.5" disabled={pending} data-testid="make-report-projects">
        <legend className="mb-1.5 text-sm font-medium">{t("projects")}</legend>
        <p className="text-xs text-muted-foreground">{t("projectsHint")}</p>
        <ul className="mt-1 flex flex-col gap-1.5">
          {projects.map((p) => (
            <li key={p.id}>
              <label className="flex items-center gap-2 text-sm">
                <NativeCheckbox checked={!unticked.has(p.id)} onChange={(e) => toggle(p.id, e.target.checked)} data-project-id={p.id} />
                <span className="truncate">{p.name}</span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      <Field label={t("summary")} htmlFor="make-report-summary" hint={t("summaryHint")}>
        <Textarea
          id="make-report-summary"
          value={summary}
          maxLength={REPORT_TEXT_MAX}
          rows={4}
          onChange={(e) => setSummary(e.target.value)}
          disabled={pending}
          data-testid="make-report-summary"
        />
      </Field>
      <p className="num -mt-3 text-right text-xs text-muted-foreground">{t("chars", { count: summary.length, max: REPORT_TEXT_MAX })}</p>
      <Field label={t("comingNext")} htmlFor="make-report-coming-next" hint={t("comingNextHint")}>
        <Textarea
          id="make-report-coming-next"
          value={comingNext}
          maxLength={REPORT_TEXT_MAX}
          rows={4}
          onChange={(e) => setComingNext(e.target.value)}
          disabled={pending}
          data-testid="make-report-coming-next"
        />
      </Field>
      <p className="num -mt-3 text-right text-xs text-muted-foreground">{t("chars", { count: comingNext.length, max: REPORT_TEXT_MAX })}</p>
      <p className="text-xs text-muted-foreground" data-testid="make-report-shows">
        {t("shows")}
      </p>
      <Callout tone="info">{t("private")}</Callout>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending || none} data-testid="make-report-submit">
          <FileChartColumnIcon />
          {pending ? t("submitting") : t("submit")}
        </Button>
      </div>
      {error ? <FormMessage state={{ ok: false, message: error }} /> : null}
    </form>
  );
}
