import { describe, expect, it } from "vitest";

import {
  hasEnabledAction,
  rowActionFormData,
  rowActionIssues,
  rowActionNeedsConfirm,
  rowActionVariant,
  type RowActionSpec,
} from "./row-actions";

const noop = () => {};

describe("row action menu construction", () => {
  it("danger is menu-item text, never a button fill", () => {
    expect(rowActionVariant({ tone: "danger" })).toBe("destructive");
    expect(rowActionVariant({ tone: "default" })).toBe("default");
    expect(rowActionVariant({})).toBe("default");
  });

  it("a danger item asks before it acts", () => {
    expect(rowActionNeedsConfirm({ tone: "danger", confirm: "Delete file.pdf?" })).toBe(true);
    expect(rowActionNeedsConfirm({ tone: "default", confirm: "Sure?" })).toBe(false);
    // a disabled item never gets as far as the question
    expect(rowActionNeedsConfirm({ tone: "danger", confirm: "Delete?", disabled: true })).toBe(false);
  });

  it("builds the FormData a server-action item posts", () => {
    const fd = rowActionFormData([
      { name: "documentId", value: "doc_1" },
      { name: "returnTo", value: "/files" },
    ]);
    expect(fd.get("documentId")).toBe("doc_1");
    expect(fd.get("returnTo")).toBe("/files");
    expect([...fd.keys()]).toEqual(["documentId", "returnTo"]);
  });

  it("an item with no hidden inputs still posts an empty body", () => {
    expect([...rowActionFormData(undefined).keys()]).toEqual([]);
  });

  it("knows when a menu is worth rendering", () => {
    expect(hasEnabledAction([{ disabled: true }, { disabled: true }])).toBe(false);
    expect(hasEnabledAction([{ disabled: true }, {}])).toBe(true);
    expect(hasEnabledAction([])).toBe(false);
  });
});

describe("rowActionIssues", () => {
  const ok: RowActionSpec[] = [
    { key: "suspend", label: "Suspend", onSelect: noop },
    { key: "remove", label: "Remove", tone: "danger", confirm: "Remove Astrid?", onSelect: noop },
    { key: "self", label: "Suspend", disabled: true, disabledReason: "That is you" },
  ];

  it("passes a well-formed menu", () => {
    expect(rowActionIssues(ok)).toEqual([]);
  });

  it("catches a duplicate key collapsing two actions into one", () => {
    expect(rowActionIssues([...ok, { key: "suspend", label: "Suspend again", onSelect: noop }])).toEqual([
      "duplicate key: suspend",
    ]);
  });

  it("catches a destructive action with no question", () => {
    const bad = [{ key: "delete", label: "Delete", tone: "danger", onSelect: noop }] as unknown as RowActionSpec[];
    expect(rowActionIssues(bad)).toEqual(["delete: danger without a confirm question"]);
  });

  it("catches a disabled item that never says why", () => {
    expect(rowActionIssues([{ key: "x", label: "X", disabled: true }])).toEqual([
      "x: disabled without a reason",
    ]);
  });

  it("catches an item wired to nothing", () => {
    expect(rowActionIssues([{ key: "x", label: "X" }])).toEqual(["x: neither onSelect nor formAction"]);
  });

  it("accepts a server-action item", () => {
    expect(
      rowActionIssues([
        {
          key: "delete",
          label: "Delete",
          tone: "danger",
          confirm: "Delete report.pdf?",
          formAction: async () => {},
          hidden: [{ name: "documentId", value: "doc_1" }],
        },
      ]),
    ).toEqual([]);
  });
});
