import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createGroupBlur } from "@/components/work-view/use-create-visibility";

import {
  publishShownVisibility,
  readShownVisibility,
  shownFrom,
  subscribeShownVisibility,
} from "./shown-visibility";

/**
 * THE PANEL'S SHARED "WHAT THE RAIL SHOWS" (Phase 3 slice 73) — the fix the
 * design review reached from every lens: a subtask added right after its
 * parent is shared must be born with what the rail SHOWS, never with the
 * server prop that lags the share by the whole refresh. The browser specs
 * cannot pin it — the prop catches up inside any expect timeout — so the
 * read rule is pinned here, and so is the WIRING, by reading the three
 * islands' sources (the fix-round review: a store nobody publishes to, or
 * a reader reverted to its prop, would bring the bug back with the rule
 * still green).
 */
describe("shown-visibility: the rail's value, only while the reader's prop is the one it was published against", () => {
  it("a fresh share on the rail is what the add row reads, while its own prop still lags", () => {
    const id = "item-share";
    publishShownVisibility(id, { base: "INTERNAL", shown: "CLIENT_VISIBLE" });
    expect(readShownVisibility(id, "INTERNAL")).toBe("CLIENT_VISIBLE");
    publishShownVisibility(id, null);
  });

  it("a prop that MOVED — a colleague's change arriving by refresh — wins at once, lowering…", () => {
    const id = "item-colleague-lowers";
    publishShownVisibility(id, { base: "CLIENT_VISIBLE", shown: "CLIENT_VISIBLE" });
    // The colleague made it private: the prop moved, and nothing the rail
    // published against the old prop may raise the reader back.
    expect(readShownVisibility(id, "INTERNAL")).toBe("INTERNAL");
    publishShownVisibility(id, null);
  });

  it("…and raising: a private value published against the old prop never masks a colleague's share", () => {
    const id = "item-colleague-raises";
    publishShownVisibility(id, { base: "INTERNAL", shown: "INTERNAL" });
    expect(readShownVisibility(id, "CLIENT_VISIBLE")).toBe("CLIENT_VISIBLE");
    publishShownVisibility(id, null);
  });

  it("no rail on screen (never published, or unmounted) means the prop", () => {
    expect(readShownVisibility("item-never", "INTERNAL")).toBe("INTERNAL");
    const id = "item-gone";
    publishShownVisibility(id, { base: "INTERNAL", shown: "CLIENT_VISIBLE" });
    publishShownVisibility(id, null);
    expect(readShownVisibility(id, "INTERNAL")).toBe("INTERNAL");
    expect(shownFrom(undefined, "CLIENT_VISIBLE")).toBe("CLIENT_VISIBLE");
  });

  it("an identical publish notifies nobody — the snapshot stays the same object between real changes", () => {
    const id = "item-quiet";
    let calls = 0;
    const off = subscribeShownVisibility(() => {
      calls += 1;
    });
    publishShownVisibility(id, { base: "INTERNAL", shown: "INTERNAL" });
    publishShownVisibility(id, { base: "INTERNAL", shown: "INTERNAL" });
    expect(calls).toBe(1);
    publishShownVisibility(id, { base: "INTERNAL", shown: "CLIENT_VISIBLE" });
    expect(calls).toBe(2);
    publishShownVisibility(id, null);
    publishShownVisibility(id, null);
    expect(calls).toBe(3);
    off();
  });

  it("THE WIRING: the rail publishes what it shows, and the add row and ⌘⇧O read it — never their own prop", () => {
    const dir = join(process.cwd(), "src/app/(tenant)/(authed)/projects/[key]/item-panel");
    const source = (file: string) => readFileSync(join(dir, file), "utf8");
    const rail = source("visibility-field.tsx");
    expect(rail).toContain("publishShownVisibility(itemId, { base: visibility, shown: shown.value })");
    expect(rail).toContain("publishShownVisibility(itemId, null)");
    const addRow = source("subtask-add.tsx");
    expect(addRow).toContain("useShownVisibility(parentId, parentVisibility)");
    expect(addRow).toContain("childCreateVisibility({ parentShown, lowered })");
    const description = source("description-field.tsx");
    expect(description).toContain("useShownVisibility(itemId, visibility)");
    expect(description).toContain("visibility: shownVisibility,");
  });
});

describe("a create field's group blur (slice 73's composers)", () => {
  const base = { relatedInside: false, relatedNull: false, windowFocused: true, fromSelect: false, pointerOutside: false };

  it("stays open when focus moves inside the group or the window loses focus", () => {
    expect(createGroupBlur({ ...base, relatedInside: true })).toBe("stay");
    expect(createGroupBlur({ ...base, relatedNull: true, windowFocused: false })).toBe("stay");
  });

  it("stays open when its own SELECT blurs to nowhere with no press outside — iOS closing the picker must not drop the pick", () => {
    expect(createGroupBlur({ ...base, relatedNull: true, fromSelect: true })).toBe("stay");
  });

  it("…but a press OUTSIDE after a pick is a member leaving — a desktop click on the page's background", () => {
    expect(createGroupBlur({ ...base, relatedNull: true, fromSelect: true, pointerOutside: true })).toBe("defer");
  });

  it("leaves for a real target outside, and defers when the browser did not say where focus went", () => {
    expect(createGroupBlur(base)).toBe("leave");
    expect(createGroupBlur({ ...base, fromSelect: true })).toBe("leave");
    expect(createGroupBlur({ ...base, relatedNull: true })).toBe("defer");
  });
});
