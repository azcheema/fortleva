"use client";

import { FileUpIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Callout, DataTable, Field, FileDropField, FormMessage, ProgressMeter, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { isActionRedirect } from "@/lib/action-redirect";
import { chosenFileFrom, type ChosenFile } from "@/lib/file-field";
import { decodeCsv, parseCsv, type ParsedCsv } from "@/modules/work/import/csv-parse";
import {
  IMPORT_FIELDS,
  batchRows,
  buildCsvRows,
  buildTrelloRows,
  csvPersonKey,
  firstPerson,
  fold,
  guessColumns,
  guessDateFormat,
  guessMember,
  guessState,
  offeredStates,
  type ColumnMap,
  type DateFormat,
  type ImportField,
  type StateOption,
} from "@/modules/work/import/mapping";
import { IMPORT_FILE_BYTES, IMPORT_MAX_ROWS, type ImportSource } from "@/modules/work/import/rules";
import { readTrelloBoard, type TrelloBoard } from "@/modules/work/import/trello";

import { finishImportAction, importBatchAction, matchPeopleAction, previewMatchesAction, startImportAction } from "./actions";

/**
 * THE IMPORT (Phase 6 slice 121; founder decision C97; design §2, §6).
 *
 * The file is read HERE, in the browser, and never sent (R1): parsed, matched
 * and checked on this page, then sent as plain rows in batches the server
 * checks again. Four cards, top to bottom — the file; how its columns,
 * statuses and people match this project (every guess shown, every guess
 * changeable); the check, which says what will happen before anything does;
 * and the run.
 *
 * NOT a `<form action>` anywhere: React 19 resets one after every action and
 * a native select inside it would show stale state (AGENTS.md). The batches
 * are awaited in an ordinary handler, not a transition, so the page stays
 * live while they run; a failure stops the run and is said in words, never
 * shown as a revert.
 */

export type ImportFlowProps = {
  projectId: string;
  projectKey: string;
  /** The project's states, names resolved at the page. */
  states: readonly StateOption[];
  members: readonly { id: string; name: string }[];
  /** Label names the project offers. */
  labels: readonly string[];
  caps: { approve: boolean; manageLabels: boolean };
  /** The workspace's zone — a Trello due instant is read as a day there. */
  timezone: string;
};

type Loaded =
  | { kind: "CSV"; fileName: string; csv: ParsedCsv }
  | { kind: "TRELLO"; fileName: string; board: TrelloBoard };

type Totals = { created: number; updated: number; kept: number; unchanged: number };
type Run =
  | { phase: "idle" }
  | { phase: "running"; done: number; total: number }
  | { phase: "done"; totals: Totals; failure: string | null };

const NO_COLUMNS: ColumnMap = { name: null, description: null, status: null, due: null, assignee: null, assigneeEmail: null, labels: null, id: null };
const PREVIEW_ROWS = 10;

export function ImportFlow({ projectId, projectKey, states, members, labels, caps, timezone }: ImportFlowProps) {
  const t = useTranslations("projects.import");
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [chosen, setChosen] = useState<ChosenFile | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [columns, setColumns] = useState<ColumnMap>(NO_COLUMNS);
  const [dateFormat, setDateFormat] = useState<DateFormat>("DMY");
  const [dateAmbiguous, setDateAmbiguous] = useState(false);
  const [stateOverride, setStateOverride] = useState<Readonly<Record<string, string>>>({});
  const [memberOverride, setMemberOverride] = useState<Readonly<Record<string, string>>>({});
  const [emailMatches, setEmailMatches] = useState<Readonly<Record<string, string>>>({});
  const [preview, setPreview] = useState<{ willUpdate: number; willKeep: number } | null>(null);
  const [run, setRun] = useState<Run>({ phase: "idle" });

  const offered = offeredStates(states, caps.approve);
  const defaultStateId = offered.find((s) => s.isDefault)?.id ?? offered[0]?.id ?? "";
  const gatedHidden = !caps.approve && states.some((s) => s.requiresApproval);
  const memberOptions = members.map((m) => ({ ...m, email: "" }));
  const memberName = new Map(members.map((m) => [m.id, m.name]));
  const stateName = new Map(states.map((s) => [s.id, s.name]));

  const reset = () => {
    setFileError(null);
    setLoaded(null);
    setColumns(NO_COLUMNS);
    setStateOverride({});
    setMemberOverride({});
    setEmailMatches({});
    setPreview(null);
    setRun({ phase: "idle" });
  };

  const onFile = async (files: FileList | null) => {
    reset();
    setChosen(chosenFileFrom(files));
    const file = files?.[0];
    if (!file) return;
    if (file.size > IMPORT_FILE_BYTES) return setFileError(t("file.tooBig"));
    const text = decodeCsv(new Uint8Array(await file.arrayBuffer()));
    const body = text.trimStart();
    if (file.name.toLowerCase().endsWith(".json") || body.startsWith("{")) {
      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch {
        return setFileError(t("file.unreadable"));
      }
      const board = readTrelloBoard(json, timezone);
      if (!board) return setFileError(t("file.unreadable"));
      if (board.cards.length === 0) return setFileError(t("file.empty"));
      if (board.cards.length > IMPORT_MAX_ROWS) return setFileError(t("file.tooMany", { max: IMPORT_MAX_ROWS }));
      setLoaded({ kind: "TRELLO", fileName: file.name, board });
      return;
    }
    const csv = parseCsv(text);
    if (csv.tooMany) return setFileError(t("file.tooMany", { max: IMPORT_MAX_ROWS }));
    if (csv.headers.length === 0 || csv.rows.length === 0) return setFileError(t("file.empty"));
    const guessed = guessColumns(csv.headers);
    setColumns(guessed);
    const formats = guessDateFormat(guessed.due === null ? [] : csv.rows.map((r) => r[guessed.due!] ?? ""));
    setDateFormat(formats.format);
    setDateAmbiguous(formats.ambiguous);
    setLoaded({ kind: "CSV", fileName: file.name, csv });
  };

  // ── What the file holds, under the current matching ───────────────
  const csv = loaded?.kind === "CSV" ? loaded.csv : null;
  const board = loaded?.kind === "TRELLO" ? loaded.board : null;
  const headerName = (i: number) => csv?.headers[i] || t("file.column", { n: i + 1 });

  /** Status values (CSV, keyed by their folded text) or lists (Trello, keyed by id), with their task counts. */
  const statusRows: { key: string; label: string; count: number }[] = [];
  if (csv && columns.status !== null) {
    const seen = new Map<string, { label: string; count: number }>();
    for (const r of csv.rows) {
      const v = (r[columns.status] ?? "").trim();
      const key = fold(v);
      const entry = seen.get(key) ?? { label: v, count: 0 };
      entry.count++;
      seen.set(key, entry);
    }
    for (const [key, e] of seen) statusRows.push({ key, label: e.label, count: e.count });
  } else if (board) {
    for (const list of board.lists) {
      const count = board.cards.filter((c) => c.listId === list.id).length;
      if (count > 0) statusRows.push({ key: list.id, label: list.name, count });
    }
  }
  const stateFor = new Map(statusRows.map((s) => [s.key, stateOverride[s.key] ?? guessState(s.label, offered) ?? defaultStateId]));

  /** People (CSV: an email or a folded name; Trello: a member id) → who they are in the file. */
  const people: { key: string; label: string; isEmail: boolean }[] = [];
  if (csv && (columns.assignee !== null || columns.assigneeEmail !== null)) {
    const seen = new Set<string>();
    for (const r of csv.rows) {
      const key = csvPersonKey(r, columns);
      if (key === null || seen.has(key)) continue;
      seen.add(key);
      const email = columns.assigneeEmail === null ? "" : firstPerson(r[columns.assigneeEmail] ?? "");
      const name = columns.assignee === null ? "" : firstPerson(r[columns.assignee] ?? "");
      people.push({ key, label: email !== "" ? (name !== "" ? `${name} · ${email}` : email) : name, isEmail: email !== "" });
    }
  } else if (board) {
    const used = new Set(board.cards.map((c) => c.memberId).filter((m): m is string => m !== null));
    for (const m of board.members) if (used.has(m.id)) people.push({ key: m.id, label: m.name, isEmail: false });
  }
  const guessedMember = (p: (typeof people)[number]): string | null =>
    p.isEmail ? (emailMatches[p.key] ?? null) : guessMember({ name: p.label, email: null }, memberOptions);
  const memberFor = new Map(
    people.map((p) => {
      const o = memberOverride[p.key];
      return [p.key, o === undefined ? guessedMember(p) : o === "" ? null : o] as const;
    }),
  );

  const built = csv
    ? buildCsvRows({ csv, columns, dateFormat, stateFor, defaultStateId, memberFor, existingLabels: labels })
    : board
      ? buildTrelloRows({ board, stateFor, defaultStateId, memberFor, existingLabels: labels })
      : null;
  const ready = Boolean(loaded) && (!csv || columns.name !== null) && defaultStateId !== "";
  const rows = ready && built ? built.rows : [];

  // ── Two server reads: who the file's emails are, and what a re-import would touch ──
  const emailKeys = people.filter((p) => p.isEmail).map((p) => p.key).join("\n");
  useEffect(() => {
    if (emailKeys === "") return;
    let live = true;
    matchPeopleAction(projectKey, projectId, emailKeys.split("\n"))
      .then((r) => {
        if (live && r.ok) setEmailMatches(r.value);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [emailKeys, projectId, projectKey]);

  const source: ImportSource | null = loaded?.kind ?? null;
  const idKey = rows.map((r) => r.sourceId).filter((s): s is string => s !== null).join("\n");
  useEffect(() => {
    if (source === null || idKey === "") return;
    let live = true;
    previewMatchesAction(projectKey, { projectId, source, sourceIds: idKey.split("\n") })
      .then((r) => {
        if (live && r.ok) setPreview(r.value);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [idKey, source, projectId, projectKey]);
  const matches = idKey === "" ? { willUpdate: 0, willKeep: 0 } : preview;

  // Leaving mid-run stops the import part-way: the browser asks first.
  const running = run.phase === "running";
  useEffect(() => {
    if (!running) return;
    const hold = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", hold);
    return () => window.removeEventListener("beforeunload", hold);
  }, [running]);

  const startRun = async () => {
    if (!loaded || rows.length === 0) return;
    const total = rows.length;
    const totals: Totals = { created: 0, updated: 0, kept: 0, unchanged: 0 };
    setRun({ phase: "running", done: 0, total });
    try {
      const start = await startImportAction(projectKey, {
        projectId,
        source: loaded.kind,
        fileName: loaded.fileName.slice(0, 200).trim() || "import",
        rowCount: total,
      });
      if (!start.ok) {
        toast.error(start.message);
        setRun({ phase: "idle" });
        return;
      }
      let done = 0;
      let failure: string | null = null;
      for (const batch of batchRows(rows)) {
        const r = await importBatchAction(projectKey, start.value.jobId, batch);
        if (!r.ok) {
          failure = r.message;
          break;
        }
        totals.created += r.value.created;
        totals.updated += r.value.updated;
        totals.kept += r.value.kept;
        totals.unchanged += r.value.unchanged;
        done += batch.length;
        setRun({ phase: "running", done, total });
      }
      const finish = await finishImportAction(projectKey, start.value.jobId);
      if (!finish.ok && failure === null) failure = finish.message;
      setRun({ phase: "done", totals, failure });
      if (failure) toast.error(failure);
      router.refresh();
    } catch (err) {
      // A redirect (an expired session) rejects the action's promise and then navigates by itself.
      if (isActionRedirect(err)) return;
      setRun({ phase: "done", totals, failure: t("result.failed") });
      router.refresh();
    }
  };

  const startOver = () => {
    reset();
    setChosen(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  const fieldLabel = (f: ImportField) => t(`columns.fields.${f}`);
  const stats = built?.stats;

  return (
    <div className="flex flex-col gap-4" data-testid="import-flow">
      <SectionCard title={t("file.title")} description={t("intro")}>
        <div className="flex max-w-xl flex-col gap-3">
          <FileDropField
            id="import-file"
            name="file"
            label={t("file.label")}
            hint={t("file.hint")}
            draggingHint={t("file.dragging")}
            chooseLabel={t("file.choose")}
            chosen={chosen}
            onChange={(files) => void onFile(files)}
            onClear={startOver}
            inputRef={inputRef}
            accept=".csv,.json,.txt,text/csv,application/json"
            disabled={running}
            error={fileError ?? undefined}
          />
          <p className="text-xs text-muted-foreground">{t("file.how")}</p>
          <Callout tone="info">{t("private")}</Callout>
        </div>
      </SectionCard>

      {csv ? (
        <SectionCard title={t("columns.title")} description={t("columns.description")}>
          <div className="grid max-w-3xl gap-3 sm:grid-cols-2" data-testid="import-columns">
            {IMPORT_FIELDS.map((f) => (
              <Field key={f} label={fieldLabel(f)} htmlFor={`import-col-${f}`}>
                <NativeSelect
                  id={`import-col-${f}`}
                  value={columns[f] === null ? "" : String(columns[f])}
                  disabled={running}
                  data-field={f}
                  onChange={(e) => {
                    const v = e.target.value === "" ? null : Number(e.target.value);
                    setColumns((c) => ({ ...c, [f]: v }));
                    setPreview(null);
                    if (f === "due" && v !== null) {
                      const formats = guessDateFormat(csv.rows.map((r) => r[v] ?? ""));
                      setDateFormat(formats.format);
                      setDateAmbiguous(formats.ambiguous);
                    }
                  }}
                >
                  <option value="">{t("columns.none")}</option>
                  {csv.headers.map((_, i) => (
                    <option key={i} value={i}>
                      {headerName(i)}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            ))}
          </div>
          {columns.name === null ? (
            <div className="mt-3 max-w-xl">
              <Callout tone="caution">
                <span data-testid="import-need-name">{t("columns.needName")}</span>
              </Callout>
            </div>
          ) : null}
          {columns.id !== null ? <p className="mt-3 text-xs text-muted-foreground">{t("columns.idHint")}</p> : null}
          {columns.due !== null && dateAmbiguous ? (
            <div className="mt-3 max-w-xs">
              <Field label={t("columns.dateFormat")} htmlFor="import-date-format">
                <NativeSelect
                  id="import-date-format"
                  value={dateFormat}
                  disabled={running}
                  onChange={(e) => setDateFormat(e.target.value === "MDY" ? "MDY" : "DMY")}
                  data-testid="import-date-format"
                >
                  <option value="DMY">{t("columns.dmy")}</option>
                  <option value="MDY">{t("columns.mdy")}</option>
                </NativeSelect>
              </Field>
            </div>
          ) : null}
        </SectionCard>
      ) : null}

      {ready && statusRows.length > 0 ? (
        <SectionCard
          title={board ? t("statuses.titleTrello") : t("statuses.titleCsv")}
          description={board ? t("statuses.descriptionTrello") : t("statuses.descriptionCsv")}
        >
          <MappingList
            testId="import-statuses"
            fromLabel={t("statuses.fromFile")}
            toLabel={t("statuses.toState")}
            rows={statusRows.map((s) => ({
              key: s.key,
              label: s.label === "" ? t("statuses.empty") : s.label,
              note: t("statuses.rows", { count: s.count }),
              value: stateFor.get(s.key) ?? defaultStateId,
            }))}
            options={offered.map((s) => ({ value: s.id, label: s.name }))}
            disabled={running}
            onChange={(key, value) => setStateOverride((o) => ({ ...o, [key]: value }))}
          />
          {gatedHidden ? <p className="mt-3 text-xs text-muted-foreground">{t("statuses.approvalHint")}</p> : null}
        </SectionCard>
      ) : null}

      {ready && people.length > 0 ? (
        <SectionCard title={t("people.title")} description={t("people.description")}>
          <MappingList
            testId="import-people"
            fromLabel={t("people.fromFile")}
            toLabel={t("people.toMember")}
            rows={people.map((p) => ({ key: p.key, label: p.label, value: memberFor.get(p.key) ?? "" }))}
            options={[{ value: "", label: t("people.nobody") }, ...members.map((m) => ({ value: m.id, label: m.name }))]}
            disabled={running}
            onChange={(key, value) => setMemberOverride((o) => ({ ...o, [key]: value }))}
          />
        </SectionCard>
      ) : null}

      {ready && built && stats ? (
        <SectionCard title={t("check.title")}>
          <div className="flex flex-col gap-4" data-testid="import-check">
            <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
              <li data-testid="import-check-create">{t("check.create", { count: Math.max(0, rows.length - (matches?.willUpdate ?? 0) - (matches?.willKeep ?? 0)) })}</li>
              {matches && matches.willUpdate > 0 ? <li data-testid="import-check-update">{t("check.update", { count: matches.willUpdate })}</li> : null}
              {matches && matches.willKeep > 0 ? <li data-testid="import-check-keep">{t("check.keep", { count: matches.willKeep })}</li> : null}
              {stats.skippedNoName > 0 ? <li>{t("check.skipped", { count: stats.skippedNoName })}</li> : null}
              {stats.shortened > 0 ? <li>{t("check.shortened", { count: stats.shortened })}</li> : null}
              {stats.badDates > 0 ? <li>{t("check.badDates", { count: stats.badDates })}</li> : null}
              {stats.duplicateIds > 0 ? <li>{t("check.duplicateIds", { count: stats.duplicateIds })}</li> : null}
              {board && board.archivedCards > 0 ? <li>{t("check.archived", { count: board.archivedCards })}</li> : null}
              {stats.newLabels.length > 0 ? (
                <li>
                  {caps.manageLabels
                    ? t("check.newLabels", { names: stats.newLabels.join(", ") })
                    : t("check.noLabelRight", { names: stats.newLabels.join(", ") })}
                </li>
              ) : null}
            </ul>
            {csv && columns.id === null ? (
              <Callout tone="caution">
                <span data-testid="import-check-no-id">{t("check.noId")}</span>
              </Callout>
            ) : null}
            {rows.length > 0 ? (
              <div className="flex flex-col gap-2">
                <p className="text-xs text-muted-foreground">{t("check.first")}</p>
                <DataTable density="compact">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("check.columns.name")}</TableHead>
                        <TableHead>{t("check.columns.status")}</TableHead>
                        <TableHead>{t("check.columns.due")}</TableHead>
                        <TableHead>{t("check.columns.assignee")}</TableHead>
                        <TableHead>{t("check.columns.labels")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.slice(0, PREVIEW_ROWS).map((r, i) => (
                        <TableRow key={i} data-testid="import-preview-row">
                          <TableCell className="max-w-[24ch] truncate">{r.title}</TableCell>
                          <TableCell className="truncate">{stateName.get(r.stateId) ?? ""}</TableCell>
                          <TableCell className="num whitespace-nowrap">{r.targetDate ?? "—"}</TableCell>
                          <TableCell className="truncate">{r.assigneeMemberId ? (memberName.get(r.assigneeMemberId) ?? "") : "—"}</TableCell>
                          <TableCell className="max-w-[20ch] truncate">{r.labels.length > 0 ? r.labels.join(", ") : "—"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </DataTable>
                {rows.length > PREVIEW_ROWS ? <p className="text-xs text-muted-foreground">{t("check.more", { count: rows.length - PREVIEW_ROWS })}</p> : null}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{t("check.nothing")}</p>
            )}

            {run.phase === "running" ? (
              <div className="flex max-w-md flex-col gap-1.5" data-testid="import-running" role="status">
                <ProgressMeter value={run.done} total={run.total} label={t("run.importing", { done: run.done, total: run.total })} />
              </div>
            ) : run.phase === "done" ? null : (
              <div>
                <Button type="button" onClick={() => void startRun()} disabled={rows.length === 0} data-testid="import-submit">
                  <FileUpIcon />
                  {t("check.submit", { count: rows.length })}
                </Button>
              </div>
            )}
          </div>
        </SectionCard>
      ) : null}

      {run.phase === "done" ? (
        <SectionCard title={t("result.title")}>
          <div className="flex flex-col gap-3" data-testid="import-result">
            <p className="num text-sm" data-testid="import-result-summary">
              {t("result.summary", run.totals)}
            </p>
            {run.failure ? (
              <>
                <FormMessage state={{ ok: false, message: run.failure }} />
                <p className="text-sm text-muted-foreground">{t("result.stopped")}</p>
              </>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button asChild size="sm">
                <Link href={`/projects/${projectKey}/backlog`}>{t("result.openBacklog")}</Link>
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={startOver}>
                {t("result.another")}
              </Button>
            </div>
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}

/**
 * A from → to list: one row per value found in the file, each with the
 * select that says where it goes. A list, not a table — these are controls
 * the member is asked to set, not records at rest (UI.md rule 3's audit).
 */
function MappingList({
  testId,
  fromLabel,
  toLabel,
  rows,
  options,
  disabled,
  onChange,
}: {
  testId: string;
  fromLabel: string;
  toLabel: string;
  rows: readonly { key: string; label: string; note?: string; value: string }[];
  options: readonly { value: string; label: string }[];
  disabled: boolean;
  onChange: (key: string, value: string) => void;
}) {
  const t = useTranslations("projects.import");
  return (
    <div className="flex max-w-3xl flex-col" data-testid={testId}>
      <div className="eyebrow hidden grid-cols-[minmax(0,1fr)_minmax(10rem,18rem)] gap-3 pb-1.5 text-muted-foreground sm:grid">
        <span>{fromLabel}</span>
        <span>{toLabel}</span>
      </div>
      <ul className="flex flex-col divide-y divide-border">
        {rows.map((r) => (
          <li key={r.key} className="grid gap-1.5 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(10rem,18rem)] sm:items-center sm:gap-3" data-key={r.key}>
            <span className="min-w-0">
              <span className="block truncate text-sm">{r.label}</span>
              {r.note ? <span className="block text-xs text-muted-foreground">{r.note}</span> : null}
            </span>
            <NativeSelect
              value={r.value}
              disabled={disabled}
              aria-label={t("mapTo", { from: r.label, to: toLabel })}
              onChange={(e) => onChange(r.key, e.target.value)}
            >
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </NativeSelect>
          </li>
        ))}
      </ul>
    </div>
  );
}
