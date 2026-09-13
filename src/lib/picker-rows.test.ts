import { describe, expect, it, vi } from "vitest";

import {
  NO_HIGHLIGHT,
  assertPickerValue,
  derivedRowValue,
  highlightAfterChange,
  highlightBasis,
  highlightBasisChanged,
  initialHighlight,
  pickerRows,
  reseedHighlight,
} from "./picker-rows";

type Row = { value: string; label: string; keywords?: string; group?: string; disabled?: boolean };

const row = (value: string, over: Partial<Row> = {}): Row => ({ value, label: value, ...over });

describe("pickerRows", () => {
  it("never calls derive for a blank or whitespace-only query", () => {
    const derive = vi.fn((q: string) => row(q));
    pickerRows([row("a")], "", derive);
    pickerRows([row("a")], "   ", derive);
    expect(derive).not.toHaveBeenCalled();
  });

  it("returns the derived row separately and never inside a group", () => {
    const r = pickerRows([row("none", { label: "No estimate" })], "90m", () => row("90", { label: "Set to 1h 30m" }));
    expect(r.derived?.value).toBe("90");
    expect(r.groups.flatMap((g) => g.options).map((o) => o.value)).not.toContain("90");
  });

  it("drops a fixed option that carries the derived row's value", () => {
    // One row per value: the typed one is the row the member aimed at.
    const options = [row("90", { label: "90 90m" }), row("clear", { label: "clear 90m" })];
    const r = pickerRows(options, "90m", () => row("90", { label: "Set" }));
    expect(r.groups.flatMap((g) => g.options).map((o) => o.value)).toEqual(["clear"]);
  });

  it("treats a disabled derived row as none", () => {
    // cmdk's first-row selection skips a disabled item, so Enter would
    // commit the NEXT row instead.
    const r = pickerRows([row("a")], "x", () => row("x", { disabled: true }));
    expect(r.derived).toBeNull();
  });

  it("still filters the fixed rows while a derived row exists", () => {
    const options = [row("today", { label: "Today" }), row("tomorrow", { label: "Tomorrow" })];
    const r = pickerRows(options, "tom", () => row("2026-09-15"));
    expect(r.derived?.value).toBe("2026-09-15");
    expect(r.groups.flatMap((g) => g.options).map((o) => o.value)).toEqual(["tomorrow"]);
  });

  it("matches on keywords as well as the label", () => {
    const r = pickerRows([row("u", { label: "Urgent", keywords: "p1" })], "p1");
    expect(r.groups.flatMap((g) => g.options).map((o) => o.value)).toEqual(["u"]);
  });

  it("is empty only when there is no derived row AND no fixed match", () => {
    const options = [row("a", { label: "Alpha" })];
    expect(pickerRows(options, "zzz").empty).toBe(true);
    expect(pickerRows(options, "zzz", () => row("zzz")).empty).toBe(false);
    expect(pickerRows(options, "alp").empty).toBe(false);
    expect(pickerRows([], "").empty).toBe(true);
    // A derive that refuses the text leaves the empty state to speak.
    expect(pickerRows(options, "zzz", () => null).empty).toBe(true);
  });

  it("groups in FIRST-SEEN order and keeps array order within a group", () => {
    const options = [
      row("b1", { group: "Backlog" }),
      row("p1", { group: "In progress" }),
      row("p2", { group: "In progress" }),
      row("d1", { group: "Done" }),
    ];
    expect(pickerRows(options, "").groups).toEqual([
      { heading: "Backlog", options: [options[0]] },
      { heading: "In progress", options: [options[1], options[2]] },
      { heading: "Done", options: [options[3]] },
    ]);
  });

  it("ungrouped rows land in one heading-less group", () => {
    const r = pickerRows([row("a"), row("b")], "");
    expect(r.groups).toEqual([{ heading: undefined, options: [row("a"), row("b")] }]);
  });

  it("refuses a fixed or derived value that could collide with a reserved one", () => {
    expect(() => pickerRows([row("in progress")], "")).toThrow();
    expect(() => pickerRows([row("")], "")).toThrow();
    expect(() => pickerRows([row(NO_HIGHLIGHT)], "")).toThrow();
    expect(() => pickerRows([row("a")], "x", () => row(derivedRowValue("x")))).toThrow();
    // Checked before the disabled test: a disabled derived row is still a value the caller built.
    expect(() => pickerRows([row("a")], "x", () => row("x y", { disabled: true }))).toThrow();
  });
});

describe("the reserved cmdk values", () => {
  const legal = ["none", "clear", "90", "2031-03-14", "nextWeek", "HIGH", "cm1a2b3c4d5e6f"];

  it("can never be a legal option value", () => {
    expect(() => assertPickerValue(NO_HIGHLIGHT)).toThrow();
    for (const v of legal) {
      expect(() => assertPickerValue(v)).not.toThrow();
      expect(() => assertPickerValue(derivedRowValue(v))).toThrow();
    }
  });

  it("survive cmdk's trim, and a derived value never equals what it wraps, another derived value, or NO_HIGHLIGHT", () => {
    expect(NO_HIGHLIGHT.trim()).toBe(NO_HIGHLIGHT);
    const derived = legal.map(derivedRowValue);
    for (const [i, v] of legal.entries()) {
      expect(derived[i]!.trim()).toBe(derived[i]);
      expect(derived[i]).not.toBe(v);
      expect(derived[i]).not.toBe(NO_HIGHLIGHT);
    }
    expect(new Set(derived).size).toBe(legal.length);
  });
});

describe("initialHighlight — the seed on open", () => {
  it('is "" when the current row is the first enabled row — cmdk lights it itself (unannounced until the member steers)', () => {
    expect(initialHighlight([{ value: "none" }, { value: "today" }], "none")).toBe("");
    // First ENABLED, not first in the array.
    expect(initialHighlight([{ value: "x", disabled: true }, { value: "a" }, { value: "b" }], "a")).toBe("");
  });

  it("is NO_HIGHLIGHT when the current row is disabled — a bare Enter must not commit the first enabled row", () => {
    // S on TRIAGE (ranked last), and a gated Done under a non-approver.
    expect(initialHighlight([{ value: "todo" }, { value: "triage", disabled: true }], "triage")).toBe(NO_HIGHLIGHT);
    expect(initialHighlight([{ value: "done", disabled: true }, { value: "todo" }], "done")).toBe(NO_HIGHLIGHT);
  });

  it("is NO_HIGHLIGHT when the current value is absent or null", () => {
    expect(initialHighlight([{ value: "a" }, { value: "b" }], "zzz")).toBe(NO_HIGHLIGHT);
    expect(initialHighlight([{ value: "a" }, { value: "b" }], null)).toBe(NO_HIGHLIGHT);
    expect(initialHighlight([], "a")).toBe(NO_HIGHLIGHT);
  });

  it("is the current value when it is enabled but not first", () => {
    expect(initialHighlight([{ value: "NONE" }, { value: "LOW" }, { value: "HIGH" }], "HIGH")).toBe("HIGH");
  });

  it("never names a row other than the current one, and never a disabled row", () => {
    const options = [{ value: "a", disabled: true }, { value: "b" }, { value: "c" }, { value: "d", disabled: true }];
    for (const v of ["a", "b", "c", "d", "zzz", null]) {
      const seed = initialHighlight(options, v);
      // "" is the one seed that lets cmdk pick — and only when its pick IS the current row.
      if (seed === "") expect(options.find((o) => !o.disabled)?.value).toBe(v);
      else expect([v, NO_HIGHLIGHT]).toContain(seed);
      expect(options.find((o) => o.value === seed)?.disabled ?? false).toBe(false);
    }
  });
});

describe("reseedHighlight — the fallback when a change takes the highlight away", () => {
  it("is the new current value when its row is enabled — even when it is the first row", () => {
    expect(reseedHighlight([{ value: "120" }, { value: "clear" }], "120")).toBe("120");
    expect(reseedHighlight([{ value: "NONE" }, { value: "LOW" }, { value: "HIGH" }], "LOW")).toBe("LOW");
  });

  it("is NO_HIGHLIGHT when the new current row is disabled or absent — never another row, never \"\"", () => {
    expect(reseedHighlight([{ value: "todo" }, { value: "done", disabled: true }], "done")).toBe(NO_HIGHLIGHT);
    expect(reseedHighlight([{ value: "a" }], "zzz")).toBe(NO_HIGHLIGHT);
    expect(reseedHighlight([{ value: "a" }], null)).toBe(NO_HIGHLIGHT);
    expect(reseedHighlight([], "a")).toBe(NO_HIGHLIGHT);
  });
});

// S's shape: grouped by category, in rank order, a gated Done disabled.
const STATES = [
  row("backlog", { label: "Backlog", group: "Backlog" }),
  row("progress", { label: "In progress", group: "In progress" }),
  row("review", { label: "In review", group: "In progress" }),
  row("done", { label: "Done", group: "Done", disabled: true }),
];

// E's shape: the current row first, `clear` last and only when a value is set.
const estimate = (minutes: number | null): Row[] =>
  minutes === null
    ? [row("none", { label: "No estimate" })]
    : [row(`${minutes}`, { label: `${minutes}` }), row("clear", { label: "Remove estimate" })];

// E's derive: a typed zero is the unset row when unset and the clear row otherwise; digits are minutes.
const estimateDerive =
  (minutes: number | null) =>
  (q: string): Row | null =>
    q === "0" ? row(minutes === null ? "none" : "clear") : /^\d+$/.test(q) ? row(q) : null;

/** One settle, exactly as `PickerBody` runs it: `prev` → `next` under an unchanged query. */
function settle(
  prev: { options: Row[]; value: string | null },
  next: { options: Row[]; value: string | null },
  lit: { highlight: string; steered: boolean },
  query = "",
  derive?: (q: string) => Row | null,
) {
  return highlightAfterChange(
    highlightBasis(prev.options, prev.value),
    { options: next.options, value: next.value, rows: pickerRows(next.options, query, derive) },
    lit,
  );
}

const withRow = (value: string, over: Partial<Row>) => STATES.map((o) => (o.value === value ? { ...o, ...over } : o));

describe("highlightBasisChanged — what makes an open picker settle its highlight again", () => {
  it("is false for a fresh array of the same rows: identity, icons, meta and test ids are not the basis", () => {
    const basis = highlightBasis(STATES, "progress");
    const rebuilt = STATES.map((o) => ({ ...o, icon: "◌", meta: "✓", testId: `item-state-${o.value}` }));
    expect(highlightBasisChanged(basis, rebuilt, "progress")).toBe(false);
    // An absent flag and `disabled: false` are the same row; so are absent and empty keywords.
    const normalised = STATES.map((o) => ({ ...o, disabled: o.disabled ?? false, keywords: "" }));
    expect(highlightBasisChanged(basis, normalised, "progress")).toBe(false);
  });

  it.each([
    ["the value", STATES, "review"],
    ["a row leaving (a state hidden)", STATES.filter((o) => o.value !== "review"), "progress"],
    ["a row arriving", [...STATES, row("cancelled", { group: "Cancelled" })], "progress"],
    ["a disabled flag (work_item:approve lost)", withRow("review", { disabled: true }), "progress"],
    ["a group (a state recategorised)", withRow("review", { group: "Done" }), "progress"],
    ["a label (a state renamed)", withRow("review", { label: "QA" }), "progress"],
    ["keywords", withRow("review", { keywords: "qa" }), "progress"],
    ["the order (a rank change)", [STATES[1]!, STATES[0]!, STATES[2]!, STATES[3]!], "progress"],
  ])("is true for a change in %s", (_what, options, value) => {
    expect(highlightBasisChanged(highlightBasis(STATES, "progress"), options, value)).toBe(true);
  });
});

describe("highlightAfterChange — does the member's highlight survive a change underneath?", () => {
  const reseeded = (highlight: string) => ({ highlight, steered: false });

  describe("an UN-STEERED highlight always re-seeds on a value change (a bare Enter never writes over a colleague)", () => {
    it.each([
      ["the old value's row", "progress"],
      ["a row cmdk lit by itself", "backlog"],
      ['the "" seed', ""],
      ["NO_HIGHLIGHT", NO_HIGHLIGHT],
    ])("%s → the new current value", (_what, highlight) => {
      const lit = { highlight, steered: false };
      expect(settle({ options: STATES, value: "progress" }, { options: STATES, value: "review" }, lit)).toEqual(
        reseeded("review"),
      );
    });

    it("→ NO_HIGHLIGHT when the new current row is disabled (a gated Done under a non-approver)", () => {
      const lit = { highlight: "progress", steered: false };
      expect(settle({ options: STATES, value: "progress" }, { options: STATES, value: "done" }, lit)).toEqual(
        reseeded(NO_HIGHLIGHT),
      );
    });
  });

  describe("a STEERED highlight on a row that is still the member's SURVIVES", () => {
    it("S: steered to another state, a colleague moves the item — Enter still commits the state steered to", () => {
      const lit = { highlight: "review", steered: true };
      expect(settle({ options: STATES, value: "progress" }, { options: STATES, value: "backlog" }, lit)).toBe(lit);
    });

    it("S: typed `rev` (typing is steering), a colleague moves the item — Enter still commits In review", () => {
      const lit = { highlight: "review", steered: true };
      expect(settle({ options: STATES, value: "progress" }, { options: STATES, value: "backlog" }, lit, "rev")).toBe(lit);
    });

    it("D: steered to a token, a colleague sets a date — the token is not the old value's row", () => {
      const before = [row("2031-03-14"), row("today"), row("tomorrow"), row("clear")];
      const after = [row("2031-04-01"), row("today"), row("tomorrow"), row("clear")];
      const lit = { highlight: "tomorrow", steered: true };
      expect(settle({ options: before, value: "2031-03-14" }, { options: after, value: "2031-04-01" }, lit)).toBe(lit);
    });

    it("E: steered to Remove estimate, a colleague sets a new one — removing was the member's pick", () => {
      const lit = { highlight: "clear", steered: true };
      expect(settle({ options: estimate(120), value: "120" }, { options: estimate(90), value: "90" }, lit)).toBe(lit);
    });

    it("E: the typed derived row, a colleague sets a new estimate — Enter still commits what was typed", () => {
      const lit = { highlight: derivedRowValue("180"), steered: true };
      expect(
        settle({ options: estimate(120), value: "120" }, { options: estimate(90), value: "90" }, lit, "180", estimateDerive(90)),
      ).toBe(lit);
    });

    it("S: an options change elsewhere in the list (another state hidden) leaves it alone", () => {
      const lit = { highlight: "review", steered: true };
      const hidden = STATES.filter((o) => o.value !== "backlog");
      expect(settle({ options: STATES, value: "progress" }, { options: hidden, value: "progress" }, lit)).toBe(lit);
    });
  });

  describe("a STEERED highlight whose row is no longer the member's RE-SEEDS and un-steers", () => {
    it("steered to the OLD value's row — it was lit because it WAS the value", () => {
      expect(
        settle(
          { options: STATES, value: "progress" },
          { options: STATES, value: "review" },
          { highlight: "progress", steered: true },
        ),
      ).toEqual(reseeded("review"));
      expect(
        settle({ options: estimate(120), value: "120" }, { options: estimate(90), value: "90" }, { highlight: "120", steered: true }),
      ).toEqual(reseeded("90"));
    });

    it("the steered row DISAPPEARS on an options change (a state hidden) — cmdk would light Backlog by itself", () => {
      const hidden = STATES.filter((o) => o.value !== "review");
      expect(
        settle({ options: STATES, value: "progress" }, { options: hidden, value: "progress" }, { highlight: "review", steered: true }),
      ).toEqual(reseeded("progress"));
    });

    it("the steered row becomes DISABLED (work_item:approve lost while a gated row is lit)", () => {
      const lit = { highlight: "review", steered: true };
      expect(
        settle({ options: STATES, value: "progress" }, { options: withRow("review", { disabled: true }), value: "progress" }, lit),
      ).toEqual(reseeded("progress"));
      // …and when the current row went disabled with it, nothing is lit at all.
      const bothGated = STATES.map((o) => (o.value === "review" || o.value === "progress" ? { ...o, disabled: true } : o));
      expect(settle({ options: STATES, value: "progress" }, { options: bothGated, value: "progress" }, lit)).toEqual(
        reseeded(NO_HIGHLIGHT),
      );
    });

    it("the steered row MOVES GROUP (recategorised) — it remounts under another heading and cmdk re-picks", () => {
      expect(
        settle(
          { options: STATES, value: "progress" },
          { options: withRow("review", { group: "Done" }), value: "progress" },
          { highlight: "review", steered: true },
        ),
      ).toEqual(reseeded("progress"));
    });

    it("the steered row falls out of the typed query on a RENAME — it unmounts although it still exists", () => {
      expect(
        settle(
          { options: STATES, value: "progress" },
          { options: withRow("review", { label: "QA" }), value: "progress" },
          { highlight: "review", steered: true },
          "rev",
        ),
      ).toEqual(reseeded("progress"));
    });

    it("the typed derived row changes under the query (E: `0` meant Remove, a colleague cleared it, now it means No estimate)", () => {
      const lit = { highlight: derivedRowValue("clear"), steered: true };
      expect(
        settle({ options: estimate(120), value: "120" }, { options: estimate(null), value: "none" }, lit, "0", estimateDerive(null)),
      ).toEqual(reseeded("none"));
    });

    it('the steered highlight names no row — "" after a query matched nothing, or NO_HIGHLIGHT after steering into nothing', () => {
      for (const highlight of ["", NO_HIGHLIGHT]) {
        expect(
          settle({ options: STATES, value: "progress" }, { options: STATES, value: "review" }, { highlight, steered: true }, "zzz"),
        ).toEqual(reseeded("review"));
      }
    });
  });

  it("never leaves `steered` on anything but the unchanged highlight of an enabled, rendered row that is not the old value's", () => {
    const variants: Row[][] = [
      STATES,
      STATES.filter((o) => o.value !== "review"),
      withRow("review", { disabled: true }),
      withRow("backlog", { group: "In progress" }),
      withRow("progress", { label: "Doing" }),
    ];
    const values = ["backlog", "progress", "review", "done", null];
    const highlights = ["", NO_HIGHLIGHT, ...STATES.map((o) => o.value)];
    for (const next of variants)
      for (const pv of values)
        for (const nv of values)
          for (const highlight of highlights)
            for (const steered of [true, false])
              for (const query of ["", "in"]) {
                const out = settle({ options: STATES, value: pv }, { options: next, value: nv }, { highlight, steered }, query);
                if (!out.steered) {
                  expect(out.highlight).toBe(reseedHighlight(next, nv));
                  continue;
                }
                expect(out).toEqual({ highlight, steered: true });
                expect(out.highlight).not.toBe(pv);
                const target = pickerRows(next, query)
                  .groups.flatMap((g) => g.options)
                  .find((o) => o.value === out.highlight);
                expect(target).toBeDefined();
                expect(target?.disabled ?? false).toBe(false);
                expect(target?.group).toBe(STATES.find((o) => o.value === out.highlight)?.group);
              }
  });
});
