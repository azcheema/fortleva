import type { MadeReportContent } from "./made-report-shape";

/**
 * The drafter's pure rules (Phase 7 slice 120; founder decision C96) — a
 * module with no database import, so the unit test can read them without
 * a connection. The drafter itself is `./report-drafts.ts`.
 */

export type DraftOutcome = "DRAFTED" | "EXISTS" | "NO_AUDIENCE" | "EMPTY" | "TOO_LARGE" | "FAILED";

/** The most clients one kick considers per workspace; the rest are considered next kick. */
export const DRAFT_CLIENT_CAP = 100;
/** A FAILED (client, month) is tried this many times in all, then left (the ledger's CHECK). */
export const DRAFT_MAX_ATTEMPTS = 3;

/** EMPTY when no project has a finished task or a published update in the month (C96 (a)). */
export const isEmptyContent = (content: MadeReportContent): boolean =>
  content.projects.every((p) => p.tasks.length === 0 && p.updates.length === 0);
