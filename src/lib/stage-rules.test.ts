import { describe, expect, it } from "vitest";

import {
  BUILT_IN_STAGES,
  MAX_STAGES,
  MAX_STAGE_REMOVE_TASKS,
  TRIAGE_STAGE,
  binHeir,
  canAddStage,
  canStartHere,
  checkStageName,
  defaultHeir,
  defaultRefusal,
  insertIndex,
  moveIndex,
  removalRefusal,
  removalTargets,
  setIsValid,
  type StageLike,
} from "./stage-rules";

/** The built-in set as a project's states, TRIAGE last — ids are the seed keys. */
const project = (): StageLike[] => [
  ...BUILT_IN_STAGES.map((s) => ({
    id: s.seedKey,
    name: null,
    seedKey: s.seedKey,
    category: s.category,
    isDefault: s.isDefault,
    requiresApproval: s.requiresApproval,
  })),
  { id: "TRIAGE", name: null, seedKey: "TRIAGE", category: TRIAGE_STAGE.category, isDefault: false, requiresApproval: false },
];
const ids = (list: readonly StageLike[]) => list.map((s) => s.id);
const named = (id: string, category: StageLike["category"], name = id): StageLike => ({
  id,
  name,
  seedKey: null,
  category,
  isDefault: false,
  requiresApproval: false,
});

describe("stage names", () => {
  it("collapses whitespace, trims, refuses blank, long and control characters", () => {
    expect(checkStageName("  In \n  design\t", [], null)).toEqual({ ok: true, name: "In design" });
    expect(checkStageName("   ", [], null)).toEqual({ ok: false, code: "NAME_REQUIRED" });
    expect(checkStageName("x".repeat(41), [], null)).toEqual({ ok: false, code: "INVALID_INPUT" });
    expect(checkStageName("x".repeat(40), [], null).ok).toBe(true);
    expect(checkStageName(`a${String.fromCharCode(7)}b`, [], null)).toEqual({ ok: false, code: "INVALID_INPUT" });
    // NEL is a C1 control and NOT in JavaScript's `\s`: refused, never kept.
    expect(checkStageName(`a${String.fromCharCode(0x85)}b`, [], null)).toEqual({ ok: false, code: "INVALID_INPUT" });
    // Invisible formatting — a bidi override or isolate, a zero-width space,
    // a direction mark — is refused too: a name must look like what it is.
    // (A BOM never gets that far: it is in JavaScript's `\s`, so it is
    // folded to an ordinary space with the rest of the whitespace.)
    for (const c of [0x202e, 0x2066, 0x200b, 0x200f]) {
      expect(checkStageName(`a${String.fromCharCode(c)}b`, [], null)).toEqual({ ok: false, code: "INVALID_INPUT" });
    }
  });

  it("counts code points, so an emoji is one character, not two", () => {
    expect(checkStageName("🚀".repeat(40), [], null).ok).toBe(true);
  });

  it("is unique among the OTHER stages' stored names, ignoring case — a seeded twin is not refused", () => {
    const list = [named("a", "TODO", "Design"), ...project()];
    expect(checkStageName("design", list, null)).toEqual({ ok: false, code: "STAGE_NAME_TAKEN" });
    expect(checkStageName("DESIGN", list, "a")).toEqual({ ok: true, name: "DESIGN" }); // its own name, recased
    expect(checkStageName("To do", list, null).ok).toBe(true); // TODO's translation is not a stored name
  });
});

describe("placement", () => {
  it("puts a new stage at the end of its kind, and a kind with none before the next kind", () => {
    const list = project();
    expect(insertIndex(list, "IN_PROGRESS")).toBe(4); // after In review
    expect(insertIndex(list, "CANCELLED")).toBe(6); // before Triage
    const noBacklog = list.filter((s) => s.id !== "BACKLOG");
    expect(insertIndex(noBacklog, "BACKLOG")).toBe(0);
    const noCancelled = list.filter((s) => s.id !== "CANCELLED");
    expect(insertIndex(noCancelled, "CANCELLED")).toBe(5); // still before Triage
  });

  it("moves only within a kind", () => {
    const list = project();
    expect(moveIndex(list, "IN_REVIEW", "up")).toBe(2); // before In progress
    expect(moveIndex(list, "IN_PROGRESS", "down")).toBe(3); // after In review, in the list without it
    expect(moveIndex(list, "IN_PROGRESS", "up")).toBeNull(); // first of its kind
    expect(moveIndex(list, "TODO", "up")).toBeNull(); // the only To do
    expect(moveIndex(list, "TRIAGE", "up")).toBeNull();
  });
});

describe("removal", () => {
  it("keeps one stage of every kind but Backlog", () => {
    const list = project();
    for (const id of ["TODO", "DONE", "CANCELLED"]) expect(removalRefusal(list, id, 0)).toBe("STAGE_LAST_OF_KIND");
    expect(removalRefusal(list, "IN_REVIEW", 5)).toBeNull();
    expect(removalRefusal(list, "BACKLOG", 0)).toBeNull();
    expect(removalRefusal(list, "BACKLOG", 1)).toBe("STAGE_NOT_EMPTY");
    expect(removalRefusal(list, "TRIAGE", 0)).toBe("INVALID_INPUT");
  });

  it("refuses the last Backlog stage while new tasks start there", () => {
    const list = project().map((s) => ({ ...s, isDefault: s.id === "BACKLOG" }));
    expect(removalRefusal(list, "BACKLOG", 0)).toBe("STAGE_IS_DEFAULT");
  });

  it("lets the last Backlog stage go with only deleted tasks in it — they go where new tasks start (C104)", () => {
    expect(removalRefusal(project(), "BACKLOG", 2, 2)).toBeNull();
    expect(binHeir(project(), "BACKLOG")?.id).toBe("TODO");
    // A live task still holds it in place.
    expect(removalRefusal(project(), "BACKLOG", 3, 2)).toBe("STAGE_NOT_EMPTY");
    // The mark on it is answered first: choose another start stage, not "nowhere to go".
    const marked = project().map((s) => ({ ...s, isDefault: s.id === "BACKLOG" }));
    expect(removalRefusal(marked, "BACKLOG", 2, 2)).toBe("STAGE_IS_DEFAULT");
    expect(binHeir(marked, "BACKLOG")).toBeNull();
    // The start stage is never a gated one (a belt: the database holds the pair).
    const gatedStart = project().map((s) => (s.id === "TODO" ? { ...s, requiresApproval: true } : s));
    expect(binHeir(gatedStart, "BACKLOG")).toBeNull();
    expect(removalRefusal(gatedStart, "BACKLOG", 2, 2)).toBe("INVALID_INPUT");
    expect(removalRefusal(gatedStart, "BACKLOG", 0)).toBeNull(); // nothing to move, nothing to refuse
  });

  it("passes the start-here mark only to a stage of its kind that is not gated", () => {
    const list = [...project(), { ...named("gated", "TODO"), requiresApproval: true }, named("open", "TODO")];
    expect(defaultHeir(list, "TODO", "gated")?.id).toBe("open"); // the pick is gated: skipped
    expect(defaultHeir(list, "TODO", "open")?.id).toBe("open");
    const onlyGated = [...project(), { ...named("gated", "TODO"), requiresApproval: true }];
    expect(defaultHeir(onlyGated, "TODO", null)).toBeNull();
    expect(removalRefusal(onlyGated, "TODO", 0)).toBe("STAGE_IS_DEFAULT");
  });

  it("refuses a removal past the move's bound", () => {
    expect(removalRefusal(project(), "IN_REVIEW", MAX_STAGE_REMOVE_TASKS + 1)).toBe("STAGE_TOO_FULL");
  });

  it("offers only the other stages of the same kind", () => {
    expect(ids(removalTargets(project(), "IN_REVIEW"))).toEqual(["IN_PROGRESS"]);
    expect(removalTargets(project(), "TODO")).toEqual([]);
  });
});

describe("where new tasks start", () => {
  it("is a Backlog or To do stage that does not need approval", () => {
    expect(canStartHere({ category: "TODO", requiresApproval: false })).toBe(true);
    expect(defaultRefusal({ category: "TODO", requiresApproval: true })).toBe("STAGE_DEFAULT_GATED");
    expect(defaultRefusal({ category: "DONE", requiresApproval: false })).toBe("STAGE_DEFAULT_KIND");
    expect(defaultRefusal({ category: "BACKLOG", requiresApproval: false })).toBeNull();
  });
});

describe("a whole set", () => {
  const editable = () => project().filter((s) => s.category !== "TRIAGE");

  it("accepts the built-in set and refuses each broken rule", () => {
    expect(setIsValid(editable())).toBe(true);
    // kinds out of order
    const swapped = editable();
    [swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];
    expect(setIsValid(swapped)).toBe(false);
    // a kind missing
    expect(setIsValid(editable().filter((s) => s.category !== "DONE"))).toBe(false);
    // no default, two defaults, a default of the wrong kind
    expect(setIsValid(editable().map((s) => ({ ...s, isDefault: false })))).toBe(false);
    expect(setIsValid(editable().map((s) => ({ ...s, isDefault: s.id === "TODO" || s.id === "BACKLOG" })))).toBe(false);
    expect(setIsValid(editable().map((s) => ({ ...s, isDefault: s.id === "DONE" })))).toBe(false);
    // a gated default
    expect(setIsValid(editable().map((s) => (s.id === "TODO" ? { ...s, requiresApproval: true } : s)))).toBe(false);
    // a seed key in the wrong kind, or twice
    expect(setIsValid(editable().map((s) => (s.id === "IN_REVIEW" ? { ...s, seedKey: "TODO" as const } : s)))).toBe(false);
    // two names alike, a blank one, one unnormalised
    const withNames = editable().map((s, i) => (i < 2 ? { ...s, name: "Same", seedKey: null } : s));
    expect(setIsValid(withNames)).toBe(false);
    expect(setIsValid(editable().map((s) => (s.id === "IN_REVIEW" ? { ...s, name: " " } : s)))).toBe(false);
    expect(setIsValid(editable().map((s) => (s.id === "IN_REVIEW" ? { ...s, name: " Review" } : s)))).toBe(false);
  });

  it("caps the set at MAX_STAGES", () => {
    const extra = Array.from({ length: MAX_STAGES - editable().length }, (_, i) => named(`x${i}`, "CANCELLED"));
    const full = [...editable(), ...extra];
    expect(setIsValid(full)).toBe(true);
    expect(canAddStage(full)).toBe(false);
    expect(setIsValid([...full, named("one-more", "CANCELLED")])).toBe(false);
  });
});
