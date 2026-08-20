import type { TimerEntry } from "@/modules/time";

/** One-line label of an entry for pills, toasts and lists (pure; not a server action). */
export const labelOf = (e: TimerEntry): string => {
  if (e.workItem && e.project) return `${e.project.key}-${e.workItem.number} ${e.workItem.title}`;
  if (e.project) return `${e.project.key} · ${e.description ?? e.project.name}`;
  return e.description ?? "";
};
