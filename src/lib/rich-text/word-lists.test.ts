import { describe, expect, it } from "vitest";

import { wordListKind, wordListOf, wordListTree, type WordItem } from "./word-lists";

/**
 * Word's lists, the pure half (slice 132, C109): the level and the list are
 * Word's own (`mso-list:lN levelM`), the kind comes from a list's first
 * marker. The DOM half — finding the paragraphs and moving their content —
 * is `paste-formatting.ts`'s, proven in a browser by
 * `e2e/paste-and-tables.spec.ts`.
 */

describe("wordListOf", () => {
  it("reads Word's list and level from a paragraph's style, and nothing else", () => {
    expect(wordListOf("margin-left:36.0pt;text-indent:-18.0pt;mso-list:l0 level2 lfo1")).toEqual({ list: "l0", level: 2 });
    expect(wordListOf("mso-list: L3  level1 lfo2")).toEqual({ list: "l3", level: 1 });
    expect(wordListOf("mso-list:Ignore")).toBeNull();
    expect(wordListOf("margin-left:36pt")).toBeNull();
  });
});

describe("wordListKind", () => {
  it("reads a first marker as bullets, numbers, letters or roman numerals", () => {
    expect(wordListKind("·")).toEqual({ ordered: false });
    expect(wordListKind("o")).toEqual({ ordered: false });
    expect(wordListKind("§")).toEqual({ ordered: false });
    expect(wordListKind("3.")).toEqual({ ordered: true, type: "1", start: 3 });
    expect(wordListKind("a.")).toEqual({ ordered: true, type: "a", start: 1 });
    expect(wordListKind("C)")).toEqual({ ordered: true, type: "A", start: 3 });
    expect(wordListKind("i.")).toEqual({ ordered: true, type: "i", start: 1 });
    expect(wordListKind("iv.")).toEqual({ ordered: true, type: "i", start: 4 });
    expect(wordListKind("IX.")).toEqual({ ordered: true, type: "I", start: 9 });
  });
});

describe("wordListTree", () => {
  const item = (level: number, marker: string, list = "l0"): WordItem => ({ level, list, marker });

  it("nests by Word's level — a lettered sub-list's c. is its third item, never a roman 100 a level deeper (the code review's MEDIUM-3)", () => {
    const tree = wordListTree([item(1, "1."), item(2, "a."), item(2, "b."), item(2, "c."), item(1, "2.")]);
    expect(tree).toHaveLength(1);
    const top = tree[0]!;
    expect(top.kind).toEqual({ ordered: true, type: "1", start: 1 });
    expect(top.items.map((i) => i.index)).toEqual([0, 4]);
    const sub = top.items[0]!.children[0]!;
    expect(sub.kind).toEqual({ ordered: true, type: "a", start: 1 });
    expect(sub.items.map((i) => i.index)).toEqual([1, 2, 3]);
  });

  it("a different Word list at the same level is a list of its own", () => {
    const tree = wordListTree([item(1, "·", "l0"), item(1, "·", "l0"), item(1, "1.", "l1")]);
    expect(tree.map((l) => l.kind.ordered)).toEqual([false, true]);
  });

  it("a run that starts deeper than it goes is two lists — nothing dropped", () => {
    const tree = wordListTree([item(2, "o"), item(1, "·")]);
    expect(tree).toHaveLength(2);
    expect(tree.flatMap((l) => l.items.map((i) => i.index))).toEqual([0, 1]);
  });

  it("a skipped level nests under the item above", () => {
    const tree = wordListTree([item(1, "·"), item(3, "§")]);
    expect(tree[0]!.items[0]!.children[0]!.items.map((i) => i.index)).toEqual([1]);
    const jumped = wordListTree([item(2, "o"), item(3, "§")]);
    expect(jumped[0]!.items[0]!.children[0]!.items[0]!.index).toBe(1);
  });
});
