import { singleLineName } from "./single-line-name";

/**
 * PROJECT TEMPLATES — the rules the forms and the services share (slice
 * 124, founder decision C100; design doc §3–§4). Pure, RSC-safe, no
 * directive: the Settings table and the save dialog read the length, the
 * services decide with `templateName`.
 */

/** What the Save dialog says before anything is written (`readTemplateSaveSummary`). */
export type TemplateSaveSummary = {
  /** Tasks and milestones a template made now would hold. */
  tasks: number;
  milestones: number;
  /** The day its dates would be counted from, `YYYY-MM-DD`. */
  anchor: string;
  /** True when that is the project's start date; false = the day it was made. */
  anchorIsStart: boolean;
  /** The workspace's template names, for the dialog's "replaces" line. */
  names: string[];
  /** More tasks or milestones than a template holds. */
  tooLarge: boolean;
};

/** A template's name, at most this many code points (the CHECK `project_template_name_ok`). */
export const MAX_TEMPLATE_NAME_LENGTH = 80;

/**
 * A template name as it will be stored, or the refusal: one line (any
 * whitespace run becomes a space), trimmed, never blank, at most 80, no
 * control or invisible formatting character — the stage and label rule.
 * Uniqueness ignoring case is the DATABASE's (`project_template_name_ci_key`,
 * Postgres `lower()`), never decided here: JavaScript folds a few letters
 * differently (slice 123's lesson).
 */
export const templateName = (raw: string) => singleLineName(raw, MAX_TEMPLATE_NAME_LENGTH);
