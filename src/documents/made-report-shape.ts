import { createHash } from "node:crypto";

import { startOfLocalDay } from "@/lib/duration";
import type { UpdateSectionKey } from "@/modules/work/update-body";

/**
 * THE SHAPE OF A MADE MONTHLY REPORT'S CONTENT, AND ITS FINGERPRINT (Phase 7
 * slice 119; founder decision C95) — the PURE half: the types the drawing
 * reads, the month's window in a zone, the canonical JSON the fingerprint is
 * taken over, and the ids a content names. No database, no request, so the
 * PDF and the unit test import it without a connection; the reading itself
 * is `./made-report-content.ts`.
 *
 * THE FINGERPRINT: sha256 over the canonical JSON of the content — keys
 * sorted at every depth, so two reads of the same rows hash the same whatever
 * order Postgres hands the keys of a jsonb body back in. `makeReport` stores
 * it; `publishReport` derives the content again, as the client, and refuses
 * on any difference (MADE_REPORT_STALE). Never a hash of anything that has
 * not been through Postgres (AGENTS.md's trap): every body here was read
 * back from it.
 */

export type MadeReportHealth = "ON_TRACK" | "AT_RISK" | "OFF_TRACK" | "ON_HOLD" | "COMPLETE";

export type MadeReportTask = {
  readonly id: string;
  readonly title: string;
  /** The day it was finished, `YYYY-MM-DD` in the workspace's zone. */
  readonly completedOn: string;
};

export type MadeReportSection = {
  readonly key: UpdateSectionKey;
  /** A CUSTOM section's own heading; null for the five fixed keys (titled by the drawing). */
  readonly title: string | null;
  /** The section's ProseMirror document, as stored. */
  readonly body: unknown;
};

export type MadeReportUpdate = {
  readonly id: string;
  readonly seq: number;
  readonly health: MadeReportHealth;
  readonly title: string | null;
  /** The day it was published, `YYYY-MM-DD` in the workspace's zone. */
  readonly publishedOn: string;
  /** The update's own period, `YYYY-MM-DD` each, when it named one. */
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  /** A note the agency added after publishing, or null. */
  readonly editNote: string | null;
  readonly sections: readonly MadeReportSection[];
};

export type MadeReportProject = {
  readonly id: string;
  readonly name: string;
  /** The newest update's health in the month, or null with none. */
  readonly health: MadeReportHealth | null;
  readonly tasks: readonly MadeReportTask[];
  readonly updates: readonly MadeReportUpdate[];
};

export type MadeReportContent = {
  /** `YYYY-MM-01`. */
  readonly month: string;
  /** In the ticked order. */
  readonly projects: readonly MadeReportProject[];
};

/** The drawing's ceilings (the database CHECKs the same numbers on the row). */
export const MADE_REPORT_MAX_PROJECTS = 25;
export const MADE_REPORT_MAX_TASKS = 500;
export const MADE_REPORT_MAX_UPDATES = 60;

const MONTH = /^(\d{4})-(\d{2})-01$/;

/** The month after `YYYY-MM-01`, as `YYYY-MM-01`. */
export function nextMonth(month: string): string {
  const m = MONTH.exec(month);
  if (!m) throw new Error("nextMonth: not a report month");
  const year = Number(m[1]);
  const mon = Number(m[2]);
  const ny = mon === 12 ? year + 1 : year;
  const nm = mon === 12 ? 1 : mon + 1;
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-01`;
}

/**
 * The month's window as instants, `[from, to)`, in a zone: the first moment
 * of the month to the first moment of the next.
 */
export function reportMonthWindow(month: string, timeZone: string): { from: Date; to: Date } {
  return { from: startOfLocalDay(month, timeZone), to: startOfLocalDay(nextMonth(month), timeZone) };
}

/**
 * JSON with every object's keys sorted, at every depth. Arrays keep their
 * order (it is part of the content: the ticked order, a list's order).
 * `undefined` is dropped as `JSON.stringify` drops it.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** sha256, lower-case hex, over the canonical JSON of the content. */
export const contentFingerprint = (content: MadeReportContent): string =>
  createHash("sha256").update(canonicalJson(content), "utf8").digest("hex");

/** Every task id and update id a content names — what the publish check share-locks. */
export function namedIds(content: MadeReportContent): { taskIds: string[]; updateIds: string[] } {
  return {
    taskIds: content.projects.flatMap((p) => p.tasks.map((t) => t.id)),
    updateIds: content.projects.flatMap((p) => p.updates.map((u) => u.id)),
  };
}
