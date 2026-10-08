import { fail } from "@/lib/domain-error";

import {
  ALL_METRICS_INCLUDED,
  UPDATE_CUSTOM_TITLE_MAX,
  UPDATE_METRIC_GROUPS,
  UPDATE_SECTION_KEYS,
  UPDATE_SECTIONS_MAX,
  type UpdateBody,
  type UpdateFixedSectionKey,
  type UpdateMetricsInclude,
  type UpdateSection,
  type UpdateSectionKey,
} from "./update-body";

/**
 * PROGRESS-UPDATE LAYOUTS (Phase 5 slice 105; founder decision C73 (c), (d),
 * (g); DATA_MODEL.md §6.16 `ProjectUpdateTemplate`) — the pure half: what a
 * layout may hold, the standard one, and how the composer lays a draft out.
 * No database, no request, so the settings dialog, the service and the
 * composer share one set of rules and the unit test pins them.
 *
 * A LAYOUT IS HEADINGS AND NUMBERS (C73 (d)): which of the five fixed
 * headings a new update opens with and in what order, up to three of the
 * workspace's own (a CUSTOM section, titled), and which numbers start
 * ticked. DONE is always there (C73 (g)): "What got done" fills it by itself
 * and the composer's "Add" buttons write to it. The writing hints stay
 * Fortleva's own — a layout carries no text.
 *
 * A LAYOUT IS COPIED, NEVER LINKED: an update's body holds its own sections,
 * so editing or deleting a layout changes no draft and no post.
 */

export const LAYOUT_NAME_MAX = 80;
/** "Up to three headings of your own" (C73 (d)); five fixed + three = UPDATE_SECTIONS_MAX. */
export const LAYOUT_CUSTOM_MAX = 3;

export type LayoutHeading =
  | { readonly key: UpdateFixedSectionKey; readonly title: null }
  | { readonly key: "CUSTOM"; readonly title: string };

export type UpdateLayout = {
  readonly sections: readonly LayoutHeading[];
  readonly metrics: UpdateMetricsInclude;
};

/** Fortleva standard — today's composer exactly: the five headings, every number. */
export const STANDARD_LAYOUT: UpdateLayout = {
  sections: UPDATE_SECTION_KEYS.map((key) => ({ key, title: null })),
  metrics: ALL_METRICS_INCLUDED,
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isFixedKey = (v: unknown): v is UpdateFixedSectionKey =>
  typeof v === "string" && (UPDATE_SECTION_KEYS as readonly string[]).includes(v);

/** A heading's own title, trimmed; the same rule an update's CUSTOM section meets. */
export const cleanHeadingTitle = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  return t.length >= 1 && t.length <= UPDATE_CUSTOM_TITLE_MAX && !/[\t\r\n]/.test(t) ? t : null;
};

/** A layout's name, trimmed, 1–80 (the column's CHECK says the same). */
export const cleanLayoutName = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  return t.length >= 1 && t.length <= LAYOUT_NAME_MAX ? t : null;
};

/**
 * The headings a layout may store, or INVALID_INPUT: each fixed key at most
 * once, DONE present, at most three of the workspace's own with distinct
 * titles (whatever their case), eight in all.
 */
export function parseLayoutSections(raw: unknown): LayoutHeading[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > UPDATE_SECTIONS_MAX) fail("INVALID_INPUT", "layout sections");
  const out: LayoutHeading[] = [];
  const fixed = new Set<string>();
  const titles = new Set<string>();
  for (const item of raw as unknown[]) {
    if (!isRecord(item)) fail("INVALID_INPUT", "a layout heading is not an object");
    const r = item as Record<string, unknown>;
    if (r["key"] === "CUSTOM") {
      const title = cleanHeadingTitle(r["title"]);
      if (title === null) fail("INVALID_INPUT", "a layout heading's title");
      const folded = title!.toLocaleLowerCase();
      if (titles.has(folded)) fail("INVALID_INPUT", "a layout heading twice");
      titles.add(folded);
      out.push({ key: "CUSTOM", title: title! });
    } else if (isFixedKey(r["key"])) {
      if (fixed.has(r["key"])) fail("INVALID_INPUT", "a layout heading twice");
      fixed.add(r["key"]);
      out.push({ key: r["key"], title: null });
    } else {
      fail("INVALID_INPUT", "unknown layout heading");
    }
  }
  if (!fixed.has("DONE")) fail("INVALID_INPUT", "a layout without Done");
  if (titles.size > LAYOUT_CUSTOM_MAX) fail("INVALID_INPUT", "too many headings of your own");
  return out;
}

/** The numbers a layout starts ticked: every group, a boolean each, or INVALID_INPUT. */
export function parseLayoutMetrics(raw: unknown): UpdateMetricsInclude {
  if (!isRecord(raw)) fail("INVALID_INPUT", "layout numbers");
  const r = raw as Record<string, unknown>;
  const out: Record<string, boolean> = {};
  for (const group of UPDATE_METRIC_GROUPS) {
    if (typeof r[group] !== "boolean") fail("INVALID_INPUT", "layout numbers");
    out[group] = r[group] as boolean;
  }
  return out as UpdateMetricsInclude;
}

/**
 * A stored layout, read defensively: a value this build would not write
 * reads as the standard layout rather than a broken composer (the CHECKs
 * make it unreachable; a reader still does not trust a column it did not
 * write).
 */
export function readLayout(row: { readonly sections: unknown; readonly metricsIncluded: unknown }): UpdateLayout {
  try {
    return { sections: parseLayoutSections(row.sections), metrics: parseLayoutMetrics(row.metricsIncluded) };
  } catch {
    return STANDARD_LAYOUT;
  }
}

// ── The composer's frame ─────────────────────────────────────────────

/** One heading the composer shows, with a DOM-safe id (index-based for the workspace's own). */
export type FrameSlot = {
  readonly id: string;
  readonly key: UpdateSectionKey;
  /** A CUSTOM heading's title; null for the five fixed ones (the renderer titles them). */
  readonly title: string | null;
};

/**
 * The headings the composer lays a draft out under, and what each holds:
 * the layout's headings in its order, then any section the draft holds that
 * the layout does not — a fixed one it hides, or a heading of its own the
 * layout no longer has — in the draft's order, so a draft never loses text
 * when its project's layout changes. A section of the workspace's own is
 * matched by its title, whatever the case; each stored section fills one
 * heading at most, so two with the same title (which `normalizeUpdateBody`
 * now refuses) still keep both.
 */
export function layoutFrame(
  layout: UpdateLayout,
  body: UpdateBody,
): { readonly slots: readonly FrameSlot[]; readonly docs: Readonly<Record<string, unknown>> } {
  const slots: FrameSlot[] = [];
  let customs = 0;
  const nextCustomId = () => `custom-${customs++}`;
  for (const h of layout.sections) {
    slots.push(h.key === "CUSTOM" ? { id: nextCustomId(), key: "CUSTOM", title: h.title } : { id: h.key, key: h.key, title: null });
  }
  const docs: Record<string, unknown> = {};
  const filled = new Set<string>();
  for (const s of body.sections) {
    let slot: FrameSlot | undefined;
    if (s.key === "CUSTOM") {
      const folded = (s.title ?? "").toLocaleLowerCase();
      slot = slots.find((x) => x.key === "CUSTOM" && !filled.has(x.id) && (x.title ?? "").toLocaleLowerCase() === folded);
      if (!slot) {
        slot = { id: nextCustomId(), key: "CUSTOM", title: s.title ?? "" };
        slots.push(slot);
      }
    } else {
      slot = slots.find((x) => x.id === s.key);
      if (!slot) {
        slot = { id: s.key, key: s.key, title: null };
        slots.push(slot);
      }
    }
    filled.add(slot.id);
    docs[slot.id] = s.body;
  }
  return { slots, docs };
}

/** What the composer saves: the headings that say something, in the frame's order. */
export function bodyOfFrame(
  slots: readonly FrameSlot[],
  docs: Readonly<Record<string, unknown>>,
  include: UpdateMetricsInclude,
): UpdateBody {
  const sections: UpdateSection[] = [];
  for (const slot of slots) {
    const doc = docs[slot.id];
    if (doc == null) continue;
    sections.push(slot.key === "CUSTOM" ? { key: "CUSTOM", title: slot.title, body: doc } : { key: slot.key, title: null, body: doc });
  }
  return { sections, metrics: { include } };
}
