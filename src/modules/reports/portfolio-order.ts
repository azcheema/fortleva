/**
 * THE PROJECT HEALTH TABLE'S ORDER (Phase 6 slice 116, founder decision
 * C92 (c): "most worrying first"). PURE, so the rule is a unit test.
 *
 * Running projects come before finished ones (C92 (a): the finished are
 * behind "Show finished", and appended when shown). Within each, the
 * ATTENTION rank: Off track, then At risk, then a late update, then the
 * rest — a late project already Off track is at the top on its health. A
 * late update ranks only for a viewer who may see the schedule
 * (`project_update:view`, the project header's rule); for anyone else
 * "late" is not on the screen, so it must not move a row either.
 *
 * Ties keep the order the rows came in — client name, then project name,
 * from the database (`Array.prototype.sort` is stable).
 */

import type { ProjectHealth } from "@/generated/prisma/enums";

export const RUNNING_PROJECT_STATUSES = ["PLANNED", "ACTIVE", "PAUSED"] as const;

export type OrderInput = {
  readonly running: boolean;
  readonly health: ProjectHealth | null;
  /** The schedule, already null when the viewer may not see it. */
  readonly schedule: { readonly state: "scheduled" | "due" | "late" } | null;
};

export function attentionRank(row: OrderInput): number {
  if (row.health === "OFF_TRACK") return 0;
  if (row.health === "AT_RISK") return 1;
  if (row.schedule?.state === "late") return 2;
  return 3;
}

export function portfolioOrder<T extends OrderInput>(rows: readonly T[]): T[] {
  return [...rows].sort(
    (a, b) => Number(b.running) - Number(a.running) || attentionRank(a) - attentionRank(b),
  );
}
