import { fail } from "@/lib/domain-error";
import { normalizeUpdateSection } from "@/lib/rich-text/normalize";

/**
 * THE SHAPE OF A PROGRESS UPDATE'S BODY, and the one place it is decided
 * (DATA_MODEL.md §6.16: `body Json = { sections: [{ key, title?, body
 * Tiptap }] }`, plus the composer's metric toggles). Pure — no database,
 * no request — so the composer (a client component) and the service
 * share the constants, and the unit test can pin the rules without a
 * transaction.
 *
 * SECTIONS ARE A FIXED VOCABULARY, NOT FREE HEADINGS. Asana's and
 * Linear's status posts converge on the same five questions — what
 * happened, what is done, what is next, what is in the way, what do you
 * need from me — and a client who reads three agencies' portals should
 * find the same five headings in each. `CUSTOM` exists for the sixth
 * question a project sometimes has and carries its own title; the five
 * fixed keys carry none, and the RENDERER titles them in the reader's
 * language, which is what keeps a Swedish client from reading "Blockers"
 * under an English author's post.
 */
export const UPDATE_SECTION_KEYS = ["SUMMARY", "DONE", "NEXT", "BLOCKERS", "DECISIONS_NEEDED"] as const;
export type UpdateFixedSectionKey = (typeof UPDATE_SECTION_KEYS)[number];
export type UpdateSectionKey = UpdateFixedSectionKey | "CUSTOM";

/** The metric groups the composer can leave out of the frozen portal snapshot. */
export const UPDATE_METRIC_GROUPS = ["tasks", "milestones", "versions", "requests", "hours"] as const;
export type UpdateMetricGroup = (typeof UPDATE_METRIC_GROUPS)[number];

export const UPDATE_TITLE_MAX = 200;
export const UPDATE_EDIT_NOTE_MAX = 500;
export const UPDATE_CUSTOM_TITLE_MAX = 120;
/** Five fixed keys, each at most once, plus room for a few custom ones. */
export const UPDATE_SECTIONS_MAX = 8;

export type UpdateSection = {
  readonly key: UpdateSectionKey;
  /** Only a CUSTOM section carries one; the fixed keys are titled by the renderer. */
  readonly title: string | null;
  /** A canonical ProseMirror document (the description schema). */
  readonly body: unknown;
};

export type UpdateMetricsInclude = Readonly<Record<UpdateMetricGroup, boolean>>;

export type UpdateBody = {
  readonly sections: readonly UpdateSection[];
  readonly metrics: { readonly include: UpdateMetricsInclude };
};

export type NormalizedUpdateBody = {
  /** What is stored: only the sections that say something, in the order sent. */
  readonly body: UpdateBody;
  /** Every section's text, joined — `bodyText`; null when the post says nothing. */
  readonly text: string | null;
};

export const ALL_METRICS_INCLUDED: UpdateMetricsInclude = {
  tasks: true,
  milestones: true,
  versions: true,
  requests: true,
  hours: true,
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const isSectionKey = (v: unknown): v is UpdateSectionKey =>
  typeof v === "string" && (v === "CUSTOM" || (UPDATE_SECTION_KEYS as readonly string[]).includes(v));

/**
 * Whatever crossed the server-action boundary → the stored body, or
 * INVALID_INPUT / UPDATE_TOO_LARGE. Every section's document goes
 * through the same allow-listing normaliser the description uses
 * (`src/lib/rich-text/normalize.ts`), so a crafted node, a `javascript:`
 * link or a leaf handed children is refused here and never stored — a
 * published update is CLIENT_VISIBLE by design, so this is the last
 * gate before a stranger's browser. Empty sections are DROPPED rather
 * than stored as blanks: the renderer would otherwise draw a heading
 * over nothing.
 */
export function normalizeUpdateBody(input: unknown): NormalizedUpdateBody {
  const root: Record<string, unknown> = isRecord(input) ? input : fail("INVALID_INPUT", "update body is not an object");
  const rawSections: unknown = root["sections"];
  if (!Array.isArray(rawSections)) fail("INVALID_INPUT", "update body has no sections");
  const list = rawSections as unknown[];
  if (list.length > UPDATE_SECTIONS_MAX) fail("INVALID_INPUT", "too many sections");

  const seenFixed = new Set<string>();
  const sections: UpdateSection[] = [];
  const texts: string[] = [];
  for (const raw of list) {
    const section: Record<string, unknown> = isRecord(raw) ? raw : fail("INVALID_INPUT", "a section is not an object");
    const rawKey = section["key"];
    const key: UpdateSectionKey = isSectionKey(rawKey) ? rawKey : fail("INVALID_INPUT", "unknown section key");
    let title: string | null = null;
    if (key === "CUSTOM") {
      const t = section["title"];
      const trimmed: string = typeof t === "string" ? t.trim() : fail("INVALID_INPUT", "a custom section needs a title");
      if (trimmed.length === 0 || trimmed.length > UPDATE_CUSTOM_TITLE_MAX || /[\t\r\n]/.test(trimmed)) {
        fail("INVALID_INPUT", "custom section title");
      }
      title = trimmed;
    } else {
      if (seenFixed.has(key)) fail("INVALID_INPUT", `duplicate section ${key}`);
      seenFixed.add(key);
    }
    const n = normalizeUpdateSection(section["body"] ?? null);
    if (n.doc === null || n.text === null) continue;
    sections.push({ key, title, body: n.doc });
    texts.push(n.text);
  }

  const rawMetrics: unknown = root["metrics"];
  const include: Record<UpdateMetricGroup, boolean> = { ...ALL_METRICS_INCLUDED };
  if (rawMetrics !== undefined) {
    const metrics: Record<string, unknown> = isRecord(rawMetrics) ? rawMetrics : fail("INVALID_INPUT", "metrics");
    const raw: Record<string, unknown> = isRecord(metrics["include"]) ? metrics["include"] : fail("INVALID_INPUT", "metrics.include");
    for (const group of UPDATE_METRIC_GROUPS) {
      const v = raw[group];
      if (v === undefined) continue;
      if (typeof v === "boolean") include[group] = v;
      else fail("INVALID_INPUT", `metrics.include.${group}`);
    }
  }

  return {
    body: { sections, metrics: { include } },
    text: texts.length === 0 ? null : texts.join("\n\n"),
  };
}

/**
 * A stored body, read back — total over what `normalizeUpdateBody`
 * writes, and defensive about a row somebody hand-planted: an unknown
 * shape reads as an EMPTY body rather than a throw on a client's page.
 */
export function readUpdateBody(stored: unknown): UpdateBody {
  if (!isRecord(stored) || !Array.isArray(stored["sections"])) {
    return { sections: [], metrics: { include: ALL_METRICS_INCLUDED } };
  }
  const sections: UpdateSection[] = [];
  for (const raw of stored["sections"]) {
    if (!isRecord(raw) || !isSectionKey(raw["key"]) || !isRecord(raw["body"])) continue;
    sections.push({
      key: raw["key"],
      title: typeof raw["title"] === "string" ? raw["title"] : null,
      body: raw["body"],
    });
  }
  const include: Record<UpdateMetricGroup, boolean> = { ...ALL_METRICS_INCLUDED };
  const metrics = stored["metrics"];
  if (isRecord(metrics) && isRecord(metrics["include"])) {
    for (const group of UPDATE_METRIC_GROUPS) {
      const v = (metrics["include"] as Record<string, unknown>)[group];
      if (typeof v === "boolean") include[group] = v;
    }
  }
  return { sections, metrics: { include } };
}

/** The fifteen-minute retraction window (DATA_MODEL.md §6.16) — the trigger applies the same number. */
export const UPDATE_RETRACT_WINDOW_MS = 15 * 60 * 1000;
