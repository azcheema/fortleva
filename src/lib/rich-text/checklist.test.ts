import { getSchema } from "@tiptap/core";
import { Fragment, Node as PMNode } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";

import { checklistTargetAt, nodePosition } from "./checklist";
import { descriptionExtensions } from "./extensions";

/**
 * `⌘⇧O`'s rule, against the SCHEMA THE EDITOR EDITS WITH — not a mock of
 * it. `descriptionExtensions()` is the same list the browser builds its
 * editor from and the same one the server validates against, so a
 * document that parses here is one a member can really produce.
 */

const schema = getSchema(descriptionExtensions());
const doc = (...content: unknown[]) => PMNode.fromJSON(schema, { type: "doc", content } as never);
const para = (...content: unknown[]) => ({ type: "paragraph", content });
const text = (value: string) => ({ type: "text", text: value });
const item = (...content: unknown[]) => ({ type: "taskItem", attrs: { checked: false }, content });
const ticked = (...content: unknown[]) => ({ type: "taskItem", attrs: { checked: true }, content });
const list = (...content: unknown[]) => ({ type: "taskList", content });

const MAX = 400;

/** A caret in the middle of the first text node reading `value`. */
const caretIn = (node: PMNode, value: string): number => {
  let at = -1;
  node.descendants((child, pos) => {
    if (at < 0 && child.isText && child.text === value) at = pos + 1;
    return at < 0;
  });
  expect(at).toBeGreaterThan(-1);
  return at;
};

/** The answer for an empty selection inside the line reading `value`. */
const targetIn = (d: PMNode, value: string) => {
  const pos = caretIn(d, value);
  return checklistTargetAt(d, pos, pos, MAX);
};

describe("checklistTargetAt", () => {
  it("takes the caret's checklist item and its text as the title", () => {
    const d = doc(para(text("Intro")), list(item(para(text("  buy sealant  "))), item(para(text("bleed it")))));
    const target = targetIn(d, "  buy sealant  ");
    expect(target).toMatchObject({ kind: "ok", title: "buy sealant" });
    // `from` is the item's own start, so `from + nodeSize` is exactly the
    // range a delete must cover.
    if (target.kind !== "ok") throw new Error("unreachable");
    expect(d.nodeAt(target.from)).toBe(target.node);
    expect(target.node.type.name).toBe("taskItem");
  });

  it("is none outside a checklist — a paragraph, a bullet list, an empty document", () => {
    const plain = doc(para(text("just words")));
    expect(targetIn(plain, "just words")).toEqual({ kind: "none" });

    const bullets = doc({ type: "bulletList", content: [{ type: "listItem", content: [para(text("a bullet"))] }] });
    expect(targetIn(bullets, "a bullet")).toEqual({ kind: "none" });

    expect(checklistTargetAt(doc(para()), 0, 0, MAX)).toEqual({ kind: "none" });
  });

  it("is none for a selection that runs out of the line it starts in — two lines name no one line", () => {
    const d = doc(list(item(para(text("first line"))), item(para(text("second line")))));
    const from = caretIn(d, "first line");
    // …through the middle of the next item.
    expect(checklistTargetAt(d, from, caretIn(d, "second line"), MAX)).toEqual({ kind: "none" });
    // A selection INSIDE one line still converts the whole line: the line
    // is the unit, because a task title is the line.
    expect(checklistTargetAt(d, from, from + 3, MAX)).toMatchObject({ kind: "ok", title: "first line" });
  });

  it("is none for a position no document has, rather than a throw", () => {
    const d = doc(para(text("x")));
    const past = d.content.size + 1;
    expect(checklistTargetAt(d, past, past, MAX)).toEqual({ kind: "none" });
    expect(checklistTargetAt(d, -1, -1, MAX)).toEqual({ kind: "none" });
    expect(checklistTargetAt(d, 1.5, 1.5, MAX)).toEqual({ kind: "none" });
    expect(checklistTargetAt(d, 2, 1, MAX)).toEqual({ kind: "none" });
  });

  it("refuses an item that is more than one line, whichever way it is more", () => {
    // A nested checklist under it: converting would delete the children.
    const nested = doc(list(item(para(text("outer")), list(item(para(text("inner")))))));
    expect(targetIn(nested, "outer")).toEqual({ kind: "complex" });

    // A second paragraph: converting would drop it.
    const twoParas = doc(list(item(para(text("first")), para(text("second")))));
    expect(targetIn(twoParas, "first")).toEqual({ kind: "complex" });

    // A line break: `textContent` would silently join the two halves.
    const broken = doc(list(item(para(text("left"), { type: "hardBreak" }, text("right")))));
    expect(targetIn(broken, "left")).toEqual({ kind: "complex" });
  });

  it("refuses a TICKED item: a new task starts open, so converting one would delete the fact it was done", () => {
    const d = doc(list(ticked(para(text("swept the gutters"))), item(para(text("call the roofer")))));
    expect(targetIn(d, "swept the gutters")).toEqual({ kind: "checked" });
    // …and its unticked neighbour is unaffected.
    expect(targetIn(d, "call the roofer")).toMatchObject({ kind: "ok" });
  });

  it("answers `checked` LAST, so a refusal is never two refusals in a row", () => {
    // Unticking fixes neither of these, so naming the tick first would
    // send the member back for a second, different refusal.
    expect(targetIn(doc(list(ticked(para(text("   "))))), "   ")).toEqual({ kind: "empty" });
    const long = "x".repeat(MAX + 1);
    expect(targetIn(doc(list(ticked(para(text(long))))), long)).toEqual({ kind: "tooLong" });
    expect(targetIn(doc(list(ticked(para(text("a")), para(text("b"))))), "a")).toEqual({ kind: "complex" });
  });

  it("converts the INNERMOST item, so a caret in a nested one is not the parent's", () => {
    const d = doc(list(item(para(text("outer")), list(item(para(text("inner")))))));
    expect(targetIn(d, "inner")).toMatchObject({ kind: "ok", title: "inner" });
  });

  it("refuses an item with no words, and one longer than a title may be", () => {
    expect(targetIn(doc(list(item(para(text("   "))))), "   ")).toEqual({ kind: "empty" });

    const long = "x".repeat(MAX + 1);
    expect(targetIn(doc(list(item(para(text(long))))), long)).toEqual({ kind: "tooLong" });

    const exact = "x".repeat(MAX);
    expect(targetIn(doc(list(item(para(text(exact))))), exact)).toMatchObject({ kind: "ok" });
  });

  it("keeps the words of a marked item — a title is text, and the marks are simply not carried", () => {
    const d = doc(
      list(item(para({ type: "text", text: "call ", marks: [{ type: "bold" }] }, text("the roofer")))),
    );
    expect(targetIn(d, "the roofer")).toMatchObject({ kind: "ok", title: "call the roofer" });
  });
});

describe("nodePosition", () => {
  it("finds the node again after the document around it has moved", () => {
    const d = doc(para(text("before")), list(item(para(text("target")))), para(text("after")));
    const target = targetIn(d, "target");
    if (target.kind !== "ok") throw new Error("unreachable");

    // The paragraph ABOVE it grows — every position after it shifts.
    const grown = PMNode.fromJSON(schema, {
      type: "doc",
      content: [
        para(text("before, at some length now")),
        list(item(para(text("target")))),
        para(text("after")),
      ],
    } as never);
    // A fresh parse is a different object, identical or not: identity is
    // the question, and the answer here is honestly "gone".
    expect(nodePosition(grown, target.node)).toBe(-1);

    // The live case: the same node object inside a new document.
    const moved = d.copy(d.content.replaceChild(0, schema.node("paragraph", null, schema.text("much longer now"))));
    const at = nodePosition(moved, target.node);
    expect(at).toBeGreaterThan(-1);
    expect(moved.nodeAt(at)).toBe(target.node);
    expect(at).not.toBe(target.from);
  });

  it("takes the FIRST of two occurrences of one node object — a copy-drag can make two", () => {
    const d = doc(list(item(para(text("target")))), para(text("tail")));
    const target = targetIn(d, "target");
    if (target.kind !== "ok") throw new Error("unreachable");

    // What an internal copy-drag leaves behind: the same object in two
    // places. The two are the same node, so the first is as good an
    // answer as the second — what matters is that there IS one.
    const twice = d.copy(d.content.append(Fragment.from(schema.node("taskList", null, [target.node]))));
    const at = nodePosition(twice, target.node);
    expect(at).toBe(target.from);
    expect(twice.nodeAt(at)).toBe(target.node);
  });

  it("is -1 for a node the document no longer holds", () => {
    const d = doc(list(item(para(text("gone")))));
    const target = targetIn(d, "gone");
    if (target.kind !== "ok") throw new Error("unreachable");
    expect(nodePosition(doc(para(text("something else"))), target.node)).toBe(-1);
  });
});
